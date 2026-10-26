import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  CreateTaskInput,
  type AgentAdapter,
  type AgentId,
  type AgentRun,
  type DaemonEventPayload,
  type RunContext,
  type Task,
  type TaskSpec,
  type TaskStatus,
} from "@coord/protocol";
import type { Store, TaskRecord } from "@coord/task-store";
import {
  commitTurn,
  copyEnvFiles,
  createWorktree,
  detectSetupCommands,
  readRepoConfig,
  resolveBaseRef,
  runCommands,
  slugify,
  uniqueBranch,
} from "@coord/worktree-manager";
import type { EventBus } from "../event-bus";
import type { PermissionBroker } from "../permission-broker";
import { RunnerError } from "./errors";

export interface TaskRunnerDeps {
  store: Store;
  bus: EventBus;
  broker: PermissionBroker;
  adapters: Partial<Record<AgentId, AgentAdapter>>;
  /** COORD_HOME; worktrees live under `<home>/worktrees`. */
  home: string;
  /** Tasks allowed to hold an agent slot at once (spec §5); see `holdsSlot`. */
  maxConcurrent: number;
  /**
   * Extra env for commits. Production passes nothing so the user's own identity and signing
   * apply (spec §6); tests pass a fixed identity because CI machines have none.
   */
  gitEnv?: Record<string, string>;
}

/** Statuses in which a task may hold an agent slot (spec §5 concurrency); see `holdsSlot`. */
const ACTIVE_STATUSES: TaskStatus[] = ["setting_up", "running", "needs_input"];

/**
 * Every allowed status change. `transition()` refuses anything else with `conflict`, so a
 * stale turn end can't overwrite a task the user already moved on. A same-status transition
 * (a patch with a new error, say) is always allowed. Extend this table, not the call sites.
 */
const NEXT: Partial<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["setting_up", "failed"],
  setting_up: ["running", "failed"],
  running: ["needs_input", "review", "failed"],
  needs_input: ["running", "review", "failed"],
};

const CO_AUTHOR: Partial<Record<AgentId, string>> = {
  "claude-code": "Co-Authored-By: Claude Code <noreply@anthropic.com>",
  codex: "Co-Authored-By: Codex <noreply@openai.com>",
};

const TITLE_MAX = 60;
const BRANCH_PREFIX = "agent/";

interface Live {
  abort: AbortController;
  run?: AgentRun;
}

/** The task as clients see it: daemon-only bookkeeping stays out of `task.updated`. */
function toTask(record: TaskRecord): Task {
  const { portBase: _portBase, pendingMessage: _pendingMessage, discardedAt: _discardedAt, ...task } = record;
  return task;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function titleFrom(prompt: string): string {
  const line = prompt.split("\n").find((l) => l.trim().length > 0) ?? prompt;
  return line.trim().slice(0, TITLE_MAX);
}

/** `git check-ref-format --branch`, without a shell: the name comes from a client. */
function isValidBranchName(name: string, cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["check-ref-format", "--branch", name], { cwd }, (err) => resolve(!err));
  });
}

/**
 * Runs tasks through spec §5's lifecycle: queued → setting_up → running ⇄ needs_input → review
 * (or failed). Each task gets its own worktree and `agent/` branch; every turn end is committed
 * there, so no work lives only as uncommitted files (spec §6).
 */
export class TaskRunner {
  private readonly live = new Map<string, Live>();
  /** In-flight setup/run work, for `idle()`. */
  private readonly work = new Set<Promise<void>>();
  /** Serializes git operations on each user repo (fetch, branch naming, worktree add). */
  private readonly repoLocks = new Map<string, Promise<void>>();

  constructor(private readonly deps: TaskRunnerDeps) {}

  async create(raw: CreateTaskInput): Promise<TaskRecord> {
    const parsed = CreateTaskInput.safeParse(raw);
    if (!parsed.success) throw new RunnerError("invalid_request", parsed.error.message);
    const input = parsed.data;
    const { store } = this.deps;

    const repo =
      input.repoId !== undefined ? store.getRepo(input.repoId) : store.findRepoByPath(input.repoPath ?? "");
    if (!repo) {
      throw new RunnerError(
        "not_found",
        `repo not registered: ${input.repoId ?? input.repoPath}. Register it with \`coord repo add <path>\`.`,
      );
    }
    if (!this.deps.adapters[input.agent]) {
      throw new RunnerError("invalid_request", `agent "${input.agent}" is not available`);
    }
    if (input.permissionMode === "bypass" && !repo.bypassAllowed) {
      throw new RunnerError("forbidden", "bypass permission mode is not enabled for this repo");
    }
    if (input.branch !== undefined) {
      if (!input.branch.startsWith(BRANCH_PREFIX) || !(await isValidBranchName(input.branch, repo.path))) {
        throw new RunnerError("invalid_request", `invalid branch name: ${input.branch}`);
      }
      if ((await uniqueBranch(repo.path, input.branch)) !== input.branch) {
        throw new RunnerError("conflict", `branch already exists: ${input.branch}`);
      }
    }

    const task = store.insertTask({
      repoId: repo.id,
      repoPath: repo.path,
      title: input.title?.trim() || titleFrom(input.prompt),
      prompt: input.prompt,
      agent: input.agent,
      status: "queued",
      branch: input.branch ?? null,
      baseBranch: input.baseBranch ?? null,
      worktreePath: null,
      sessionId: null,
      model: input.model ?? null,
      permissionMode: input.permissionMode,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      turns: 0,
      error: null,
      portBase: null,
      pendingMessage: null,
      discardedAt: null,
    });
    this.publish({ kind: "task.updated", task: toTask(task) });
    this.schedule();
    return store.getTask(task.id) ?? task;
  }

  /** Called by the PermissionBroker whenever a task's pending prompts change. */
  onPendingChange(taskId: string, pending: number): void {
    const task = this.deps.store.getTask(taskId);
    if (!task) return;
    if (pending > 0 && task.status === "running") this.transition(taskId, "needs_input");
    // Only a live agent waits on a prompt; a needs_input without one (commit failure) stays.
    else if (pending === 0 && task.status === "needs_input" && this.live.get(taskId)?.run) {
      this.transition(taskId, "running");
    }
  }

  /** Resolves once no setup or agent turn is in flight (a task waiting on a prompt counts as in flight). */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
  }

  // Lifecycle

  /** Starts queued tasks, oldest first, while slots are free. */
  private schedule(): void {
    const { store, maxConcurrent } = this.deps;
    let free =
      maxConcurrent - store.listTasks({ statuses: ACTIVE_STATUSES }).filter((t) => this.holdsSlot(t)).length;
    for (const task of store.listTasks({ statuses: ["queued"] }).reverse()) {
      if (free-- <= 0) break;
      // start() moves the task to setting_up synchronously, before its first await.
      this.track(task.id, () => this.start(task));
    }
  }

  /**
   * Only working tasks count toward the cap (spec §5). A needs_input task counts while its agent
   * waits on a prompt, but not once it is parked (a failed commit) with no agent running.
   */
  private holdsSlot(task: TaskRecord): boolean {
    return task.status !== "needs_input" || this.live.has(task.id);
  }

  private async start(task: TaskRecord): Promise<void> {
    const live: Live = { abort: new AbortController() };
    this.live.set(task.id, live);
    try {
      this.transition(task.id, "setting_up", { error: null });
      const ready = await this.setup(task, live.abort.signal);
      if (ready) await this.launch(ready, live);
    } finally {
      if (this.live.get(task.id) === live) {
        live.run?.end();
        this.live.delete(task.id);
      }
    }
  }

  /** Worktree, env files, ports and setup commands. Returns null (task failed) on any failure. */
  private async setup(task: TaskRecord, signal: AbortSignal): Promise<TaskRecord | null> {
    const { store, home } = this.deps;
    const repo = store.getRepo(task.repoId);
    if (!repo) return this.fail(task.id, "setup: repo is no longer registered");
    try {
      const { config, baseBranch, branch, worktreePath } = await this.withRepoLock(repo.id, async () => {
        let baseBranch = task.baseBranch ?? repo.defaultBranch;
        let { ref } = await resolveBaseRef(repo.path, baseBranch);
        // setup/checks come from the base ref, never the task branch (spec §7).
        let config = await readRepoConfig(repo.path, ref);
        // Without an explicit base, the config's baseBranch picks it (spec §7). Its setup and
        // checks are then read again from that base, the one the task actually starts from.
        if (task.baseBranch === null && config.baseBranch && config.baseBranch !== baseBranch) {
          baseBranch = config.baseBranch;
          ({ ref } = await resolveBaseRef(repo.path, baseBranch));
          config = await readRepoConfig(repo.path, ref);
        }
        const branch = task.branch ?? (await uniqueBranch(repo.path, BRANCH_PREFIX + slugify(task.title)));
        const dir = branch.slice(BRANCH_PREFIX.length).replaceAll("/", "-");
        const worktreePath = join(home, "worktrees", `${repo.name}-${repo.id}`, dir);
        await createWorktree({ repoPath: repo.path, worktreePath, branch, baseRef: ref });
        return { config, baseBranch, branch, worktreePath };
      });
      // Recorded right away so a later failure or restart still knows where the work is.
      store.updateTask(task.id, { branch, baseBranch, worktreePath });
      await copyEnvFiles(repo.path, worktreePath, config.envFiles);
      const portBase = store.allocatePortBase(task.id, config.ports.start, config.ports.blockSize);
      const commands = config.setup ?? (await detectSetupCommands(worktreePath));
      const result = await runCommands(commands, {
        cwd: worktreePath,
        env: this.taskEnv(task.id, portBase),
        signal,
      });
      if (!result.ok) {
        this.publish({
          kind: "agent.event",
          taskId: task.id,
          event: { type: "text", text: `$ ${result.command}\n${result.output}` },
        });
        return this.fail(task.id, `setup: ${result.command} exited ${result.exitCode}`);
      }
      return store.getTask(task.id) ?? null;
    } catch (e) {
      return this.fail(task.id, `setup: ${message(e)}`);
    }
  }

  private async launch(task: TaskRecord, live: Live): Promise<void> {
    const adapter = this.deps.adapters[task.agent as AgentId];
    if (!adapter) return void this.fail(task.id, `agent "${task.agent}" is not available`);
    const ctx: RunContext = {
      cwd: task.worktreePath as string,
      signal: live.abort.signal,
      requestPermission: (req, signal) => this.deps.broker.request(task.id, req, signal),
    };
    const spec: TaskSpec = {
      taskId: task.id,
      prompt: task.prompt,
      permissionMode: task.permissionMode,
      env: this.taskEnv(task.id, task.portBase ?? 0),
      ...(task.model ? { model: task.model } : {}),
    };
    this.transition(task.id, "running");
    live.run = adapter.start(spec, ctx);
    await this.drive(task.id, live.run);
  }

  /** Consumes one turn's events. `events` never throws (AGENTS.md rule 7). */
  private async drive(taskId: string, run: AgentRun): Promise<void> {
    const { store } = this.deps;
    for await (const event of run.events) {
      this.publish({ kind: "agent.event", taskId, event });
      switch (event.type) {
        case "session":
          store.updateTask(taskId, { sessionId: event.sessionId });
          break;
        case "usage":
          // Running totals for the session, so they replace rather than add up.
          store.updateTask(taskId, {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
          });
          break;
        case "done":
          return this.endTurn(taskId, run);
        case "error":
          return this.endTurn(taskId, run, event.message);
      }
    }
    await this.endTurn(taskId, run, "agent stopped without finishing the turn");
  }

  /**
   * A turn is over: commit whatever the agent left (also after an error, to keep the work),
   * end the agent session, then review, failed, or needs_input when the commit failed. A failed
   * commit leaves the worktree exactly as it is (spec §6).
   */
  private async endTurn(taskId: string, run: AgentRun, failure?: string): Promise<void> {
    const task = this.deps.store.getTask(taskId);
    if (!task) return;
    const turns = task.turns + 1;
    let commitError: string | undefined;
    try {
      await commitTurn({
        cwd: task.worktreePath as string,
        branch: task.branch as string,
        message: `${task.title} (turn ${turns})`,
        trailers: this.trailers(task),
        env: this.deps.gitEnv,
      });
    } catch (e) {
      const stderr = (e as { stderr?: unknown }).stderr;
      commitError = (typeof stderr === "string" && stderr.trim()) || message(e);
    } finally {
      run.end();
    }
    if (this.live.get(taskId)?.run === run) this.live.delete(taskId);
    // Nothing is waiting on a prompt any more; clients drop it.
    this.deps.broker.withdrawAll(taskId);

    if (commitError !== undefined) {
      const after = failure ? ` (after agent error: ${failure})` : "";
      this.transition(taskId, "needs_input", { turns, error: `commit failed: ${commitError}${after}` });
    } else if (failure !== undefined) {
      this.transition(taskId, "failed", { turns, error: failure });
    } else {
      this.transition(taskId, "review", { turns, error: null });
    }
  }

  // Helpers

  /** The one place a task's status changes: stores it and tells every client. */
  private transition(taskId: string, status: TaskStatus, patch: Partial<TaskRecord> = {}): TaskRecord {
    const current = this.deps.store.getTask(taskId);
    if (!current) throw new RunnerError("not_found", `unknown task: ${taskId}`);
    const from = current.status;
    if (from !== status && !NEXT[from as TaskStatus]?.includes(status)) {
      throw new RunnerError("conflict", `task is ${from}; it can't move to ${status}`);
    }
    const task = this.deps.store.updateTask(taskId, { ...patch, status });
    this.publish({ kind: "task.updated", task: toTask(task) });
    return task;
  }

  private fail(taskId: string, error: string): null {
    this.transition(taskId, "failed", { error });
    return null;
  }

  private publish(payload: DaemonEventPayload): void {
    this.deps.bus.publish(payload);
  }

  private taskEnv(taskId: string, portBase: number): Record<string, string> {
    // PRD FR-14: the agent and its setup see the task's port block.
    return { COORD_PORT_BASE: String(portBase), COORD_TASK_ID: taskId };
  }

  private trailers(task: TaskRecord): string[] {
    const coAuthor = CO_AUTHOR[task.agent as AgentId];
    return [`Coord-Task: ${task.id}`, ...(coAuthor ? [coAuthor] : [])];
  }

  /** Runs `fn` as tracked work; an unexpected throw fails the task instead of vanishing. */
  private track(taskId: string, fn: () => Promise<void>): void {
    const p: Promise<void> = (async () => {
      try {
        await fn();
      } catch (e) {
        try {
          this.fail(taskId, `internal: ${message(e)}`);
        } catch {
          // The task already left an active status; there is nothing left to mark.
        }
      }
    })().finally(() => {
      this.work.delete(p);
      this.schedule();
    });
    this.work.add(p);
  }

  private async withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.repoLocks.get(repoId) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.repoLocks.set(repoId, tail);
    try {
      return await result;
    } finally {
      if (this.repoLocks.get(repoId) === tail) this.repoLocks.delete(repoId);
    }
  }
}
