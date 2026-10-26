import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type CoordClient } from "@coord/client";
import { fakeTransport } from "@coord/client/testing";
import type { TransportRequest } from "@coord/client";
import { buildProgram } from "./program";

const health = { ok: true, protocolVersion: "0.1.0", daemonVersion: "0.1.0" };

async function run(client: CoordClient, ...args: string[]) {
  const lines: string[] = [];
  await buildProgram(client, { log: (l) => lines.push(l), readToken: async () => "tok" }).parseAsync(args, {
    from: "user",
  });
  return lines;
}

const task = (id: string, status = "running", title = "A task") => ({
  id,
  repoId: "r1",
  repoPath: "/abs/repo",
  title,
  prompt: "x",
  agent: "claude-code",
  status,
  branch: null,
  worktreePath: null,
  sessionId: null,
  costUsd: 0,
  createdAt: "2026-10-26T00:00:00.000Z",
});
const ID_A = "aaaa1111-0000-4000-8000-000000000001";
const ID_B = "aaaa2222-0000-4000-8000-000000000002";
const ID_C = "bbbb3333-0000-4000-8000-000000000003";
const updated = (id: string, status: string, seq = 1) =>
  ({
    seq,
    at: "2026-10-26T00:00:00.000Z",
    payload: { kind: "task.updated", task: task(id, status) },
    // The fixture is a partial Task: the client's schema fills the rest in, the fake transport doesn't.
  }) as unknown as Parameters<ReturnType<typeof fakeTransport>["emit"]>[0];

/** A daemon that lists the three tasks above and answers everything else with `rest`. */
const daemon = (rest: (req: TransportRequest) => unknown = () => task(ID_A)) =>
  fakeTransport((req) =>
    req.method === "GET" && req.path.startsWith("/tasks?") ? [task(ID_A), task(ID_B), task(ID_C)] : rest(req),
  );

/** Runs `coord watch`, resolving with its exit code and output once it finishes. */
async function watch(transport: ReturnType<typeof daemon>, id: string, act?: () => void) {
  const lines: string[] = [];
  let code: number | undefined;
  const finished = new Promise<void>((resolveDone) => {
    const program = buildProgram(createClient(transport), {
      log: (l) => lines.push(l),
      exit: (c) => {
        code = c;
        resolveDone();
      },
    });
    void program.parseAsync(["watch", id], { from: "user" });
  });
  // Let the command subscribe and read the task before acting.
  await vi.waitFor(() => expect(transport.subscribeCalls).toBe(1));
  await vi.waitFor(() => expect(transport.requests.some((r) => r.path === `/tasks/${ID_A}`)).toBe(true));
  act?.();
  await finished;
  return { code, lines };
}

describe("coord cli", () => {
  const initCwd = process.env.INIT_CWD;
  afterEach(() => {
    if (initCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = initCwd;
  });

  it("prints daemon status", async () => {
    expect(await run(createClient(fakeTransport(() => health)), "status")).toEqual([
      "daemon 0.1.0 · protocol 0.1.0",
    ]);
  });

  it("prints the web app link with the token in the URL fragment", async () => {
    expect(await run(createClient(fakeTransport(() => [])), "web")).toEqual([
      "http://localhost:5173/#token=tok",
    ]);
  });

  it("says when there are no tasks", async () => {
    expect(await run(createClient(fakeTransport(() => [])), "ls")).toEqual(["no tasks"]);
  });

  it("resolves --repo against the directory the user ran pnpm from", async () => {
    process.env.INIT_CWD = "/home/me/project";
    const transport = fakeTransport(() => {
      throw new Error("stop");
    });
    await expect(run(createClient(transport), "new", "x", "--repo", "../other")).rejects.toThrow("stop");
    expect((transport.requests[0] as TransportRequest).body).toMatchObject({ repoPath: "/home/me/other" });
  });

  it("new passes agent, model and permission", async () => {
    process.env.INIT_CWD = "/home/me/project";
    const transport = fakeTransport(() => task(ID_A, "queued"));
    const lines = await run(
      createClient(transport),
      "new",
      "do it",
      "--agent",
      "codex",
      "--model",
      "m1",
      "--branch",
      "agent/x",
      "--base",
      "dev",
      "--permission",
      "accept_edits",
    );
    expect(lines).toEqual(["created aaaa1111 (queued)"]);
    expect((transport.requests[0] as TransportRequest).body).toEqual({
      prompt: "do it",
      repoPath: "/home/me/project",
      agent: "codex",
      model: "m1",
      branch: "agent/x",
      baseBranch: "dev",
      permissionMode: "accept_edits",
    });
  });

  it("new refuses bypass and unknown agents before calling the daemon", async () => {
    const transport = fakeTransport(() => task(ID_A));
    for (const args of [
      ["--permission", "bypass"],
      ["--agent", "gpt"],
    ]) {
      const program = buildProgram(createClient(transport), { log: () => {} }).exitOverride();
      program.configureOutput({ writeErr: () => {} });
      for (const c of program.commands) c.exitOverride().configureOutput({ writeErr: () => {} });
      await expect(program.parseAsync(["new", "x", ...args], { from: "user" })).rejects.toThrow();
    }
    expect(transport.requests).toHaveLength(0);
  });

  it("resolves task id prefixes and errors on ambiguity", async () => {
    const transport = daemon();
    const client = createClient(transport);
    // unique prefix
    await run(client, "cancel", "bbbb");
    expect(transport.requests.at(-1)).toMatchObject({ method: "POST", path: `/tasks/${ID_C}/cancel` });
    // exact id wins even though it is also a prefix of nothing else
    await run(client, "cancel", ID_A);
    expect(transport.requests.at(-1)).toMatchObject({ path: `/tasks/${ID_A}/cancel` });
    // ambiguous: lists the candidates
    await expect(run(client, "cancel", "aaaa")).rejects.toThrow(
      new RegExp(`ambiguous[^]*${ID_A}[^]*${ID_B}`),
    );
    // too short, and unknown
    await expect(run(client, "cancel", "aaa")).rejects.toThrow(/at least 4/);
    await expect(run(client, "cancel", "zzzz")).rejects.toThrow(/no task matches/);
    expect(transport.requests.filter((r) => r.path.endsWith("/cancel"))).toHaveLength(2);
  });

  it("allow --always sends remember; deny sends the reason", async () => {
    const transport = fakeTransport(() => undefined);
    const client = createClient(transport);
    await run(client, "allow", "p1", "--always");
    expect(transport.requests.at(-1)).toMatchObject({
      path: "/permissions/p1",
      body: { allow: true, remember: true },
    });
    await run(client, "allow", "p2");
    expect((transport.requests.at(-1) as TransportRequest).body).toEqual({ allow: true });
    await run(client, "deny", "p3", "--reason", "no thanks");
    expect(transport.requests.at(-1)).toMatchObject({
      path: "/permissions/p3",
      body: { allow: false, reason: "no thanks" },
    });
  });

  it("watch exits 0 on review and 1 on failed", async () => {
    for (const [status, expected] of [
      ["review", 0],
      ["cancelled", 0],
      ["failed", 1],
    ] as const) {
      const transport = daemon((req) => (req.path === `/tasks/${ID_A}` ? task(ID_A) : undefined));
      const result = await watch(transport, "aaaa1111", () => transport.emit(updated(ID_A, status)));
      expect(result.code).toBe(expected);
      expect(result.lines).toContain(`task ${status}`);
    }
  });

  it("watch ignores other tasks' transitions and unsubscribes when done", async () => {
    const transport = daemon((req) => (req.path === `/tasks/${ID_A}` ? task(ID_A) : undefined));
    const result = await watch(transport, ID_A, () => {
      transport.emit(updated(ID_B, "failed"));
      transport.emit(updated(ID_A, "review", 2));
    });
    expect(result.code).toBe(0);
    transport.emit(updated(ID_A, "failed", 3)); // no listener left: must not throw
  });

  it("watch does not miss a task that finished before it subscribed", async () => {
    const transport = fakeTransport((req) =>
      req.path.startsWith("/tasks?") ? [task(ID_A)] : task(ID_A, "failed"),
    );
    const lines: string[] = [];
    let code: number | undefined;
    await buildProgram(createClient(transport), {
      log: (l) => lines.push(l),
      exit: (c) => (code = c),
    }).parseAsync(["watch", ID_A], { from: "user" });
    expect(code).toBe(1);
    expect(transport.subscribeCalls).toBe(1);
    expect(transport.requests.map((r) => r.path)).toEqual([
      expect.stringContaining("/tasks?"),
      `/tasks/${ID_A}`,
    ]);
  });

  it("watch exits 1 with a message when the connection is lost", async () => {
    const transport = daemon((req) => (req.path === `/tasks/${ID_A}` ? task(ID_A) : undefined));
    const result = await watch(transport, ID_A, () => transport.setStatus("closed"));
    expect(result.code).toBe(1);
    expect(result.lines.at(-1)).toMatch(/connection to the daemon lost/);
  });

  it("show prints status, usage, error, pending permissions and the last 20 events", async () => {
    const events = Array.from({ length: 25 }, (_, n) => ({
      seq: n + 1,
      at: "2026-10-26T00:00:00.000Z",
      payload: { kind: "agent.event", taskId: ID_A, event: { type: "text", text: `step ${n + 1}` } },
    }));
    const transport = daemon((req) => {
      if (req.path === `/tasks/${ID_A}/events`) return events;
      if (req.path.startsWith("/permissions")) {
        return [
          {
            id: "perm-1",
            taskId: ID_A,
            toolUseId: "u",
            tool: "Bash",
            input: {},
            canRemember: true,
            createdAt: "x",
          },
        ];
      }
      return {
        ...task(ID_A, "failed"),
        branch: "agent/a",
        worktreePath: "/wt/a",
        error: "boom",
        inputTokens: 5,
        outputTokens: 7,
        costUsd: 0.5,
      };
    });
    const out = (await run(createClient(transport), "show", "aaaa1111")).join("\n");
    expect(out).toContain("status:   failed");
    expect(out).toContain("agent/a");
    expect(out).toContain("/wt/a");
    expect(out).toContain("5 in / 7 out");
    expect(out).toContain("$0.5000");
    expect(out).toContain("error:    boom");
    expect(out).toContain("perm-1");
    expect(out).toContain("step 25");
    expect(out).toContain("step 6");
    expect(out).not.toContain("step 5\n");
  });

  it("diff prints the patch; repo add registers the resolved path", async () => {
    process.env.INIT_CWD = "/home/me/project";
    const transport = fakeTransport((req) => {
      if (req.path.startsWith("/tasks?")) return [task(ID_A)];
      if (req.path.endsWith("/diff"))
        return { baseRef: "main", files: [], patch: "PATCH-TEXT", truncated: false };
      return {
        id: "r1",
        name: "project",
        path: "/home/me/project",
        defaultBranch: "main",
        remoteUrl: null,
        bypassAllowed: false,
        createdAt: "2026-10-26T00:00:00.000Z",
      };
    });
    const client = createClient(transport);
    expect(await run(client, "diff", "aaaa")).toEqual(["PATCH-TEXT"]);
    await run(client, "repo", "add");
    expect(transport.requests.at(-1)).toMatchObject({ path: "/repos", body: { path: "/home/me/project" } });
  });
});
