import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateTaskInput, DaemonEvent, PermissionRequest } from "@coord/protocol";
import { openStore } from "@coord/task-store";
import { makeTempRepo } from "@coord/worktree-manager/testing";
import { EventBus } from "../event-bus";
import { PermissionBroker } from "../permission-broker";
import { RunnerError } from "./errors";
import { TaskRunner } from "./task-runner";
import { fakeAdapter, type FakeStep } from "./testing";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

const done: FakeStep = { event: { type: "done" } };
const editA: FakeStep = { edit: { file: "a.txt", content: "from the agent\n" } };
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

async function setup(
  script: FakeStep[],
  opts: { maxConcurrent?: number; gitEnv?: Record<string, string>; config?: object } = {},
) {
  const repo = await makeTempRepo();
  cleanup.push(dirname(repo.path));
  if (opts.config) {
    await mkdir(join(repo.path, ".coord"));
    await writeFile(join(repo.path, ".coord/config.json"), JSON.stringify(opts.config));
    execFileSync("git", ["add", "-A"], { cwd: repo.path, env: { ...process.env, ...repo.env } });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "config"], {
      cwd: repo.path,
      env: { ...process.env, ...repo.env },
    });
  }
  const home = await mkdtemp(join(tmpdir(), "coord-runner-home-"));
  cleanup.push(home);
  const store = openStore(":memory:");
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
  const adapter = fakeAdapter(script);
  runner = new TaskRunner({
    store,
    bus,
    broker,
    adapters: { "claude-code": adapter },
    home,
    maxConcurrent: opts.maxConcurrent ?? 3,
    gitEnv: opts.gitEnv ?? repo.env,
  });
  const theRunner = runner;
  const repoRecord = store.addRepo({ name: "repo", path: repo.path, defaultBranch: "main", remoteUrl: null });
  const create = (input: Partial<CreateTaskInput> = {}) =>
    theRunner.create({ repoId: repoRecord.id, prompt: "Fix it\nwith more detail", ...input });
  const statuses = (taskId: string) =>
    events.flatMap((e) =>
      e.payload.kind === "task.updated" && e.payload.task.id === taskId ? [e.payload.task.status] : [],
    );
  return { repo, repoRecord, home, store, bus, broker, runner: theRunner, adapter, events, create, statuses };
}

describe("TaskRunner", () => {
  it("registers a task made from a repo subdirectory against the repo's top level", async () => {
    const { repo, runner, repoRecord } = await setup([editA, done]);
    const sub = join(repo.path, "src", "deep");
    await mkdir(sub, { recursive: true });
    const created = await runner.create({ repoPath: sub, prompt: "Fix it" });
    await runner.idle();
    expect(created.repoId).toBe(repoRecord.id);
  });

  it("tells the user to register a repo that is not registered", async () => {
    const { runner } = await setup([done]);
    const other = await makeTempRepo();
    cleanup.push(dirname(other.path));
    await expect(runner.create({ repoPath: other.path, prompt: "x" })).rejects.toThrow(/coord repo add/);
    const plain = await mkdtemp(join(tmpdir(), "coord-not-a-repo-"));
    cleanup.push(plain);
    await expect(runner.create({ repoPath: plain, prompt: "x" })).rejects.toThrow(/coord repo add/);
    await expect(runner.create({ repoPath: "/does/not/exist", prompt: "x" })).rejects.toThrow(
      /coord repo add/,
    );
  });

  it("happy path: queued → setting_up → running → review with one commit", async () => {
    const { repo, store, runner, create, statuses, events } = await setup([editA, done]);
    const created = await create();
    await runner.idle();

    // Clients get the public Task shape, without the daemon's bookkeeping fields.
    for (const e of events) {
      if (e.payload.kind !== "task.updated") continue;
      expect(Object.keys(e.payload.task)).not.toContain("portBase");
      expect(Object.keys(e.payload.task)).not.toContain("pendingMessage");
      expect(Object.keys(e.payload.task)).not.toContain("discardedAt");
    }

    const task = store.getTask(created.id)!;
    expect(task.status).toBe("review");
    expect(task.turns).toBe(1);
    expect(task.error).toBeNull();
    expect(task.branch).toBe("agent/fix-it");
    expect(task.title).toBe("Fix it");
    expect(statuses(task.id)).toEqual(["queued", "setting_up", "running", "review"]);

    expect(git(repo.path, "rev-list", "--count", "main..agent/fix-it").trim()).toBe("1");
    const body = git(repo.path, "log", "-1", "--format=%B", "agent/fix-it");
    expect(body).toBe(
      `Fix it (turn 1)\n\nCoord-Task: ${task.id}\nCo-Authored-By: Claude Code <noreply@anthropic.com>\n\n`,
    );
    expect(git(task.worktreePath!, "show", "HEAD:a.txt")).toBe("from the agent\n");
    expect(task.worktreePath).toMatch(/\/worktrees\/repo-[^/]+\/fix-it$/);
  });

  it("leaves the user's checkout untouched", async () => {
    const { repo, runner, create } = await setup([editA, done]);
    // A dirty checkout: an edited tracked file and an untracked one (Review Focus 1).
    await writeFile(join(repo.path, "README.md"), "user's unsaved edit\n");
    await writeFile(join(repo.path, "notes.txt"), "scratch\n");
    const before = {
      status: git(repo.path, "status", "--porcelain"),
      head: git(repo.path, "rev-parse", "HEAD"),
      branch: git(repo.path, "branch", "--show-current"),
    };

    await create();
    await runner.idle();

    expect(git(repo.path, "status", "--porcelain")).toBe(before.status);
    expect(git(repo.path, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(repo.path, "branch", "--show-current")).toBe(before.branch);
    expect(await readFile(join(repo.path, "README.md"), "utf8")).toBe("user's unsaved edit\n");
    expect(existsSync(join(repo.path, "a.txt"))).toBe(false);
  });

  it("two tasks with the same title get different branches", async () => {
    const { store, runner, create } = await setup([editA, done]);
    const a = await create();
    const b = await create();
    await runner.idle();

    const ta = store.getTask(a.id)!;
    const tb = store.getTask(b.id)!;
    expect([ta.status, tb.status]).toEqual(["review", "review"]);
    expect(new Set([ta.branch, tb.branch])).toEqual(new Set(["agent/fix-it", "agent/fix-it-2"]));
    expect(ta.worktreePath).not.toBe(tb.worktreePath);
    expect(existsSync(join(ta.worktreePath!, "a.txt"))).toBe(true);
    expect(existsSync(join(tb.worktreePath!, "a.txt"))).toBe(true);
  });

  it("respects maxConcurrent", async () => {
    const { store, broker, runner, create, events } = await setup([{ permission }, done], {
      maxConcurrent: 1,
    });
    const a = await create();
    const b = await create();
    await vi.waitFor(() => expect(store.getTask(a.id)!.status).toBe("needs_input"));
    expect(store.getTask(b.id)!.status).toBe("queued");

    broker.answer(broker.pending(a.id)[0]!.id, { allow: true });
    await vi.waitFor(() => expect(store.getTask(b.id)!.status).toBe("needs_input"));
    broker.answer(broker.pending(b.id)[0]!.id, { allow: true });
    await runner.idle();

    expect(store.getTask(b.id)!.status).toBe("review");
    const order = events.flatMap((e) =>
      e.payload.kind === "task.updated" ? [`${e.payload.task.id}:${e.payload.task.status}`] : [],
    );
    expect(order.indexOf(`${b.id}:setting_up`)).toBeGreaterThan(order.indexOf(`${a.id}:review`));
  });

  it("permission prompt sets needs_input and continues after allow", async () => {
    const { store, broker, runner, create, statuses, events } = await setup([{ permission }, editA, done]);
    const task = await create();
    await vi.waitFor(() => expect(store.getTask(task.id)!.status).toBe("needs_input"));
    const [request] = broker.pending(task.id);
    expect(request?.tool).toBe("Bash");

    expect(broker.answer(request!.id, { allow: true })).toBe("ok");
    await runner.idle();

    expect(store.getTask(task.id)!.status).toBe("review");
    expect(statuses(task.id)).toEqual([
      "queued",
      "setting_up",
      "running",
      "needs_input",
      "running",
      "review",
    ]);
    expect(events.map((e) => e.payload)).toContainEqual({
      kind: "agent.event",
      taskId: task.id,
      event: { type: "tool_result", toolUseId: "tu-1", ok: true },
    });
  });

  it("setup failure → failed with the command in error", async () => {
    const { store, runner, adapter, create, events } = await setup([editA, done], {
      config: { setup: ["echo installing; exit 7"] },
    });
    const task = await create();
    await runner.idle();

    const t = store.getTask(task.id)!;
    expect(t.status).toBe("failed");
    expect(t.error).toBe("setup: echo installing; exit 7 exited 7");
    expect(adapter.calls.start).toHaveLength(0);
    const texts = events.flatMap((e) =>
      e.payload.kind === "agent.event" && e.payload.event.type === "text" ? [e.payload.event.text] : [],
    );
    expect(texts.join("\n")).toContain("installing");
  });

  it("agent error commits the work, then fails", async () => {
    const { repo, store, runner, create } = await setup([
      editA,
      { event: { type: "error", message: "boom" } },
    ]);
    const task = await create();
    await runner.idle();

    const t = store.getTask(task.id)!;
    expect(t.status).toBe("failed");
    expect(t.error).toBe("boom");
    expect(git(repo.path, "rev-list", "--count", `main..${t.branch}`).trim()).toBe("1");
    expect(git(t.worktreePath!, "status", "--porcelain")).toBe("");
    expect(git(t.worktreePath!, "show", "HEAD:a.txt")).toBe("from the agent\n");
  });

  it("commit failure → needs_input, worktree untouched", async () => {
    const gitEnv = await noIdentityGitEnv();
    const { repo, store, runner, create } = await setup([editA, done], { gitEnv });
    const task = await create();
    await runner.idle();

    const t = store.getTask(task.id)!;
    expect(t.status).toBe("needs_input");
    expect(t.error).toMatch(/^commit failed: /);
    expect(t.turns).toBe(1);
    expect(await readFile(join(t.worktreePath!, "a.txt"), "utf8")).toBe("from the agent\n");
    expect(git(repo.path, "rev-list", "--count", `main..${t.branch}`).trim()).toBe("0");
    expect(git(t.worktreePath!, "status", "--porcelain")).toMatch(/a\.txt/);
  });

  it("usage keeps the latest running totals", async () => {
    const { store, runner, create } = await setup([
      { event: { type: "usage", inputTokens: 10, outputTokens: 2, costUsd: 0.1 } },
      { event: { type: "usage", inputTokens: 30, outputTokens: 5, costUsd: 0.4 } },
      done,
    ]);
    const task = await create();
    await runner.idle();

    const t = store.getTask(task.id)!;
    expect([t.inputTokens, t.outputTokens, t.costUsd]).toEqual([30, 5, 0.4]);
  });

  it("stores the session id and publishes every agent event", async () => {
    const { store, runner, create, events } = await setup([
      { event: { type: "session", sessionId: "s-1" } },
      { event: { type: "text", text: "hi" } },
      done,
    ]);
    const task = await create();
    await runner.idle();

    expect(store.getTask(task.id)!.sessionId).toBe("s-1");
    const agentEvents = events.flatMap((e) =>
      e.payload.kind === "agent.event" ? [e.payload.event.type] : [],
    );
    expect(agentEvents).toEqual(["session", "text", "done"]);
  });

  it("rejects bypass without opt-in and unknown repos", async () => {
    const { store, create, runner } = await setup([done]);
    await expect(create({ permissionMode: "bypass" })).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
    await expect(runner.create({ repoId: "nope", prompt: "x" })).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      message: expect.stringContaining("coord repo add"),
    });
    await expect(runner.create({ repoPath: "/no/such/repo", prompt: "x" })).rejects.toBeInstanceOf(
      RunnerError,
    );
    await expect(create({ agent: "codex" })).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(store.listTasks()).toEqual([]);
  });

  it("validates a requested branch and uses it", async () => {
    const { store, runner, create } = await setup([done]);
    await expect(create({ branch: "agent/a..b" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(create({ branch: "main" })).rejects.toMatchObject({ code: "invalid_request" });
    const task = await create({ branch: "agent/feature/x" });
    await runner.idle();

    const t = store.getTask(task.id)!;
    expect(t.status).toBe("review");
    expect(t.branch).toBe("agent/feature/x");
    expect(t.worktreePath).toMatch(/\/feature-x$/);
    await expect(create({ branch: "agent/feature/x" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("passes model, permission mode and port env to the adapter", async () => {
    const { store, runner, adapter, create } = await setup([done]);
    const task = await create({ model: "opus", permissionMode: "accept_edits" });
    await runner.idle();

    const spec = adapter.calls.start[0]!;
    expect(spec.model).toBe("opus");
    expect(spec.permissionMode).toBe("accept_edits");
    expect(spec.env?.COORD_PORT_BASE).toBe("41000");
    expect(spec.env?.COORD_TASK_ID).toBe(task.id);
    expect(spec.prompt).toBe("Fix it\nwith more detail");
    expect(store.getTask(task.id)!.portBase).toBe(41000);
  });

  it("a task parked by a failed commit holds no concurrency slot", async () => {
    const gitEnv = await noIdentityGitEnv();
    const { repo, store, broker, runner, create } = await setup([{ permission }, editA, done], {
      maxConcurrent: 1,
      gitEnv,
    });
    const a = await create();
    const b = await create();
    await vi.waitFor(() => expect(store.getTask(a.id)!.status).toBe("needs_input"));
    broker.answer(broker.pending(a.id)[0]!.id, { allow: true });

    // A's commit fails and it parks in needs_input with no agent; B gets the only slot (spec §5).
    await vi.waitFor(() => expect(broker.pending(b.id)).toHaveLength(1));
    const parked = store.getTask(a.id)!;
    expect(parked.status).toBe("needs_input");
    expect(parked.error).toMatch(/^commit failed: /);

    // The runner reads gitEnv at commit time: give B's commit an identity.
    Object.assign(gitEnv, repo.env);
    broker.answer(broker.pending(b.id)[0]!.id, { allow: true });
    await runner.idle();

    expect(store.getTask(b.id)!.status).toBe("review");
    expect(store.getTask(a.id)!.status).toBe("needs_input");
  });

  it("branches from the config's baseBranch and runs that branch's setup", async () => {
    const { repo, store, runner, create } = await setup([done], {
      config: { baseBranch: "dev", setup: ["echo main > setup-ran.txt"] },
    });
    const g = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo.path, env: { ...process.env, ...repo.env }, encoding: "utf8" });
    g("switch", "-c", "dev");
    await writeFile(
      join(repo.path, ".coord/config.json"),
      JSON.stringify({ setup: ["echo dev > setup-ran.txt"] }),
    );
    await writeFile(join(repo.path, "dev-only.txt"), "dev\n");
    g("add", "-A");
    g("-c", "commit.gpgsign=false", "commit", "-m", "dev");
    g("switch", "main");

    const task = await create();
    await runner.idle();

    const t = store.getTask(task.id)!;
    expect(t.status).toBe("review");
    expect(t.baseBranch).toBe("dev");
    expect(g("merge-base", t.branch!, "dev")).toBe(g("rev-parse", "dev"));
    expect(existsSync(join(t.worktreePath!, "dev-only.txt"))).toBe(true);
    expect(await readFile(join(t.worktreePath!, "setup-ran.txt"), "utf8")).toBe("dev\n");
  });

  it("an explicit baseBranch wins over the config's", async () => {
    const { repo, store, runner, create } = await setup([done], { config: { baseBranch: "dev" } });
    execFileSync("git", ["branch", "dev"], { cwd: repo.path });
    execFileSync("git", ["branch", "other"], { cwd: repo.path });
    const task = await create({ baseBranch: "other" });
    await runner.idle();

    expect(store.getTask(task.id)!.baseBranch).toBe("other");
  });
});
