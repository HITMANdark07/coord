import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateTaskInput, DaemonEvent, PermissionRequest } from "@coord/protocol";
import { openStore, type Store } from "@coord/task-store";
import { makeTempRepo } from "@coord/worktree-manager/testing";
import { EventBus } from "../event-bus";
import { PermissionBroker } from "../permission-broker";
import { RunnerError } from "./errors";
import { TaskRunner } from "./task-runner";
import { fakeAdapter, type FakeAdapterOptions, type FakeStep } from "./testing";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const done: FakeStep = { event: { type: "done" } };
const session: FakeStep = { event: { type: "session", sessionId: "s-1" } };
const waitForMessage: FakeStep = { waitForMessage: true };
/** A message turn that talks first, then edits: it shows whether a dropped message still ran. */
const orphanTurn = (m: string): FakeStep[] => [
  { event: { type: "text", text: `received: ${m}` } },
  { edit: { file: "orphan.txt", content: "should never be written\n" } },
  { event: { type: "done" } },
];
const edit = (file: string, content = `${file} from the agent\n`): FakeStep => ({ edit: { file, content } });
const permission: PermissionRequest = {
  toolUseId: "tu-1",
  tool: "Bash",
  input: { command: "ls" },
  canRemember: true,
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Git env with an isolated config and no identity, so `git commit` fails. */
async function noIdentityGitEnv(): Promise<Record<string, string>> {
  const isolated = await mkdtemp(join(tmpdir(), "coord-runner-git-"));
  cleanup.push(isolated);
  return {
    HOME: isolated,
    GIT_CONFIG_GLOBAL: join(isolated, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "",
    GIT_AUTHOR_EMAIL: "",
    GIT_COMMITTER_NAME: "",
    GIT_COMMITTER_EMAIL: "",
    EMAIL: "",
  };
}

/** One daemon process: a runner with its own bus, broker and agent, on a shared store and home. */
interface BootOptions {
  maxConcurrent?: number;
  fake?: FakeAdapterOptions;
  stopGraceMs?: number;
}

function boot(
  env: { store: Store; home: string; gitEnv: Record<string, string> },
  script: FakeStep[],
  opts: BootOptions = {},
) {
  const { store, home, gitEnv } = env;
  const bus = new EventBus();
  const events: DaemonEvent[] = [];
  bus.subscribe((e) => events.push(e));
  // The broker and the runner need each other; the runner is assigned before any task runs.
  let runner: TaskRunner | undefined = undefined;
  const broker = new PermissionBroker({
    store,
    bus,
    onPendingChange: (t, c) => runner?.onPendingChange(t, c),
  });
  const adapter = fakeAdapter(script, opts.fake);
  runner = new TaskRunner({
    store,
    bus,
    broker,
    adapters: { "claude-code": adapter },
    home,
    maxConcurrent: opts.maxConcurrent ?? 3,
    gitEnv,
    ...(opts.stopGraceMs !== undefined ? { stopGraceMs: opts.stopGraceMs } : {}),
  });
  const statuses = (taskId: string) =>
    events.flatMap((e) =>
      e.payload.kind === "task.updated" && e.payload.task.id === taskId ? [e.payload.task.status] : [],
    );
  return { bus, broker, adapter, events, statuses, runner: runner as TaskRunner };
}

async function setup(script: FakeStep[], opts: BootOptions & { gitEnv?: Record<string, string> } = {}) {
  const repo = await makeTempRepo();
  cleanup.push(dirname(repo.path));
  // Real path: git reports worktree paths resolved (macOS tmpdir() sits behind a symlink).
  const home = await realpath(await mkdtemp(join(tmpdir(), "coord-runner-home-")));
  cleanup.push(home);
  const store = openStore(":memory:");
  const env = { store, home, gitEnv: opts.gitEnv ?? repo.env };
  const repoRecord = store.addRepo({ name: "repo", path: repo.path, defaultBranch: "main", remoteUrl: null });
  const daemon = boot(env, script, opts);
  const create = (input: Partial<CreateTaskInput> = {}, runner = daemon.runner) =>
    runner.create({ repoId: repoRecord.id, prompt: "Fix it\nwith more detail", ...input });
  /** Subjects of the commits on a task branch that aren't on main, oldest first. */
  const commits = (branch: string) =>
    git(repo.path, "log", "--reverse", "--format=%s", `main..${branch}`).trim().split("\n").filter(Boolean);
  return { ...daemon, repo, home, store, env, create, commits };
}

describe("TaskRunner lifecycle", () => {
  it("message during a running turn is sent live", async () => {
    const { store, runner, adapter, create, events } = await setup([session, waitForMessage, done]);
    const task = await create();
    await vi.waitFor(() => expect(store.getTask(task.id)!.status).toBe("running"));

    const returned = await runner.message(task.id, "use tabs");
    expect(returned.id).toBe(task.id);
    await runner.idle();

    expect(adapter.calls.send).toEqual(["use tabs"]);
    expect(adapter.calls.resume).toEqual([]);
    expect(events.map((e) => e.payload)).toContainEqual({
      kind: "agent.event",
      taskId: task.id,
      event: { type: "text", text: "received: use tabs" },
    });
    expect(store.getTask(task.id)!.status).toBe("review");
  });

  it("a live message runs as its own turn and is committed", async () => {
    const { store, runner, create, events, commits } = await setup(
      [session, edit("a.txt"), waitForMessage, done],
      {
        fake: {
          messageTurn: (m) => [edit("b.txt"), { event: { type: "text", text: `received: ${m}` } }, done],
        },
      },
    );
    const task = await create();
    await vi.waitFor(() => expect(store.getTask(task.id)!.status).toBe("running"));

    await runner.message(task.id, "add b");
    await runner.idle();

    const t = store.getTask(task.id)!;
    expect(t.status).toBe("review");
    expect(t.turns).toBe(2);
    expect(commits(t.branch!)).toEqual(["Fix it (turn 1)", "Fix it (turn 2)"]);
    expect(git(t.worktreePath!, "show", "HEAD:b.txt")).toBe("b.txt from the agent\n");
    // Between the two turn ends the task is still running (turn 1 recorded); review only after.
    const log = events.flatMap((e) => {
      const p = e.payload;
      if (p.kind === "agent.event" && p.taskId === task.id && p.event.type === "done") return ["done"];
      if (p.kind === "task.updated" && p.task.id === task.id) return [`${p.task.status}:${p.task.turns}`];
      return [];
    });
    const between = log.slice(log.indexOf("done") + 1, log.lastIndexOf("done"));
    expect(between).toEqual(["running:1"]);
    expect(log.slice(log.lastIndexOf("done") + 1)).toEqual(["review:2"]);
  });

  it("interrupt with a queued live message ends at the current turn", async () => {
    const { store, broker, runner, adapter, create, events, commits } = await setup(
      [edit("a.txt"), waitForMessage, { permission }, done],
      { fake: { messageTurn: orphanTurn } },
    );
    const task = await create();
    await vi.waitFor(() => expect(store.getTask(task.id)!.status).toBe("running"));
    await runner.message(task.id, "more");
    await vi.waitFor(() => expect(broker.pending(task.id)).toHaveLength(1));

    await runner.interrupt(task.id);
    await runner.idle();

    const t = store.getTask(task.id)!;
    expect(t.status).toBe("review");
    expect(t.turns).toBe(1);
    expect(adapter.calls.send).toEqual(["more"]);
    expect(commits(t.branch!)).toEqual(["Fix it (turn 1)"]);
    const texts = events.flatMap((e) =>
      e.payload.kind === "agent.event" && e.payload.event.type === "text" ? [e.payload.event.text] : [],
    );
    expect(texts).not.toContain("received: more");
    // The agent had already read the message; only killing the run keeps that turn from running
    // in a worktree that is now in review.
    await adapter.settled();
    expect(existsSync(join(t.worktreePath!, "orphan.txt"))).toBe(false);
    expect(git(t.worktreePath!, "status", "--porcelain")).toBe("");
    // The dropped message is shown, not lost silently.
    expect(store.getTask(task.id)!.error).toBe('Not sent: "more"');
  });

  it("cancel with a queued live message leaves no orphan edits", async () => {
    const { repo, store, broker, runner, adapter, create } = await setup(
      [edit("a.txt"), waitForMessage, { permission }, done],
      { fake: { messageTurn: orphanTurn } },
    );
    const task = await create();
    await vi.waitFor(() => expect(store.getTask(task.id)!.status).toBe("running"));
    await runner.message(task.id, "more");
    await vi.waitFor(() => expect(broker.pending(task.id)).toHaveLength(1));
    const before = store.getTask(task.id)!;

    const t = await runner.cancel(task.id);
    await adapter.settled();

    expect(t.status).toBe("cancelled");
    expect(t.error).toBe('Not sent: "more"');
    expect(existsSync(before.worktreePath!)).toBe(false);
    expect(git(repo.path, "ls-tree", "--name-only", before.branch!)).not.toContain("orphan.txt");
    expect(git(repo.path, "show", `${before.branch}:a.txt`)).toBe("a.txt from the agent\n");
  });

  it("a message the session refuses waits for the turn end and resumes with it", async () => {
    const { store, broker, runner, adapter, create } = await setup([session, { permission }, done], {
      fake: { refuseSends: true },
    });
    const task = await create();
    await vi.waitFor(() => expect(broker.pending(task.id)).toHaveLength(1));

    const sent = runner.message(task.id, "use tabs");
    broker.answer(broker.pending(task.id)[0]!.id, { allow: true });
    await sent;
    await runner.idle();

    expect(adapter.calls.send).toEqual([]);
    expect(adapter.calls.resume).toMatchObject([{ sessionId: "s-1", message: "use tabs" }]);
    expect(store.getTask(task.id)!.status).toBe("review");
  });

  it("message during a running turn is a conflict when the agent can't take live messages", async () => {
    const { store, runner, adapter, create } = await setup([waitForMessage, done]);
    (adapter.capabilities as { liveMessages: boolean }).liveMessages = false;
    const task = await create();
    await vi.waitFor(() => expect(store.getTask(task.id)!.status).toBe("running"));

    const err = await runner.message(task.id, "use tabs").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerError);
    expect(err).toMatchObject({ code: "conflict", message: expect.stringMatching(/interrupt/i) });
    expect(adapter.calls.send).toEqual([]);

    await runner.interrupt(task.id);
    await runner.idle();
    expect(store.getTask(task.id)!.status).toBe("review");
  });

  it("message in review resumes the session", async () => {
    const { store, runner, adapter, create, statuses, commits } = await setup([
      session,
      edit("a.txt"),
      done,
      edit("tests.txt"),
      done,
    ]);
    const task = await create({ model: "opus", permissionMode: "accept_edits" });
    await runner.idle();
    expect(store.getTask(task.id)!.status).toBe("review");

    await runner.message(task.id, "also add tests");
    await runner.idle();

    const first = adapter.calls.start[0]!;
    expect(adapter.calls.start).toHaveLength(1);
    expect(adapter.calls.resume).toHaveLength(1);
    expect(adapter.calls.resume[0]).toMatchObject({ sessionId: "s-1", message: "also add tests" });
    // The resumed session runs with the first run's options (mode, model, port env).
    expect(adapter.calls.resume[0]!.options).toEqual({
      model: first.model,
      permissionMode: first.permissionMode,
      env: first.env,
    });
    const t = store.getTask(task.id)!;
    expect(t.status).toBe("review");
    expect(t.turns).toBe(2);
    expect(t.pendingMessage).toBeNull();
    expect(commits(t.branch!)).toEqual(["Fix it (turn 1)", "Fix it (turn 2)"]);
    expect(git(t.worktreePath!, "show", "HEAD:tests.txt")).toBe("tests.txt from the agent\n");
    expect(statuses(task.id)).toEqual([
      "queued",
      "setting_up",
      "running",
      "review",
      "queued",
      "running",
      "review",
    ]);
  });

  it("a follow-up waits for a free slot", async () => {
    const { store, runner, adapter, create } = await setup([session, waitForMessage, done], {
      maxConcurrent: 1,
    });
    const a = await create();
    await vi.waitFor(() => expect(store.getTask(a.id)!.status).toBe("running"));
    await runner.message(a.id, "go");
    await runner.idle();
    expect(store.getTask(a.id)!.status).toBe("review");

    // B holds the only slot while its agent waits for a message.
    const b = await create({ prompt: "Other" });
    await vi.waitFor(() => expect(store.getTask(b.id)!.status).toBe("running"));
    await runner.message(a.id, "more");
    expect(store.getTask(a.id)!.status).toBe("queued");
    expect(adapter.calls.resume).toEqual([]);

    await runner.message(b.id, "go");
    await runner.idle();
    expect(store.getTask(a.id)!.status).toBe("review");
    expect(adapter.calls.resume).toHaveLength(1);
  });

  it("interrupt ends the turn as review, not failed", async () => {
    const { store, runner, create, statuses, commits } = await setup([edit("a.txt"), waitForMessage, done]);
    const task = await create();
    await vi.waitFor(() =>
      expect(existsSync(join(store.getTask(task.id)!.worktreePath ?? "/nope", "a.txt"))).toBe(true),
    );

    await runner.interrupt(task.id);
    await runner.idle();

    const t = store.getTask(task.id)!;
    expect(t.status).toBe("review");
    expect(t.error).toBeNull();
    expect(statuses(task.id)).not.toContain("failed");
    expect(commits(t.branch!)).toEqual(["Fix it (turn 1)"]);
  });

  it("interrupt while waiting on a permission withdraws it and ends as review", async () => {
    const { store, broker, runner, create } = await setup([{ permission }, edit("a.txt"), done]);
    const task = await create();
    await vi.waitFor(() => expect(store.getTask(task.id)!.status).toBe("needs_input"));

    await runner.interrupt(task.id);
    await runner.idle();

    expect(broker.pending(task.id)).toEqual([]);
    expect(store.getTask(task.id)!.status).toBe("review");
  });

  it("restart: running task with uncommitted edits becomes interrupted and keeps them; resume commits them", async () => {
    const first = await setup([session, edit("a.txt"), waitForMessage, done]);
    const task = await first.create();
    await vi.waitFor(() =>
      expect(existsSync(join(first.store.getTask(task.id)!.worktreePath ?? "/nope", "a.txt"))).toBe(true),
    );
    expect(first.store.getTask(task.id)!.status).toBe("running");

    // The daemon dies: the old runner is dropped as it is. A new one starts on the same store and home.
    const second = boot(first.env, [done]);
    expect(await second.runner.recoverOnStart()).toBe(1);

    let t = first.store.getTask(task.id)!;
    expect(t.status).toBe("interrupted");
    expect(second.statuses(task.id)).toEqual(["interrupted"]);
    expect(await readFile(join(t.worktreePath!, "a.txt"), "utf8")).toBe("a.txt from the agent\n");
    expect(git(t.worktreePath!, "status", "--porcelain")).toMatch(/a\.txt/);
    expect(first.commits(t.branch!)).toEqual([]);

    await second.runner.resume(task.id);
    await second.runner.idle();

    t = first.store.getTask(task.id)!;
    expect(t.status).toBe("review");
    expect(second.adapter.calls.resume).toMatchObject([
      { sessionId: "s-1", message: "Continue where you left off." },
    ]);
    expect(second.adapter.calls.start).toEqual([]);
    expect(first.commits(t.branch!)).toEqual(["Fix it (turn 1)"]);
    expect(git(t.worktreePath!, "show", "HEAD:a.txt")).toBe("a.txt from the agent\n");
    expect(git(t.worktreePath!, "status", "--porcelain")).toBe("");
  });

  it("restart: stale permission prompts are withdrawn and queued tasks start", async () => {
    const first = await setup([{ permission }, done], { maxConcurrent: 1 });
    const a = await first.create();
    await vi.waitFor(() => expect(first.store.getTask(a.id)!.status).toBe("needs_input"));
    const b = await first.create();
    expect(first.store.getTask(b.id)!.status).toBe("queued");
    const [request] = first.broker.pending(a.id);

    const second = boot(first.env, [done], { maxConcurrent: 1 });
    expect(await second.runner.recoverOnStart()).toBe(1);

    expect(first.store.listPendingPermissions()).toEqual([]);
    expect(second.events.map((e) => e.payload)).toContainEqual({
      kind: "permission.resolved",
      requestId: request!.id,
      taskId: a.id,
      outcome: "withdrawn",
    });
    expect(first.store.getTask(a.id)!.status).toBe("interrupted");
    await second.runner.idle();
    expect(first.store.getTask(b.id)!.status).toBe("review");
  });

  it("resume without a session id starts fresh with the original prompt", async () => {
    const { store, runner, adapter, create } = await setup([
      edit("a.txt"),
      { event: { type: "error", message: "crashed" } },
    ]);
    const task = await create({ permissionMode: "accept_edits" });
    await runner.idle();
    expect(store.getTask(task.id)).toMatchObject({ status: "failed", sessionId: null });

    await runner.resume(task.id);
    await runner.idle();

    expect(adapter.calls.resume).toEqual([]);
    expect(adapter.calls.start).toHaveLength(2);
    const [firstRun, retry] = adapter.calls.start;
    expect(retry!.prompt).toContain("Fix it\nwith more detail");
    expect(retry!.prompt).toContain("Follow-up: Continue where you left off.");
    expect({ ...retry, prompt: firstRun!.prompt }).toEqual(firstRun);
    expect(store.getTask(task.id)!.turns).toBe(2);
  });

  it("resume after a failed setup runs the setup again in the same worktree", async () => {
    const { repo, store, runner, adapter, create } = await setup([done]);
    await writeFile(join(repo.path, "setup.sh"), "test -f ok || exit 3\necho ran > setup-ran.txt\n");
    const configDir = join(repo.path, ".coord");
    execFileSync("mkdir", ["-p", configDir]);
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({ setup: ["sh setup.sh"], envFiles: [".env"] }),
    );
    execFileSync("git", ["add", "-A"], { cwd: repo.path, env: { ...process.env, ...repo.env } });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "setup"], {
      cwd: repo.path,
      env: { ...process.env, ...repo.env },
    });
    const task = await create();
    await runner.idle();
    let t = store.getTask(task.id)!;
    expect(t.status).toBe("failed");
    expect(adapter.calls.start).toHaveLength(0);

    // The user's own env file stays out of git; the user fixes the worktree's copy.
    await writeFile(join(repo.path, ".env"), "TOKEN=old\n");
    await writeFile(join(t.worktreePath!, ".env"), "TOKEN=fixed\n");
    await writeFile(join(t.worktreePath!, "ok"), "");
    await runner.resume(task.id);
    await runner.idle();

    t = store.getTask(task.id)!;
    expect(t.status).toBe("review");
    expect(adapter.calls.start).toHaveLength(1);
    expect(git(t.worktreePath!, "show", "HEAD:setup-ran.txt")).toBe("ran\n");
    expect(await readFile(join(t.worktreePath!, ".env"), "utf8")).toBe("TOKEN=fixed\n");
  });

  it("discard keeps the work on the branch and removes the worktree", async () => {
    const { repo, store, runner, create, statuses, commits } = await setup([edit("a.txt"), done]);
    const task = await create();
    await runner.idle();
    const before = store.getTask(task.id)!;
    // Work that no turn committed yet (the user's own edit in the worktree).
    await writeFile(join(before.worktreePath!, "b.txt"), "user edit\n");

    const t = await runner.discard(task.id);

    expect(t.status).toBe("cancelled");
    expect(t.discardedAt).not.toBeNull();
    expect(t.worktreePath).toBeNull();
    expect(t.branch).toBe(before.branch);
    expect(existsSync(before.worktreePath!)).toBe(false);
    expect(commits(before.branch!)).toEqual(["Fix it (turn 1)", "Fix it (turn 2)"]);
    expect(git(repo.path, "show", `${before.branch}:b.txt`)).toBe("user edit\n");
    expect(git(repo.path, "worktree", "list")).not.toContain(before.worktreePath!);
    expect(statuses(task.id).at(-1)).toBe("cancelled");
  });

  it("a task parked by a failed commit takes a follow-up and a discard like review", async () => {
    const gitEnv = await noIdentityGitEnv();
    const { repo, store, runner, adapter, create, commits } = await setup([session, edit("a.txt"), done], {
      gitEnv,
    });
    const task = await create();
    await runner.idle();
    expect(store.getTask(task.id)!.status).toBe("needs_input");

    // Still no identity: the follow-up turn's commit fails again and it parks again.
    await runner.message(task.id, "try again");
    await runner.idle();
    expect(adapter.calls.resume).toMatchObject([{ sessionId: "s-1", message: "try again" }]);
    expect(store.getTask(task.id)!.status).toBe("needs_input");

    Object.assign(gitEnv, repo.env);
    const t = await runner.discard(task.id);
    expect(t.status).toBe("cancelled");
    expect(commits(t.branch!)).toEqual(["Fix it (turn 2)"]);
  });

  it("a failed discard commit keeps the worktree and the task, and says so", async () => {
    const gitEnv = await noIdentityGitEnv();
    const { store, runner, create } = await setup([edit("a.txt"), done], { gitEnv });
    const task = await create();
    await runner.idle();
    const parked = store.getTask(task.id)!;
    expect(parked.status).toBe("needs_input");

    const err = await runner.discard(task.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerError);
    expect(err).toMatchObject({ code: "conflict", message: expect.stringMatching(/^discard failed: /) });

    const t = store.getTask(task.id)!;
    expect(t.status).toBe("needs_input");
    expect(t.error).toMatch(/^discard failed: /);
    expect(t.discardedAt).toBeNull();
    expect(t.worktreePath).toBe(parked.worktreePath);
    expect(await readFile(join(parked.worktreePath!, "a.txt"), "utf8")).toBe("a.txt from the agent\n");
  });

  it("a failed worktree removal keeps the task after committing", async () => {
    const { store, runner, create, commits } = await setup([edit("a.txt"), done]);
    const task = await create();
    await runner.idle();
    const before = store.getTask(task.id)!;
    await writeFile(join(before.worktreePath!, "b.txt"), "user edit\n");
    // A locked worktree can't be removed without --force.
    git(before.worktreePath!, "worktree", "lock", before.worktreePath!);

    await expect(runner.discard(task.id)).rejects.toMatchObject({ code: "conflict" });

    const t = store.getTask(task.id)!;
    expect(t.status).toBe("review");
    expect(t.error).toMatch(/^discard failed: /);
    expect(existsSync(before.worktreePath!)).toBe(true);
    expect(commits(before.branch!)).toEqual(["Fix it (turn 1)", "Fix it (turn 2)"]);
  });

  it("cancel from running stops the agent and discards", async () => {
    const { repo, store, runner, adapter, create, statuses, commits } = await setup(
      [edit("a.txt"), waitForMessage, done],
      { maxConcurrent: 1 },
    );
    const task = await create();
    const next = await create({ prompt: "Next" });
    const wt = () => store.getTask(task.id)!.worktreePath ?? "/nope";
    await vi.waitFor(() => expect(existsSync(join(wt(), "a.txt"))).toBe(true));
    const before = store.getTask(task.id)!;

    const t = await runner.cancel(task.id);

    expect(t.status).toBe("cancelled");
    expect(t.discardedAt).not.toBeNull();
    expect(statuses(task.id)).not.toContain("review");
    expect(statuses(task.id)).not.toContain("failed");
    expect(existsSync(before.worktreePath!)).toBe(false);
    expect(commits(before.branch!)).toEqual(["Fix it (turn 1)"]);
    expect(git(repo.path, "show", `${before.branch}:a.txt`)).toBe("a.txt from the agent\n");
    // The slot is free again: the queued task runs.
    await vi.waitFor(() => expect(adapter.calls.start).toHaveLength(2));
    await runner.cancel(next.id);
    await runner.idle();
    expect(store.getTask(next.id)!.status).toBe("cancelled");
  });

  it("cancel while waiting on a permission withdraws it", async () => {
    const { store, broker, runner, create, statuses } = await setup([{ permission }, edit("a.txt"), done]);
    const task = await create();
    await vi.waitFor(() => expect(store.getTask(task.id)!.status).toBe("needs_input"));

    const t = await runner.cancel(task.id);

    expect(t.status).toBe("cancelled");
    expect(broker.pending()).toEqual([]);
    expect(statuses(task.id).slice(-2)).toEqual(["needs_input", "cancelled"]);
  });

  it("cancel during setup stops it and never starts the agent", async () => {
    const { repo, store, runner, adapter, create, statuses } = await setup([done]);
    execFileSync("mkdir", ["-p", join(repo.path, ".coord")]);
    await writeFile(join(repo.path, ".coord/config.json"), JSON.stringify({ setup: ["sleep 30"] }));
    execFileSync("git", ["add", "-A"], { cwd: repo.path, env: { ...process.env, ...repo.env } });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "config"], {
      cwd: repo.path,
      env: { ...process.env, ...repo.env },
    });
    const task = await create();
    await vi.waitFor(() => expect(store.getTask(task.id)!.worktreePath).not.toBeNull());

    const t = await runner.cancel(task.id);
    await runner.idle();

    expect(t.status).toBe("cancelled");
    expect(store.getTask(task.id)!.status).toBe("cancelled");
    // The killed setup command is the cancel's doing, not a setup failure.
    expect(statuses(task.id)).toEqual(["queued", "setting_up", "cancelled"]);
    expect(adapter.calls.start).toEqual([]);
  });

  it("cancel before setup finishes never starts the agent, even when setup has nothing to run", async () => {
    const { store, runner, adapter, create, statuses } = await setup([done]);
    const task = await create();
    expect(store.getTask(task.id)!.status).toBe("setting_up");

    // Setup is still creating the worktree; with no setup commands it then succeeds.
    const t = await runner.cancel(task.id);
    await runner.idle();

    expect(t.status).toBe("cancelled");
    expect(statuses(task.id)).toEqual(["queued", "setting_up", "cancelled"]);
    expect(adapter.calls.start).toEqual([]);
  });

  it("cancel still finishes when the agent's interrupt hangs", async () => {
    const { repo, store, runner, create, commits } = await setup([edit("a.txt"), waitForMessage, done], {
      fake: { hangInterrupt: true },
      stopGraceMs: 20,
    });
    const task = await create();
    const wt = () => store.getTask(task.id)!.worktreePath ?? "/nope";
    await vi.waitFor(() => expect(existsSync(join(wt(), "a.txt"))).toBe(true));
    const before = store.getTask(task.id)!;

    const t = await runner.cancel(task.id);
    await runner.idle();

    expect(t.status).toBe("cancelled");
    expect(existsSync(before.worktreePath!)).toBe(false);
    expect(commits(before.branch!)).toEqual(["Fix it (turn 1)"]);
    expect(git(repo.path, "show", `${before.branch}:a.txt`)).toBe("a.txt from the agent\n");
  });

  it("discard of a worktree deleted by hand prunes it and keeps the branch", async () => {
    const { repo, store, runner, create, commits } = await setup([edit("a.txt"), done]);
    const task = await create();
    await runner.idle();
    const before = store.getTask(task.id)!;
    await rm(before.worktreePath!, { recursive: true, force: true });

    const t = await runner.discard(task.id);

    expect(t.status).toBe("cancelled");
    expect(git(repo.path, "worktree", "list")).not.toContain(before.worktreePath!);
    expect(commits(before.branch!)).toEqual(["Fix it (turn 1)"]);
  });

  it("discard fails loudly when the worktree can't be checked, and prunes nothing", async () => {
    const { repo, store, runner, create } = await setup([edit("a.txt"), done]);
    const task = await create();
    await runner.idle();
    const before = store.getTask(task.id)!;
    // stat() of the worktree fails with EACCES, not ENOENT: that is not "deleted by hand".
    const parent = dirname(before.worktreePath!);
    await chmod(parent, 0o000);
    try {
      await expect(runner.discard(task.id)).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await chmod(parent, 0o755);
    }

    const t = store.getTask(task.id)!;
    expect(t.status).toBe("review");
    // The stat itself fails the discard, before anything tries to forget the worktree.
    expect(t.error).toMatch(/^discard failed: EACCES: permission denied, stat '/);
    expect(git(repo.path, "worktree", "list")).toContain(before.worktreePath!);
    expect(existsSync(join(before.worktreePath!, "a.txt"))).toBe(true);
  });

  it("a failed cancel of a queued follow-up keeps its text in the error", async () => {
    const gitEnv = await noIdentityGitEnv();
    const { store, broker, runner, create } = await setup([{ permission }, edit("a.txt"), done], {
      maxConcurrent: 1,
      gitEnv,
    });
    const a = await create();
    await vi.waitFor(() => expect(broker.pending(a.id)).toHaveLength(1));
    broker.answer(broker.pending(a.id)[0]!.id, { allow: true });
    const b = await create();
    // A parks (its commit fails); B takes the only slot and waits on its prompt.
    await vi.waitFor(() => expect(broker.pending(b.id)).toHaveLength(1));
    await runner.message(a.id, "please also update the docs");
    expect(store.getTask(a.id)!.status).toBe("queued");

    await expect(runner.cancel(a.id)).rejects.toMatchObject({ code: "conflict" });

    const t = store.getTask(a.id)!;
    expect(t.status).toBe("failed");
    expect(t.pendingMessage).toBeNull();
    expect(t.error).toContain("please also update the docs");
    expect(await readFile(join(t.worktreePath!, "a.txt"), "utf8")).toBe("a.txt from the agent\n");
    await runner.cancel(b.id);
  });

  it("cancel from queued goes straight to cancelled", async () => {
    const { store, runner, create, statuses } = await setup([waitForMessage, done], { maxConcurrent: 1 });
    const a = await create();
    const b = await create();
    expect(store.getTask(b.id)!.status).toBe("queued");

    const t = await runner.cancel(b.id);

    expect(t.status).toBe("cancelled");
    expect(t.discardedAt).toBeNull();
    expect(statuses(b.id)).toEqual(["queued", "cancelled"]);
    await runner.cancel(a.id);
    await runner.idle();
  });

  it("sweep deletes branches discarded more than 14 days ago only", async () => {
    const { repo, store, runner, create } = await setup([edit("a.txt"), done]);
    const old = await create({ title: "Old" });
    const recent = await create({ title: "Recent" });
    await runner.idle();
    await runner.discard(old.id);
    await runner.discard(recent.id);
    const now = new Date();
    store.updateTask(old.id, { discardedAt: new Date(now.getTime() - 15 * DAY).toISOString() });
    store.updateTask(recent.id, { discardedAt: new Date(now.getTime() - 13 * DAY).toISOString() });
    const branches = () => git(repo.path, "branch", "--format=%(refname:short)").trim().split("\n");
    expect(branches()).toEqual(expect.arrayContaining(["agent/old", "agent/recent"]));

    expect(await runner.sweepDiscardedBranches(now)).toBe(1);

    expect(branches()).not.toContain("agent/old");
    expect(branches()).toContain("agent/recent");
    expect(store.getTask(old.id)!.status).toBe("cleaned_up");
    expect(store.getTask(recent.id)!.status).toBe("cancelled");
    // Already swept: nothing left to do.
    expect(await runner.sweepDiscardedBranches(now)).toBe(0);
  });

  it("a sweep that can't delete a branch says so and retries next time", async () => {
    const { repo, store, runner, create, events } = await setup([edit("a.txt"), done]);
    const task = await create({ title: "Old" });
    await runner.idle();
    await runner.discard(task.id);
    const now = new Date();
    store.updateTask(task.id, { discardedAt: new Date(now.getTime() - 15 * DAY).toISOString() });
    // A branch checked out in some worktree can't be deleted.
    const elsewhere = join(dirname(repo.path), "elsewhere");
    git(repo.path, "worktree", "add", elsewhere, "agent/old");

    expect(await runner.sweepDiscardedBranches(now)).toBe(0);

    const t = store.getTask(task.id)!;
    expect(t.status).toBe("cancelled");
    expect(t.error).toMatch(/^branch cleanup failed: /);
    expect(events.map((e) => e.payload)).toContainEqual({
      kind: "task.updated",
      task: expect.objectContaining({ id: task.id, error: t.error }),
    });

    git(repo.path, "worktree", "remove", elsewhere);
    expect(await runner.sweepDiscardedBranches(now)).toBe(1);
    expect(store.getTask(task.id)).toMatchObject({ status: "cleaned_up", error: null });
  });

  it("actions in the wrong status are conflicts", async () => {
    const { store, runner, create } = await setup([done], { maxConcurrent: 1 });
    const task = await create();
    await runner.idle();
    expect(store.getTask(task.id)!.status).toBe("review");

    const conflict = { code: "conflict", status: 409 };
    await expect(runner.resume(task.id)).rejects.toBeInstanceOf(RunnerError);
    await expect(runner.resume(task.id)).rejects.toMatchObject(conflict);
    await expect(runner.interrupt(task.id)).rejects.toMatchObject(conflict);

    await runner.discard(task.id);
    await expect(runner.discard(task.id)).rejects.toMatchObject(conflict);
    await expect(runner.cancel(task.id)).rejects.toMatchObject(conflict);
    await expect(runner.message(task.id, "more")).rejects.toMatchObject(conflict);

    await expect(runner.message("nope", "x")).rejects.toMatchObject({ code: "not_found" });
    await expect(runner.cancel("nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(runner.message(task.id, "  ")).rejects.toMatchObject({ code: "invalid_request" });
  });
});
