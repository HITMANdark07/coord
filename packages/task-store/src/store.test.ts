import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { DaemonEvent, PermissionRequestView } from "@coord/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "./migrations";
import { openStore, StoreConflictError, type Store, type TaskRecord } from "./index";

type NewTask = Omit<TaskRecord, "id" | "createdAt" | "updatedAt">;

const newRepo = (path = "/work/app") => ({
  name: "app",
  path,
  defaultBranch: "main",
  remoteUrl: null,
});

const newTask = (repoId: string, over: Partial<NewTask> = {}): NewTask => ({
  repoId,
  repoPath: "/work/app",
  title: "Fix bug",
  prompt: "fix it",
  agent: "claude-code",
  status: "queued",
  branch: null,
  baseBranch: null,
  worktreePath: null,
  sessionId: null,
  model: null,
  permissionMode: "ask",
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
  error: null,
  portBase: null,
  pendingMessage: null,
  discardedAt: null,
  discardedTip: null,
  envFiles: [],
  ...over,
});

const agentEvent = (seq: number, taskId: string): DaemonEvent => ({
  seq,
  at: "2026-10-26T00:00:00.000Z",
  payload: { kind: "agent.event", taskId, event: { type: "text", text: `t${seq}` } },
});

const perm = (id: string, taskId: string): PermissionRequestView => ({
  id,
  taskId,
  toolUseId: "tu1",
  tool: "Bash",
  input: { command: "ls" },
  title: "Run ls",
  canRemember: true,
  createdAt: "2026-10-26T00:00:00.000Z",
});

describe("task store", () => {
  let dir: string;
  let file: string;
  let store: Store;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "coord-store-"));
    file = join(dir, "nested", "coord.db");
    store = openStore(file);
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("creates the directory 0700 and the db files 0600", async () => {
    const fresh = join(dir, "home", "coord.db");
    const opened = openStore(fresh);
    // A write makes SQLite create the -wal/-shm files.
    opened.addRepo(newRepo("/work/other"));
    const mode = async (p: string) => (await stat(p)).mode & 0o777;
    try {
      expect(await mode(join(dir, "home"))).toBe(0o700);
      expect(await mode(fresh)).toBe(0o600);
      expect(await mode(`${fresh}-wal`)).toBe(0o600);
      expect(await mode(`${fresh}-shm`)).toBe(0o600);
    } finally {
      opened.close();
    }
  });

  it("persists across reopen", () => {
    const repo = store.addRepo(newRepo());
    const task = store.insertTask(newTask(repo.id));
    store.close();
    store = openStore(file);
    expect(store.getRepo(repo.id)).toEqual(repo);
    expect(store.getTask(task.id)).toEqual(task);
    expect(store.findRepoByPath("/work/app")?.id).toBe(repo.id);
    expect(store.listRepos()).toHaveLength(1);
  });

  it("migrations are versioned", () => {
    store.close();
    const version = () => {
      const db = new Database(file);
      const v = db.pragma("user_version", { simple: true });
      db.close();
      return v;
    };
    const before = version();
    expect(before).toBeGreaterThan(0);
    store = openStore(file);
    store.close();
    expect(version()).toBe(before);
    store = openStore(file);
  });

  it("upgrades a coord.db made by the first schema, keeping its tasks", () => {
    const old = join(dir, "old.db");
    const db = new Database(old);
    db.exec(MIGRATIONS[0] as string);
    db.pragma("user_version = 1");
    db.prepare(
      `INSERT INTO tasks (id, repo_id, repo_path, title, prompt, agent, status, permission_mode,
         discarded_at, created_at, updated_at)
       VALUES ('t-old', 'r1', '/work/app', 'Old', 'p', 'claude-code', 'cancelled', 'ask',
         '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    ).run();
    db.close();

    const upgraded = openStore(old);
    try {
      expect(upgraded.getTask("t-old")).toMatchObject({
        title: "Old",
        status: "cancelled",
        discardedAt: "2026-10-01T00:00:00.000Z",
        discardedTip: null,
        envFiles: [],
      });
      const t = upgraded.updateTask("t-old", { discardedTip: "abc123", envFiles: [".env", "app/.env"] });
      expect(t).toMatchObject({ discardedTip: "abc123", envFiles: [".env", "app/.env"] });
    } finally {
      upgraded.close();
    }
    const check = new Database(old);
    expect(check.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    check.close();
  });

  it("rejects a repo path registered twice", () => {
    store.addRepo(newRepo());
    expect(() => store.addRepo(newRepo())).toThrow(StoreConflictError);
  });

  it("sets repo bypass", () => {
    const repo = store.addRepo(newRepo());
    expect(repo.bypassAllowed).toBe(false);
    expect(store.setRepoBypass(repo.id, true).bypassAllowed).toBe(true);
  });

  it("updateTask bumps updatedAt and keeps other fields", async () => {
    const repo = store.addRepo(newRepo());
    const task = store.insertTask(newTask(repo.id, { title: "keep me", portBase: 41000 }));
    await new Promise((r) => setTimeout(r, 5));
    const next = store.updateTask(task.id, { status: "running", costUsd: 0.5 });
    expect(next.status).toBe("running");
    expect(next.costUsd).toBe(0.5);
    expect(next.title).toBe("keep me");
    expect(next.portBase).toBe(41000);
    expect(next.createdAt).toBe(task.createdAt);
    expect(next.updatedAt > task.updatedAt).toBe(true);
  });

  it("lists tasks newest first with filters", () => {
    const repo = store.addRepo(newRepo());
    const a = store.insertTask(newTask(repo.id, { title: "a" }));
    const b = store.insertTask(newTask(repo.id, { title: "b", status: "running" }));
    expect(store.listTasks().map((t) => t.id)).toEqual([b.id, a.id]);
    expect(store.listTasks({ statuses: ["running"] }).map((t) => t.id)).toEqual([b.id]);
    expect(store.listTasks({ repoId: "nope" })).toEqual([]);
  });

  it("events filter by task and seq", () => {
    store.saveEvent(agentEvent(1, "a"));
    store.saveEvent(agentEvent(2, "b"));
    store.saveEvent(agentEvent(3, "a"));
    expect(store.maxSeq()).toBe(3);
    expect(store.listEvents({ taskId: "a", sinceSeq: 1 }).map((e) => e.seq)).toEqual([3]);
    expect(store.listEvents({}).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(store.listEvents({ limit: 2 }).map((e) => e.seq)).toEqual([1, 2]);
    expect(store.listEvents({ taskId: "a" })[0]).toEqual(agentEvent(1, "a"));
  });

  it("maxSeq is 0 on an empty log", () => {
    expect(store.maxSeq()).toBe(0);
  });

  it("indexes the task id of task.updated and permission.requested events", () => {
    const repo = store.addRepo(newRepo());
    const task = store.insertTask(newTask(repo.id));
    store.saveEvent({
      seq: 1,
      at: "x",
      payload: { kind: "task.updated", task },
    });
    store.saveEvent({
      seq: 2,
      at: "x",
      payload: { kind: "permission.requested", request: perm("p1", task.id) },
    });
    store.saveEvent({
      seq: 3,
      at: "x",
      payload: { kind: "repo.updated", repo },
    });
    expect(store.listEvents({ taskId: task.id }).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("pending permissions resolve once", () => {
    store.savePermission(perm("p1", "a"));
    store.savePermission(perm("p2", "b"));
    expect(store.listPendingPermissions().map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(store.listPendingPermissions("a").map((p) => p.id)).toEqual(["p1"]);
    expect(store.listPendingPermissions("a")[0]).toEqual(perm("p1", "a"));
    expect(store.resolvePermission("p1", "allowed")).toBe(true);
    expect(store.resolvePermission("p1", "denied")).toBe(false);
    expect(store.listPendingPermissions("a")).toEqual([]);
  });

  it("port blocks don't overlap live tasks and are reused after cancel", () => {
    const repo = store.addRepo(newRepo());
    const t1 = store.insertTask(newTask(repo.id));
    const t2 = store.insertTask(newTask(repo.id));
    expect(store.allocatePortBase(t1.id, 41000, 10)).toBe(41000);
    expect(store.allocatePortBase(t2.id, 41000, 10)).toBe(41010);
    expect(store.getTask(t1.id)?.portBase).toBe(41000);
    store.updateTask(t1.id, { status: "cancelled" });
    const t3 = store.insertTask(newTask(repo.id));
    expect(store.allocatePortBase(t3.id, 41000, 10)).toBe(41000);
  });
});
