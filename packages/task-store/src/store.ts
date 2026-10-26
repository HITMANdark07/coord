import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { DaemonEvent, PermissionRequestView, Repo, Task, TaskStatus } from "@coord/protocol";
import { MIGRATIONS } from "./migrations";

export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}

export type NewRepo = Omit<Repo, "id" | "createdAt" | "bypassAllowed">;
export type TaskRecord = Task & {
  portBase: number | null;
  pendingMessage: string | null;
  discardedAt: string | null;
  /** The branch tip when the task was discarded; null before the discard (or for older tasks). */
  discardedTip: string | null;
  /** Env files copied into the worktree (relative paths); commits never include them. */
  envFiles: string[];
};
export type NewTask = Omit<TaskRecord, "id" | "createdAt" | "updatedAt">;
export type PermissionOutcome = "allowed" | "always" | "denied" | "withdrawn";

// Plain strings, not TaskStatus: `closed` arrives with a later plan, and a task in it must
// already free its port block.
const PORT_FREEING_STATUSES = ["cancelled", "cleaned_up", "merged", "closed"];

/** Task field -> column. Every writable TaskRecord field is listed once, so insert and update share it. */
const TASK_COLUMNS = {
  repoId: "repo_id",
  repoPath: "repo_path",
  title: "title",
  prompt: "prompt",
  agent: "agent",
  status: "status",
  branch: "branch",
  baseBranch: "base_branch",
  worktreePath: "worktree_path",
  sessionId: "session_id",
  model: "model",
  permissionMode: "permission_mode",
  costUsd: "cost_usd",
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  turns: "turns",
  error: "error",
  portBase: "port_base",
  pendingMessage: "pending_message",
  discardedAt: "discarded_at",
  discardedTip: "discarded_tip",
  envFiles: "env_files",
  updatedAt: "updated_at",
} as const satisfies Partial<Record<keyof TaskRecord, string>>;

type TaskField = keyof typeof TASK_COLUMNS;
const TASK_FIELDS = Object.keys(TASK_COLUMNS) as TaskField[];

type Row = Record<string, unknown>;

function toRepo(r: Row): Repo {
  return {
    id: r.id as string,
    name: r.name as string,
    path: r.path as string,
    defaultBranch: r.default_branch as string,
    remoteUrl: (r.remote_url as string | null) ?? null,
    bypassAllowed: r.bypass_allowed === 1,
    createdAt: r.created_at as string,
  };
}

function toTask(r: Row): TaskRecord {
  return {
    id: r.id as string,
    repoId: r.repo_id as string,
    repoPath: r.repo_path as string,
    title: r.title as string,
    prompt: r.prompt as string,
    agent: r.agent as string,
    status: r.status as TaskRecord["status"],
    branch: r.branch as string | null,
    baseBranch: r.base_branch as string | null,
    worktreePath: r.worktree_path as string | null,
    sessionId: r.session_id as string | null,
    model: r.model as string | null,
    permissionMode: r.permission_mode as TaskRecord["permissionMode"],
    costUsd: r.cost_usd as number,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    turns: r.turns as number,
    error: r.error as string | null,
    portBase: r.port_base as number | null,
    pendingMessage: r.pending_message as string | null,
    discardedAt: r.discarded_at as string | null,
    discardedTip: r.discarded_tip as string | null,
    envFiles: JSON.parse(r.env_files as string) as string[],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function toPermission(r: Row): PermissionRequestView {
  const view: PermissionRequestView = {
    id: r.id as string,
    taskId: r.task_id as string,
    toolUseId: r.tool_use_id as string,
    tool: r.tool as string,
    input: JSON.parse(r.input as string) as unknown,
    canRemember: r.can_remember === 1,
    createdAt: r.created_at as string,
  };
  if (r.title !== null) view.title = r.title as string;
  return view;
}

function eventTaskId(e: DaemonEvent): string | null {
  const p = e.payload;
  switch (p.kind) {
    case "agent.event":
    case "permission.resolved":
      return p.taskId;
    case "task.updated":
      return p.task.id;
    case "permission.requested":
      return p.request.taskId;
    default:
      return null;
  }
}

/** SQLite makes a bound `undefined` an error; a missing optional field is NULL. Lists are JSON. */
const bind = (v: unknown): unknown =>
  typeof v === "boolean" ? Number(v) : Array.isArray(v) ? JSON.stringify(v) : (v ?? null);

export class Store {
  constructor(private readonly db: Database.Database) {}

  // Repos

  addRepo(r: NewRepo): Repo {
    const repo: Repo = { ...r, id: randomUUID(), bypassAllowed: false, createdAt: new Date().toISOString() };
    try {
      this.db
        .prepare(
          `INSERT INTO repos (id, name, path, default_branch, remote_url, bypass_allowed, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(repo.id, repo.name, repo.path, repo.defaultBranch, repo.remoteUrl, repo.createdAt);
    } catch (err) {
      if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new StoreConflictError(`repo already registered: ${r.path}`);
      }
      throw err;
    }
    return repo;
  }

  getRepo(id: string): Repo | undefined {
    const row = this.db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as Row | undefined;
    return row && toRepo(row);
  }

  findRepoByPath(path: string): Repo | undefined {
    const row = this.db.prepare("SELECT * FROM repos WHERE path = ?").get(path) as Row | undefined;
    return row && toRepo(row);
  }

  listRepos(): Repo[] {
    return (this.db.prepare("SELECT * FROM repos ORDER BY rowid").all() as Row[]).map(toRepo);
  }

  setRepoBypass(id: string, allowed: boolean): Repo {
    this.db.prepare("UPDATE repos SET bypass_allowed = ? WHERE id = ?").run(allowed ? 1 : 0, id);
    const repo = this.getRepo(id);
    if (!repo) throw new Error(`unknown repo: ${id}`);
    return repo;
  }

  // Tasks

  insertTask(t: NewTask): TaskRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    const record: TaskRecord = { ...t, id, createdAt: now, updatedAt: now };
    const cols = TASK_FIELDS.map((f) => TASK_COLUMNS[f]);
    this.db
      .prepare(
        `INSERT INTO tasks (id, created_at, ${cols.join(", ")})
         VALUES (?, ?, ${cols.map(() => "?").join(", ")})`,
      )
      .run(id, now, ...TASK_FIELDS.map((f) => bind(record[f])));
    return record;
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row && toTask(row);
  }

  listTasks(filter: { repoId?: string; statuses?: TaskStatus[] } = {}): TaskRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.repoId !== undefined) {
      where.push("repo_id = ?");
      args.push(filter.repoId);
    }
    if (filter.statuses) {
      where.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      args.push(...filter.statuses);
    }
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid DESC`;
    return (this.db.prepare(sql).all(...args) as Row[]).map(toTask);
  }

  updateTask(id: string, patch: Partial<TaskRecord>): TaskRecord {
    const fields = TASK_FIELDS.filter((f) => f !== "updatedAt" && patch[f] !== undefined);
    const sets = [...fields.map((f) => `${TASK_COLUMNS[f]} = ?`), "updated_at = ?"];
    const result = this.db
      .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
      .run(...fields.map((f) => bind(patch[f])), new Date().toISOString(), id);
    if (result.changes === 0) throw new Error(`unknown task: ${id}`);
    return this.getTask(id) as TaskRecord;
  }

  // Events

  saveEvent(e: DaemonEvent): void {
    this.db
      .prepare("INSERT INTO events (seq, at, task_id, payload) VALUES (?, ?, ?, ?)")
      .run(e.seq, e.at, eventTaskId(e), JSON.stringify(e.payload));
  }

  maxSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS m FROM events").get() as { m: number | null };
    return row.m ?? 0;
  }

  listEvents(opts: { taskId?: string; sinceSeq?: number; limit?: number }): DaemonEvent[] {
    const where: string[] = ["seq > ?"];
    const args: unknown[] = [opts.sinceSeq ?? 0];
    if (opts.taskId !== undefined) {
      where.push("task_id = ?");
      args.push(opts.taskId);
    }
    const limit = opts.limit === undefined ? "" : "LIMIT ?";
    if (opts.limit !== undefined) args.push(opts.limit);
    const rows = this.db
      .prepare(`SELECT seq, at, payload FROM events WHERE ${where.join(" AND ")} ORDER BY seq ${limit}`)
      .all(...args) as { seq: number; at: string; payload: string }[];
    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      payload: JSON.parse(r.payload) as DaemonEvent["payload"],
    }));
  }

  // Permissions

  savePermission(p: PermissionRequestView): void {
    this.db
      .prepare(
        `INSERT INTO permissions (id, task_id, tool_use_id, tool, input, title, can_remember, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.taskId,
        p.toolUseId,
        p.tool,
        JSON.stringify(p.input ?? null),
        p.title ?? null,
        p.canRemember ? 1 : 0,
        p.createdAt,
      );
  }

  /** False when the request is unknown or was already resolved, so a double answer can't win twice. */
  resolvePermission(id: string, outcome: PermissionOutcome): boolean {
    const result = this.db
      .prepare("UPDATE permissions SET outcome = ?, resolved_at = ? WHERE id = ? AND resolved_at IS NULL")
      .run(outcome, new Date().toISOString(), id);
    return result.changes > 0;
  }

  listPendingPermissions(taskId?: string): PermissionRequestView[] {
    const rows =
      taskId === undefined
        ? this.db.prepare("SELECT * FROM permissions WHERE resolved_at IS NULL ORDER BY rowid").all()
        : this.db
            .prepare("SELECT * FROM permissions WHERE resolved_at IS NULL AND task_id = ? ORDER BY rowid")
            .all(taskId);
    return (rows as Row[]).map(toPermission);
  }

  // Ports

  /** Lowest block start that overlaps no live task's block; records it on the task. */
  allocatePortBase(taskId: string, start: number, blockSize: number): number {
    const allocate = this.db.transaction(() => {
      const marks = PORT_FREEING_STATUSES.map(() => "?").join(", ");
      const held = (
        this.db
          .prepare(
            `SELECT port_base FROM tasks
             WHERE port_base IS NOT NULL AND id != ? AND status NOT IN (${marks})`,
          )
          .all(taskId, ...PORT_FREEING_STATUSES) as { port_base: number }[]
      ).map((r) => r.port_base);
      let base = start;
      while (held.some((h) => Math.abs(h - base) < blockSize)) base += blockSize;
      this.db
        .prepare("UPDATE tasks SET port_base = ?, updated_at = ? WHERE id = ?")
        .run(base, new Date().toISOString(), taskId);
      return base;
    });
    return allocate();
  }

  close(): void {
    this.db.close();
  }
}

export function openStore(file: string): Store {
  // The DB holds prompts, transcripts and permission inputs: owner-only (AGENTS.md rule 8).
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  if (file !== ":memory:") {
    // The -wal/-shm files are created lazily and take the process umask, so tighten whichever exist.
    for (const path of [file, `${file}-wal`, `${file}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }
  db.pragma("foreign_keys = ON");
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v] as string);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return new Store(db);
}
