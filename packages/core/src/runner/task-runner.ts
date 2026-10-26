import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  CreateTaskInput,
  type AgentAdapter,
  type AgentId,
  type AgentRun,
  type DaemonEventPayload,
  type RunContext,
  type RunOptions,
  type Task,
  type TaskSpec,
  type TaskStatus,
} from "@coord/protocol";
import type { Store, TaskRecord } from "@coord/task-store";
import {
  commitTurn,
  copyEnvFiles,
  createWorktree,
  deleteBranch,
  detectSetupCommands,
  readRepoConfig,
  removeWorktree,
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
  // running: a follow-up whose worktree is already set up; cancelled: cancel before or after setup.
  queued: ["setting_up", "running", "failed", "cancelled"],
  // interrupted: the daemon restarted mid-step (spec §6); cancelled: the user cancelled it.
  setting_up: ["running", "failed", "interrupted", "cancelled"],
  running: ["needs_input", "review", "failed", "interrupted", "cancelled"],
  // queued: a follow-up to a task parked by a failed commit.
  needs_input: ["running", "review", "failed", "queued", "interrupted", "cancelled"],
  // queued: a follow-up (message or resume); cancelled: discard.
  review: ["queued", "cancelled"],
  failed: ["queued", "cancelled"],
  interrupted: ["queued", "cancelled"],
  // The discarded branch is deleted after 14 days (spec §6).
  cancelled: ["cleaned_up"],
};

/** Statuses with no agent at work: the task takes a follow-up or a discard. See `isResting`. */
const RESTING_STATUSES: TaskStatus[] = ["review", "failed", "interrupted", "needs_input"];
const CANCELLABLE_STATUSES: TaskStatus[] = ["queued", ...ACTIVE_STATUSES, ...RESTING_STATUSES];
const RESUME_TEXT = "Continue where you left off.";
/** Spec §6: a discarded task's local branch is kept this long. */
const DISCARDED_BRANCH_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const CO_AUTHOR: Partial<Record<AgentId, string>> = {
  "claude-code": "Co-Authored-By: Claude Code <noreply@anthropic.com>",
  codex: "Co-Authored-By: Codex <noreply@openai.com>",
};

const TITLE_MAX = 60;
const BRANCH_PREFIX = "agent/";

interface Live {
  abort: AbortController;
  run?: AgentRun;
  /** The turn's events are over and endTurn is committing: a message now waits for the turn end. */
  ending?: boolean;
  /** Resolves once start() is done with the task: the turn ended (or setup stopped) and live is gone. */
  finished: Promise<void>;
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

function localBranchExists(repoPath: string, branch: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath }, (err) =>
      resolve(!err),
    );
  });
}

/** Git's own message when it has one: it says what to fix (identity, signing, a locked worktree). */
function gitMessage(e: unknown): string {
  const stderr = (e as { stderr?: unknown }).stderr;
  return (typeof stderr === "string" && stderr.trim()) || message(e);
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
  /** Serializes git operations on each user repo (fetch, branch naming, worktree add/remove). */
  private readonly repoLocks = new Map<string, Promise<void>>();
  /**
   * Cancels and discards in flight. While a task is here its cancel owns the final status: the
   * turn end or setup failure the cancel causes records nothing, and nothing starts the task.
   */
  private readonly closing = new Map<string, Promise<TaskRecord>>();

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
    // A cancel withdraws the prompts; the task goes to cancelled, not back to running.
    if (!task || this.closing.has(taskId)) return;
    if (pending > 0 && task.status === "running") this.transition(taskId, "needs_input");
    // Only a live agent waits on a prompt; a needs_input without one (commit failure) stays.
    else if (pending === 0 && task.status === "needs_input" && this.live.get(taskId)?.run) {
      this.transition(taskId, "running");
    }
  }

  /**
   * A message from the user. A working agent gets it live; a task at rest resumes its session
   * with it, through the queue so the concurrency cap applies (spec §5).
   */
  async message(taskId: string, text: string): Promise<TaskRecord> {
    if (text.trim().length === 0) throw new RunnerError("invalid_request", "message text is empty");
    const task = this.getOpen(taskId);
    const live = this.live.get(taskId);
    if ((task.status === "running" || task.status === "needs_input") && live?.run) {
      const adapter = this.deps.adapters[task.agent as AgentId];
      if (!adapter?.capabilities.liveMessages) {
        throw new RunnerError(
          "conflict",
          `${task.agent} can't take messages during a turn; interrupt the task first, then send the message`,
        );
      }
      // The turn is ending: the session no longer reads messages, so this one becomes a follow-up.
      if (live.ending || !live.run.send(text)) {
        await live.finished;
        return this.message(taskId, text);
      }
      return task;
    }
    if (this.isResting(task)) return this.followUp(task, text);
    throw new RunnerError("conflict", `task is ${task.status}; it can't take a message now`);
  }

  /** Stops the current turn. The adapter reports it as `done`, so the turn ends as review (spec §5). */
  async interrupt(taskId: string): Promise<TaskRecord> {
    const task = this.getOpen(taskId);
    const run = this.live.get(taskId)?.run;
    if (!run || (task.status !== "running" && task.status !== "needs_input")) {
      throw new RunnerError("conflict", `task is ${task.status}; there is no turn to interrupt`);
    }
    const stopping = run.interrupt();
    // An agent waiting on a prompt gets no answer now; clients drop the prompt.
    this.deps.broker.withdrawAll(taskId);
    await stopping;
    return this.deps.store.getTask(taskId) ?? task;
  }

  /** Continues an interrupted or failed task in its stored session (spec §5, §6 restarts). */
  async resume(taskId: string): Promise<TaskRecord> {
    const task = this.getOpen(taskId);
    if (task.status !== "interrupted" && task.status !== "failed") {
      throw new RunnerError("conflict", `task is ${task.status}; only interrupted or failed tasks resume`);
    }
    return this.followUp(task, RESUME_TEXT);
  }

  /** Stops the task wherever it is and discards it; the work stays on its branch (spec §5, §6). */
  async cancel(taskId: string): Promise<TaskRecord> {
    const inFlight = this.closing.get(taskId);
    if (inFlight) return inFlight;
    const task = this.get(taskId);
    if (!CANCELLABLE_STATUSES.includes(task.status as TaskStatus)) {
      throw new RunnerError("conflict", `task is ${task.status}; it can't be cancelled`);
    }
    // Never set up: no worktree, no work, nothing to keep.
    if (task.status === "queued" && task.worktreePath === null) {
      return this.transition(taskId, "cancelled", { pendingMessage: null });
    }
    return this.close(taskId, async () => {
      await this.stop(taskId);
      return this.discardWork(taskId);
    });
  }

  /**
   * Commits any leftover work, removes the worktree and keeps the branch for 14 days (spec §6).
   * If the commit or the removal fails the task stays as it was, with the error: nothing is lost.
   */
  async discard(taskId: string): Promise<TaskRecord> {
    const inFlight = this.closing.get(taskId);
    if (inFlight) return inFlight;
    const task = this.get(taskId);
    if (!this.isResting(task)) {
      throw new RunnerError("conflict", `task is ${task.status}; only a task at rest can be discarded`);
    }
    return this.close(taskId, () => this.discardWork(taskId));
  }

  /**
   * After a daemon restart no agent is running: working tasks become interrupted, keeping their
   * worktree as it is (spec §6), and their prompts are withdrawn. Returns the number interrupted.
   */
  async recoverOnStart(): Promise<number> {
    const { store } = this.deps;
    let count = 0;
    for (const task of store.listTasks({ statuses: ACTIVE_STATUSES })) {
      // Defensive: a task this runner is driving is not stale.
      if (this.live.has(task.id)) continue;
      this.transition(task.id, "interrupted");
      count++;
    }
    // No prompt from before the restart has an agent waiting on it any more.
    for (const p of store.listPendingPermissions()) {
      if (this.live.has(p.taskId) || !store.resolvePermission(p.id, "withdrawn")) continue;
      this.publish({ kind: "permission.resolved", requestId: p.id, taskId: p.taskId, outcome: "withdrawn" });
    }
    this.schedule();
    return count;
  }

  /** Deletes the `agent/` branches of tasks discarded more than 14 days before `now` (spec §6). */
  async sweepDiscardedBranches(now = new Date()): Promise<number> {
    let count = 0;
    for (const task of this.deps.store.listTasks({ statuses: ["cancelled"] })) {
      if (task.discardedAt === null) continue;
      if (now.getTime() - Date.parse(task.discardedAt) <= DISCARDED_BRANCH_TTL_MS) continue;
      if (task.branch?.startsWith(BRANCH_PREFIX)) {
        const branch = task.branch;
        try {
          await this.withRepoLock(task.repoId, () => deleteBranch(task.repoPath, branch));
        } catch {
          // Already gone (deleted by hand) is fine; otherwise keep it and try again next sweep.
          if (await localBranchExists(task.repoPath, branch)) continue;
        }
      }
      this.transition(task.id, "cleaned_up");
      count++;
    }
    return count;
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
      if (this.closing.has(task.id)) continue;
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
    let finish!: () => void;
    const live: Live = { abort: new AbortController(), finished: new Promise((r) => (finish = r)) };
    this.live.set(task.id, live);
    try {
      // A follow-up reuses the worktree as the agent left it. Setup runs again only if the agent
      // never ran (setup failed, or the daemon stopped during it).
      const agentRan = task.turns > 0 || task.sessionId !== null;
      let ready: TaskRecord | null = task;
      if (task.worktreePath === null || !agentRan) {
        this.transition(task.id, "setting_up", { error: null });
        ready = await this.setup(task, live.abort.signal);
      }
      // A cancel during setup aborted it: the agent must not start.
      if (ready && !live.abort.signal.aborted) await this.launch(ready, live);
    } finally {
      if (this.live.get(task.id) === live) {
        live.run?.end();
        this.live.delete(task.id);
      }
      finish();
    }
  }

  /** Worktree, env files, ports and setup commands. Returns null (task failed) on any failure. */
  private async setup(task: TaskRecord, signal: AbortSignal): Promise<TaskRecord | null> {
    const { store, home } = this.deps;
    const repo = store.getRepo(task.repoId);
    if (!repo) return this.fail(task.id, "setup: repo is no longer registered");
    try {
      const { config, baseBranch, branch, worktreePath } = await this.withRepoLock(repo.id, async () => {
        if (task.worktreePath !== null && task.branch !== null && task.baseBranch !== null) {
          // Setup again in the worktree it already made; its config from the same base (spec §7).
          const { ref } = await resolveBaseRef(repo.path, task.baseBranch);
          const config = await readRepoConfig(repo.path, ref);
          return {
            config,
            baseBranch: task.baseBranch,
            branch: task.branch,
            worktreePath: task.worktreePath,
          };
        }
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
    // Every run of the task, first or follow-up, gets the same options (a resumed session
    // doesn't remember them).
    const options: RunOptions = {
      permissionMode: task.permissionMode,
      env: this.taskEnv(task.id, task.portBase ?? 0),
      ...(task.model ? { model: task.model } : {}),
    };
    const spec: TaskSpec = { taskId: task.id, prompt: task.prompt, ...options };
    const followUp = task.pendingMessage;
    this.transition(task.id, "running", { pendingMessage: null, error: null });
    if (followUp === null) live.run = adapter.start(spec, ctx);
    else if (task.sessionId !== null && adapter.capabilities.resume) {
      live.run = adapter.resume(task.sessionId, followUp, ctx, options);
    } else {
      // No session to resume (the agent died before reporting one): start over with the
      // original prompt plus the follow-up, rather than fail.
      live.run = adapter.start({ ...spec, prompt: `${task.prompt}\n\nFollow-up: ${followUp}` }, ctx);
    }
    await this.drive(task.id, live, live.run);
  }

  /** Consumes one turn's events. `events` never throws (AGENTS.md rule 7). */
  private async drive(taskId: string, live: Live, run: AgentRun): Promise<void> {
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
          return this.endTurn(taskId, live, run);
        case "error":
          return this.endTurn(taskId, live, run, event.message);
      }
    }
    await this.endTurn(taskId, live, run, "agent stopped without finishing the turn");
  }

  /**
   * A turn is over: commit whatever the agent left (also after an error, to keep the work),
   * end the agent session, then review, failed, or needs_input when the commit failed. A failed
   * commit leaves the worktree exactly as it is (spec §6).
   */
  private async endTurn(taskId: string, live: Live, run: AgentRun, failure?: string): Promise<void> {
    live.ending = true;
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
      commitError = gitMessage(e);
    } finally {
      run.end();
    }
    if (this.live.get(taskId) === live) this.live.delete(taskId);
    // Nothing is waiting on a prompt any more; clients drop it.
    this.deps.broker.withdrawAll(taskId);

    if (this.closing.has(taskId)) {
      // This turn ended because of a cancel, which sets the status once it has discarded.
      this.deps.store.updateTask(taskId, { turns });
      return;
    }
    if (commitError !== undefined) {
      const after = failure ? ` (after agent error: ${failure})` : "";
      this.transition(taskId, "needs_input", { turns, error: `commit failed: ${commitError}${after}` });
    } else if (failure !== undefined) {
      this.transition(taskId, "failed", { turns, error: failure });
    } else {
      this.transition(taskId, "review", { turns, error: null });
    }
  }

  /** Stores the follow-up and queues the task; start() resumes the session with it. */
  private followUp(task: TaskRecord, text: string): TaskRecord {
    this.transition(task.id, "queued", { pendingMessage: text });
    this.schedule();
    return this.get(task.id);
  }

  /** Runs a cancel or discard as the one in flight for the task; then frees its slot. */
  private close(taskId: string, fn: () => Promise<TaskRecord>): Promise<TaskRecord> {
    // fn starts on the next microtask, so `closing` is set before anything it triggers looks.
    const p: Promise<TaskRecord> = Promise.resolve()
      .then(fn)
      .finally(() => {
        if (this.closing.get(taskId) === p) this.closing.delete(taskId);
        this.schedule();
      });
    this.closing.set(taskId, p);
    return p;
  }

  /** Stops the task's agent or setup and waits until start() is done with it. */
  private async stop(taskId: string): Promise<void> {
    const live = this.live.get(taskId);
    if (!live) return;
    if (live.run) {
      const run = live.run;
      this.deps.broker.withdrawAll(taskId);
      // The interrupt ends the turn the normal way, so endTurn commits what the agent left.
      await run.interrupt().catch(() => undefined);
      run.end();
    } else {
      live.abort.abort();
    }
    await live.finished;
  }

  /**
   * Commit, then remove the worktree (no --force), then cancelled. Any failure leaves the
   * worktree and its work in place: the task rests with the error and the caller gets a conflict.
   */
  private async discardWork(taskId: string): Promise<TaskRecord> {
    const task = this.get(taskId);
    const { worktreePath, branch } = task;
    if (worktreePath !== null && branch !== null) {
      try {
        // A task parked by a failed commit retries that turn's commit; otherwise the work is
        // newer than the last counted turn.
        const turn = task.status === "needs_input" && !this.live.has(taskId) ? task.turns : task.turns + 1;
        await commitTurn({
          cwd: worktreePath,
          branch,
          message: `${task.title} (turn ${Math.max(turn, 1)})`,
          trailers: this.trailers(task),
          env: this.deps.gitEnv,
        });
        await this.withRepoLock(task.repoId, () => removeWorktree(task.repoPath, worktreePath));
      } catch (e) {
        const error = `discard failed: ${gitMessage(e)}. The work is still in ${worktreePath}`;
        const current = this.get(taskId);
        // A cancel can fail from a working status; failed is the resting state that says so.
        const rest = RESTING_STATUSES.includes(current.status as TaskStatus) ? current.status : "failed";
        this.transition(taskId, rest as TaskStatus, { error });
        throw new RunnerError("conflict", error);
      }
    }
    return this.transition(taskId, "cancelled", {
      worktreePath: null,
      pendingMessage: null,
      discardedAt: new Date().toISOString(),
    });
  }

  // Helpers

  private get(taskId: string): TaskRecord {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new RunnerError("not_found", `unknown task: ${taskId}`);
    return task;
  }

  /** The task, unless a cancel or discard is under way. */
  private getOpen(taskId: string): TaskRecord {
    const task = this.get(taskId);
    if (this.closing.has(taskId)) throw new RunnerError("conflict", "task is being cancelled");
    return task;
  }

  /**
   * No agent at work. A needs_input task counts only when parked by a failed commit: with no
   * agent waiting on a prompt it takes a follow-up or a discard like review.
   */
  private isResting(task: TaskRecord): boolean {
    if (task.status === "needs_input") return !this.live.has(task.id);
    return RESTING_STATUSES.includes(task.status as TaskStatus);
  }

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
    // A cancel stopped the setup on purpose; it sets the final status itself.
    if (!this.closing.has(taskId)) this.transition(taskId, "failed", { error });
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
