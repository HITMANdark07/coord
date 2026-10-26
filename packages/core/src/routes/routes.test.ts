import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiffView, PermissionRequestView, Repo, Task, type DaemonEvent } from "@coord/protocol";
import type { FakeStep } from "../runner/testing";
import { auth, testDaemon } from "../test-daemon";

type Daemon = Awaited<ReturnType<typeof testDaemon>>;
const open: Daemon[] = [];
async function daemon(script?: FakeStep[]) {
  const d = await testDaemon(script);
  open.push(d);
  return d;
}
const scratch: string[] = [];
async function scratchDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterEach(async () => {
  for (const d of open.splice(0)) await d.close();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

const editA: FakeStep = { edit: { file: "a.txt", content: "from the agent\n" } };
const done: FakeStep = { event: { type: "done" } };
const ask: FakeStep = {
  permission: { toolUseId: "tu-1", tool: "Bash", input: { command: "ls" }, canRemember: true },
};

async function register(d: Daemon) {
  const res = await d.call("POST", "/repos", { path: d.repo.path });
  expect(res.statusCode).toBe(201);
  return Repo.parse(res.json());
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

describe("repo routes", () => {
  it("repo registration rejects a non-git path with invalid_request", async () => {
    const d = await daemon();
    const dir = await scratchDir("coord-notgit-");
    const res = await d.call("POST", "/repos", { path: dir });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_request" });
    const missing = await d.call("POST", "/repos", { path: join(dir, "missing") });
    expect(missing.statusCode).toBe(400);
  });

  it("registers, lists and reads a repo; a second spelling of the path is a 409", async () => {
    const d = await daemon();
    const repo = await register(d);
    expect(repo.path).toBe(d.repo.path);
    expect((await d.call("GET", "/repos")).json()).toHaveLength(1);
    expect(Repo.parse((await d.call("GET", `/repos/${repo.id}`)).json()).id).toBe(repo.id);

    const link = join(await scratchDir("coord-link-"), "alias");
    await symlink(d.repo.path, link);
    // A symlink, a dotted path and a subdirectory all name the same repo.
    const sub = join(d.repo.path, "sub");
    await mkdir(sub);
    // Raw strings on purpose: `join` would normalise them back to the canonical path.
    const spellings = [link, `${d.repo.path}/./`, `${d.repo.path}/sub/..`, `${d.repo.path}//`, sub];
    for (const path of spellings) {
      const dup = await d.call("POST", "/repos", { path });
      expect(dup.statusCode, path).toBe(409);
      expect(dup.json()).toMatchObject({ code: "conflict" });
    }
    expect((await d.call("GET", "/repos")).json()).toHaveLength(1);
  });

  it("answers 503 unavailable, not 400, when git itself can't run", async () => {
    const d = await daemon();
    const saved = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const res = await d.call("POST", "/repos", { path: d.repo.path });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "unavailable" });
    } finally {
      process.env.PATH = saved;
    }
  });

  it("answers 404 for an unknown repo and 400 for a relative path", async () => {
    const d = await daemon();
    expect((await d.call("GET", "/repos/nope")).statusCode).toBe(404);
    expect((await d.call("POST", "/repos", { path: "relative" })).statusCode).toBe(400);
  });
});

describe("task routes", () => {
  it("create → events → permission answer → review over HTTP", async () => {
    const d = await daemon([editA, ask, done]);
    const repo = await register(d);

    const created = await d.call("POST", "/tasks", { repoId: repo.id, prompt: "Add a file" });
    expect(created.statusCode).toBe(201);
    const task = Task.parse(created.json());

    await waitFor(() => d.broker.pending(task.id).length === 1);
    const perms = (await d.call("GET", `/permissions?taskId=${task.id}`)).json() as unknown[];
    const [perm] = perms.map((p) => PermissionRequestView.parse(p));
    expect(perm).toMatchObject({ taskId: task.id, tool: "Bash" });
    expect((await d.call("GET", "/permissions?taskId=other")).json()).toEqual([]);
    expect((await d.call("GET", "/permissions")).json()).toHaveLength(1);
    expect((await d.call("GET", `/tasks/${task.id}`)).json()).toMatchObject({ status: "needs_input" });

    expect((await d.call("POST", `/permissions/${perm!.id}`, { allow: "maybe" })).statusCode).toBe(400);
    const answer = await d.call("POST", `/permissions/${perm!.id}`, { allow: true });
    expect(answer.statusCode).toBe(204);
    // A second answer is a conflict; an unknown id is a 404.
    const again = await d.call("POST", `/permissions/${perm!.id}`, { allow: true });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "conflict" });
    const unknown = await d.call("POST", "/permissions/nope", { allow: true });
    expect(unknown.statusCode).toBe(404);

    await d.runner.idle();
    const reviewed = Task.parse((await d.call("GET", `/tasks/${task.id}`)).json());
    expect(reviewed.status).toBe("review");

    const events = (await d.call("GET", `/tasks/${task.id}/events`)).json() as DaemonEvent[];
    const kinds = events.map((e) => e.payload.kind);
    expect(kinds).toContain("task.updated");
    expect(kinds).toContain("permission.requested");
    expect(kinds).toContain("permission.resolved");
    const last = events.at(-1)!.seq;
    expect((await d.call("GET", `/tasks/${task.id}/events?sinceSeq=${last}`)).json()).toEqual([]);
    const since = (await d.call("GET", `/tasks/${task.id}/events?sinceSeq=${events[0]!.seq}`)).json();
    expect(since as unknown[]).toHaveLength(events.length - 1);
    expect((await d.call("GET", `/tasks/${task.id}/events?sinceSeq=abc`)).statusCode).toBe(400);
  });

  it("lists tasks, hiding cancelled ones unless all=1, and filters by repo", async () => {
    const d = await daemon([done]);
    const repo = await register(d);
    const a = Task.parse((await d.call("POST", "/tasks", { repoId: repo.id, prompt: "one" })).json());
    const b = Task.parse((await d.call("POST", "/tasks", { repoId: repo.id, prompt: "two" })).json());
    await d.runner.idle();
    expect((await d.call("POST", `/tasks/${b.id}/discard`)).statusCode).toBe(200);

    const ids = async (qs: string) =>
      ((await d.call("GET", `/tasks${qs}`)).json() as Task[]).map((t) => t.id).sort();
    expect(await ids("")).toEqual([a.id]);
    expect(await ids("?all=1")).toEqual([a.id, b.id].sort());
    expect(await ids(`?repoId=${repo.id}`)).toEqual([a.id]);
    expect(await ids("?repoId=other&all=1")).toEqual([]);
  });

  it("never sends TaskRecord-only fields, on any task route", async () => {
    const d = await daemon([done]);
    const repo = await register(d);
    const created = await d.call("POST", "/tasks", { repoId: repo.id, prompt: "x" });
    const { id } = created.json() as Task;
    await d.runner.idle();
    const bodies = [
      created.json(),
      (await d.call("GET", `/tasks/${id}`)).json(),
      (await d.call("GET", "/tasks")).json(),
      (await d.call("POST", `/tasks/${id}/messages`, { text: "more" })).json(),
    ];
    await d.runner.idle();
    bodies.push((await d.call("POST", `/tasks/${id}/discard`)).json());
    // Event payloads carry tasks too (task.updated).
    const events = (await d.call("GET", `/tasks/${id}/events`)).json() as DaemonEvent[];
    expect(events.some((e) => e.payload.kind === "task.updated")).toBe(true);
    bodies.push(events);
    const text = JSON.stringify(bodies);
    for (const field of ["portBase", "pendingMessage", "discardedAt"]) expect(text).not.toContain(field);
    // The record itself does have them, so the check above is meaningful.
    expect(Object.keys(d.store.getTask(id)!)).toContain("portBase");
  });

  it("wrong-status action is 409 conflict", async () => {
    const d = await daemon([done]);
    const repo = await register(d);
    const { id } = (await d.call("POST", "/tasks", { repoId: repo.id, prompt: "x" })).json() as Task;
    await d.runner.idle();
    // In review there is nothing to interrupt or resume.
    for (const action of ["interrupt", "resume"]) {
      const res = await d.call("POST", `/tasks/${id}/${action}`);
      expect(res.statusCode, action).toBe(409);
      expect(res.json()).toMatchObject({ code: "conflict" });
    }
    expect((await d.call("POST", `/tasks/${id}/cancel`)).statusCode).toBe(200);
    const msg = await d.call("POST", `/tasks/${id}/messages`, { text: "hi" });
    expect(msg.statusCode).toBe(409);
  });

  it("maps validation, unknown ids and runner errors to ErrorBody", async () => {
    const d = await daemon();
    const repo = await register(d);
    const cases: Array<[string, string, unknown, number, string]> = [
      ["POST", "/tasks", { repoId: repo.id, prompt: "" }, 400, "invalid_request"],
      ["POST", "/tasks", { repoId: "nope", prompt: "x" }, 404, "not_found"],
      ["POST", "/tasks", { repoId: repo.id, prompt: "x", permissionMode: "bypass" }, 403, "forbidden"],
      ["GET", "/tasks/nope", undefined, 404, "not_found"],
      ["GET", "/tasks/nope/events", undefined, 404, "not_found"],
      ["GET", "/tasks/nope/diff", undefined, 404, "not_found"],
      ["POST", "/tasks/nope/messages", { text: "x" }, 404, "not_found"],
      ["POST", "/tasks/nope/interrupt", undefined, 404, "not_found"],
      ["POST", "/tasks/nope/cancel", undefined, 404, "not_found"],
      ["POST", "/tasks/nope/discard", undefined, 404, "not_found"],
      ["POST", "/tasks/nope/resume", undefined, 404, "not_found"],
    ];
    for (const [method, url, body, status, code] of cases) {
      const res = await d.call(method as "GET" | "POST", url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(status);
      expect(res.json(), `${method} ${url}`).toMatchObject({ code, message: expect.any(String) });
    }
    const { id } = (await d.call("POST", "/tasks", { repoId: repo.id, prompt: "x" })).json() as Task;
    expect((await d.call("POST", `/tasks/${id}/messages`, { text: "" })).statusCode).toBe(400);
  });

  it("validates query parameters", async () => {
    const d = await daemon();
    for (const url of [
      "/permissions?taskId=a&taskId=b",
      "/tasks?all=yes",
      "/tasks?all=",
      "/tasks?all=1&all=0",
      "/tasks?repoId=a&repoId=b",
    ]) {
      const res = await d.call("GET", url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json()).toMatchObject({ code: "invalid_request" });
    }
    for (const all of ["1", "true", "0", "false"]) {
      expect((await d.call("GET", `/tasks?all=${all}`)).statusCode, all).toBe(200);
    }
  });

  it("does not leak internals on an unexpected failure", async () => {
    const d = await daemon();
    d.store.listRepos = () => {
      throw new Error("secret /internal/path stack");
    };
    const res = await d.call("GET", "/repos");
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: "internal", message: "internal error" });
  });

  it("requires the token on every route", async () => {
    const d = await daemon();
    const routes: Array<[string, string]> = [
      ["GET", "/repos"],
      ["POST", "/repos"],
      ["GET", "/repos/x"],
      ["GET", "/tasks"],
      ["POST", "/tasks"],
      ["GET", "/tasks/x"],
      ["GET", "/tasks/x/events"],
      ["GET", "/tasks/x/diff"],
      ["POST", "/tasks/x/messages"],
      ["POST", "/tasks/x/interrupt"],
      ["POST", "/tasks/x/cancel"],
      ["POST", "/tasks/x/discard"],
      ["POST", "/tasks/x/resume"],
      ["GET", "/permissions"],
      ["POST", "/permissions/x"],
    ];
    const { authorization: _drop, ...noToken } = auth;
    for (const [method, url] of routes) {
      const res = await d.app.inject({ method: method as "GET" | "POST", url, headers: noToken });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe("diff route", () => {
  it("diff endpoint returns the task's changes", async () => {
    const d = await daemon([editA, done]);
    const repo = await register(d);
    const { id } = (await d.call("POST", "/tasks", { repoId: repo.id, prompt: "x" })).json() as Task;
    await d.runner.idle();
    const res = await d.call("GET", `/tasks/${id}/diff`);
    expect(res.statusCode).toBe(200);
    const diff = DiffView.parse(res.json());
    expect(diff.files).toEqual([{ path: "a.txt", status: "added", additions: 1, deletions: 0 }]);
    expect(diff.patch).toContain("+from the agent");
  });

  it("does not fetch: works with an unreachable origin", async () => {
    const d = await daemon([editA, done]);
    const repo = await register(d);
    const { id } = (await d.call("POST", "/tasks", { repoId: repo.id, prompt: "x" })).json() as Task;
    await d.runner.idle();
    // A fetch from this remote would fail; the diff must not touch it.
    execFileSync("git", ["remote", "add", "origin", "/nonexistent/remote.git"], { cwd: d.repo.path });
    const res = await d.call("GET", `/tasks/${id}/diff`);
    expect(res.statusCode).toBe(200);
    expect(DiffView.parse(res.json()).files).toHaveLength(1);
  });

  it("is a 409 conflict when the worktree directory was removed outside coord", async () => {
    const d = await daemon([editA, done]);
    const repo = await register(d);
    const { id } = (await d.call("POST", "/tasks", { repoId: repo.id, prompt: "x" })).json() as Task;
    await d.runner.idle();
    await rm(d.store.getTask(id)!.worktreePath!, { recursive: true, force: true });
    const res = await d.call("GET", `/tasks/${id}/diff`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "conflict", message: expect.stringContaining("worktree") });
  });

  it("is a 409 conflict for a task with no worktree", async () => {
    const d = await daemon();
    const repo = await register(d);
    const task = d.store.insertTask({
      repoId: repo.id,
      repoPath: repo.path,
      title: "t",
      prompt: "p",
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
    });
    const res = await d.call("GET", `/tasks/${task.id}/diff`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "conflict" });
  });
});
