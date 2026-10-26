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
const updated = (id: string, status: string, seq = 1, over: Record<string, unknown> = {}) =>
  ({
    seq,
    at: "2026-10-26T00:00:00.000Z",
    payload: { kind: "task.updated", task: { ...task(id, status), ...over } },
    // The fixture is a partial Task: the client's schema fills the rest in, the fake transport doesn't.
  }) as unknown as Parameters<ReturnType<typeof fakeTransport>["emit"]>[0];

/** A daemon that lists the three tasks above and answers everything else with `rest`. */
const daemon = (rest: (req: TransportRequest) => unknown = () => task(ID_A)) =>
  fakeTransport(
    (req) =>
      req.method === "GET" && req.path.startsWith("/tasks?")
        ? [task(ID_A), task(ID_B), task(ID_C)]
        : rest(req),
    // Like a real socket: nothing is delivered before it opens.
    { gateEvents: true },
  );

const PERM_A = "dddd1111-0000-4000-8000-00000000000a";
const PERM_B = "dddd2222-0000-4000-8000-00000000000b";
const PERM_C = "cccc3333-0000-4000-8000-00000000000c";
const permission = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  taskId: ID_A,
  toolUseId: "u",
  tool: "Bash",
  input: { command: "ls" },
  canRemember: true,
  createdAt: "2026-10-26T00:00:00.000Z",
  ...over,
});
/** A daemon with three pending permission requests (or `pending`); answers are accepted (204). */
const permissionDaemon = (pending = [permission(PERM_A), permission(PERM_B), permission(PERM_C)]) =>
  fakeTransport((req) => (req.method === "GET" && req.path.startsWith("/permissions") ? pending : undefined));
const requested = (request: ReturnType<typeof permission>, seq = 1) =>
  ({
    seq,
    at: "2026-10-26T00:00:00.000Z",
    payload: { kind: "permission.requested", request },
  }) as unknown as Parameters<ReturnType<typeof fakeTransport>["emit"]>[0];

/**
 * Runs `coord watch` against a gated transport. `beforeOpen` runs once the command has subscribed
 * but before the socket opens; `act` runs after it opened and the task was read.
 */
async function watch(
  transport: ReturnType<typeof daemon>,
  id: string,
  { beforeOpen, act }: { beforeOpen?: () => void; act?: () => void } = {},
) {
  const lines: string[] = [];
  const errors: string[] = [];
  let code: number | undefined;
  const finished = new Promise<void>((resolveDone) => {
    const program = buildProgram(createClient(transport), {
      log: (l) => lines.push(l),
      logError: (l) => errors.push(l),
      exit: (c) => {
        code = c;
        resolveDone();
      },
    });
    void program.parseAsync(["watch", id], { from: "user" });
  });
  await vi.waitFor(() => expect(transport.subscribeCalls).toBe(1));
  // The task is read only once the socket is open, never before.
  expect(transport.requests.some((r) => r.path === `/tasks/${ID_A}`)).toBe(false);
  beforeOpen?.();
  transport.setStatus("open");
  await vi.waitFor(() => expect(transport.requests.some((r) => r.path === `/tasks/${ID_A}`)).toBe(true));
  act?.();
  await finished;
  return { code, lines, errors };
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
    const transport = permissionDaemon();
    const client = createClient(transport);
    await run(client, "allow", PERM_A, "--always");
    expect(transport.requests.at(-1)).toMatchObject({
      path: `/permissions/${PERM_A}`,
      body: { allow: true, remember: true },
    });
    await run(client, "allow", PERM_B);
    expect((transport.requests.at(-1) as TransportRequest).body).toEqual({ allow: true });
    await run(client, "deny", PERM_C, "--reason", "no thanks");
    expect(transport.requests.at(-1)).toMatchObject({
      path: `/permissions/${PERM_C}`,
      body: { allow: false, reason: "no thanks" },
    });
  });

  it("allow and deny echo what they answered", async () => {
    const transport = permissionDaemon([
      permission(PERM_A, { input: { command: "git push --force" } }),
      permission(PERM_C, { tool: "Write", input: { file_path: "/w/src/a.ts", content: "x" } }),
    ]);
    const client = createClient(transport);
    expect(await run(client, "allow", "dddd", "--always")).toEqual([
      `allowed ${PERM_A} (always): Bash git push --force`,
    ]);
    expect(await run(client, "deny", "cccc")).toEqual([`denied ${PERM_C}: Write /w/src/a.ts`]);
  });

  it("allow and deny resolve permission id prefixes like task ids", async () => {
    const transport = permissionDaemon();
    const client = createClient(transport);
    await run(client, "allow", "cccc");
    expect(transport.requests.at(-1)).toMatchObject({ method: "POST", path: `/permissions/${PERM_C}` });
    await run(client, "deny", "dddd1");
    expect(transport.requests.at(-1)).toMatchObject({ method: "POST", path: `/permissions/${PERM_A}` });
    const answers = () => transport.requests.filter((r) => r.method === "POST").length;
    await expect(run(client, "allow", "dddd")).rejects.toThrow(
      new RegExp(`ambiguous[^]*${PERM_A}[^]*${PERM_B}`),
    );
    await expect(run(client, "deny", "ddd")).rejects.toThrow(/at least 4/);
    await expect(run(client, "allow", "zzzz")).rejects.toThrow(/no pending permission matches/);
    expect(answers()).toBe(2);
  });

  it("watch exits 0 on review and 1 on failed", async () => {
    for (const [status, expected] of [
      ["review", 0],
      ["cancelled", 0],
      ["failed", 1],
    ] as const) {
      const transport = daemon((req) => (req.path === `/tasks/${ID_A}` ? task(ID_A) : undefined));
      const result = await watch(transport, "aaaa1111", {
        act: () => transport.emit(updated(ID_A, status)),
      });
      expect(result.code).toBe(expected);
      expect(result.lines).toContain(`task ${status}`);
    }
  });

  it("watch ignores other tasks' transitions and unsubscribes when done", async () => {
    const transport = daemon((req) => (req.path === `/tasks/${ID_A}` ? task(ID_A) : undefined));
    const result = await watch(transport, ID_A, {
      act: () => {
        transport.emit(updated(ID_B, "failed"));
        transport.emit(updated(ID_A, "review", 2));
      },
    });
    expect(result.code).toBe(0);
    transport.emit(updated(ID_A, "failed", 3)); // no listener left: must not throw
  });

  it("watch sees a transition that happened before the socket opened, through the snapshot", async () => {
    let current = "running";
    const transport = daemon((req) => (req.path === `/tasks/${ID_A}` ? task(ID_A, current) : undefined));
    const result = await watch(transport, ID_A, {
      beforeOpen: () => {
        current = "review";
        transport.emit(updated(ID_A, "review")); // lost: the socket is not open yet
      },
    });
    expect(result.code).toBe(0);
    expect(result.lines).toContain("task review");
  });

  it("watch exits at once for a task that already finished", async () => {
    const transport = daemon((req) => (req.path === `/tasks/${ID_A}` ? task(ID_A, "failed") : undefined));
    const result = await watch(transport, ID_A);
    expect(result.code).toBe(1);
  });

  it("watch exits 1 with a hint, on stderr, for an interrupted task", async () => {
    const snapshot = daemon((req) => (req.path === `/tasks/${ID_A}` ? task(ID_A, "interrupted") : undefined));
    const a = await watch(snapshot, ID_A);
    expect(a.code).toBe(1);
    expect(a.errors.join("\n")).toMatch(/interrupted; resume it with coord resume aaaa1111/);
    expect(a.lines.join("\n")).not.toMatch(/resume it/);

    const live = daemon((req) => (req.path === `/tasks/${ID_A}` ? task(ID_A) : undefined));
    const b = await watch(live, ID_A, { act: () => live.emit(updated(ID_A, "interrupted")) });
    expect(b.code).toBe(1);
    expect(b.errors.join("\n")).toMatch(/coord resume/);
  });

  it("watch prints what a permission prompt asks, and whether --always is offered", async () => {
    const transport = daemon((req) => (req.path === `/tasks/${ID_A}` ? task(ID_A) : undefined));
    const result = await watch(transport, ID_A, {
      act: () => {
        transport.emit(requested(permission(PERM_A, { input: { command: "rm -rf build\nls\tx" } })));
        transport.emit(
          requested(
            permission(PERM_B, {
              tool: "Edit",
              input: { file_path: "/w/src/a.ts", old_string: "x", new_string: "y" },
              canRemember: false,
            }),
            2,
          ),
        );
        transport.emit(
          requested(permission(PERM_C, { tool: "mcp__x__y", input: { q: "a".repeat(300) } }), 3),
        );
        transport.emit(updated(ID_A, "review", 4));
      },
    });
    const [bash, edit, other] = result.lines.filter((l) => l.startsWith("permission "));
    // A newline is shown, not hidden as a space: the second line is a second command.
    expect(bash).toBe(`permission ${PERM_A}: Bash rm -rf build⏎ls x  [--always available]`);
    expect(edit).toBe(`permission ${PERM_B}: Edit /w/src/a.ts`);
    expect(other).toMatch(
      new RegExp(`^permission ${PERM_C}: mcp__x__y \\{"q":"a+…  \\[--always available\\]$`),
    );
    const summary = other!.slice(`permission ${PERM_C}: mcp__x__y `.length, other!.indexOf("  ["));
    expect(summary.length).toBeLessThanOrEqual(120);
  });

  it("permission summaries strip control characters and keep the file name of a long path", async () => {
    const transport = daemon((req) => (req.path === `/tasks/${ID_A}` ? task(ID_A) : undefined));
    const longPath = `/Users/me/.coord/worktrees/repo-1234/${"deep/".repeat(40)}the-file.ts`;
    const result = await watch(transport, ID_A, {
      act: () => {
        // An ESC sequence that would erase the line and show something harmless instead.
        const command = "echo safe\u001b[2K\u001b]0;title\u0007\rrm -rf ~\u009b1A\nls";
        transport.emit(requested(permission(PERM_A, { input: { command }, title: "Run\u001b[8m it" })));
        transport.emit(requested(permission(PERM_B, { tool: "Write", input: { file_path: longPath } }), 2));
        transport.emit(updated(ID_A, "review", 3));
      },
    });
    const [bash, write] = result.lines.filter((l) => l.startsWith("permission "));
    expect(bash).toBe(
      `permission ${PERM_A}: Bash echo safe[2K]0;titlerm -rf ~1A⏎ls (Run[8m it)  [--always available]`,
    );
    expect(result.lines.join("\n")).not.toMatch(/(?!\n)\p{Cc}/u);
    const summary = write!.slice(`permission ${PERM_B}: Write `.length, write!.indexOf("  ["));
    expect(summary.length).toBe(120);
    expect(summary).toMatch(/^\/Users\/me\/.+….+\/deep\/the-file\.ts$/);
  });

  it("permission summaries strip invisible format characters", async () => {
    const transport = daemon((req) => (req.path === `/tasks/${ID_A}` ? task(ID_A) : undefined));
    const result = await watch(transport, ID_A, {
      act: () => {
        // Zero-width and direction marks can hide or reorder part of a command.
        const command = "rm​ -rf‎ ~﻿ ls ";
        transport.emit(requested(permission(PERM_A, { input: { command } })));
        transport.emit(updated(ID_A, "review", 2));
      },
    });
    const bash = result.lines.find((l) => l.startsWith("permission "));
    expect(bash).toBe(`permission ${PERM_A}: Bash rm -rf ~ ls  [--always available]`);
  });

  it("msg says the message waits for the turn end while the agent is working", async () => {
    const after = (status: string) =>
      createClient(
        fakeTransport((req) => (req.path.startsWith("/tasks?") ? [task(ID_A)] : task(ID_A, status))),
      );
    expect(await run(after("running"), "msg", ID_A, "more")).toEqual([
      `queued for ${ID_A.slice(0, 8)}: delivered when the current turn ends`,
    ]);
    expect(await run(after("queued"), "msg", ID_A, "more")).toEqual([`sent to ${ID_A.slice(0, 8)} (queued)`]);
  });

  it("watch exits 1 with the error, on stderr, for a task parked by a failed commit", async () => {
    const parked = { ...task(ID_A, "needs_input"), error: "commit failed: no identity" };
    const noPrompts = (current: () => unknown) =>
      daemon((req) => {
        if (req.path.startsWith("/permissions")) return [];
        return req.path === `/tasks/${ID_A}` ? current() : undefined;
      });
    const snapshot = noPrompts(() => parked);
    const a = await watch(snapshot, ID_A);
    expect(a.code).toBe(1);
    expect(a.errors.join("\n")).toMatch(/commit failed: no identity/);

    const live = noPrompts(() => task(ID_A));
    const b = await watch(live, ID_A, {
      act: () => live.emit(updated(ID_A, "needs_input", 1, { error: parked.error })),
    });
    expect(b.code).toBe(1);
    expect(b.errors.join("\n")).toMatch(/commit failed: no identity/);

    // needs_input with an error but a prompt pending is an agent waiting, not a parked task.
    const waiting = daemon((req) => {
      if (req.path.startsWith("/permissions")) return [permission(PERM_A)];
      return req.path === `/tasks/${ID_A}` ? parked : undefined;
    });
    const c = await watch(waiting, ID_A, {
      // Once watch has looked at the prompts (and stayed), the task moves on.
      act: () =>
        void vi
          .waitFor(() => expect(waiting.requests.some((r) => r.path.startsWith("/permissions"))).toBe(true))
          .then(() => waiting.emit(updated(ID_A, "review", 2))),
    });
    expect(c.code).toBe(0);
    expect(c.errors).toEqual([]);
  });

  it("watch exits 1 with a message on stderr when the connection is lost or the task can't be read", async () => {
    const transport = daemon((req) => (req.path === `/tasks/${ID_A}` ? task(ID_A) : undefined));
    const lost = await watch(transport, ID_A, { act: () => transport.setStatus("closed") });
    expect(lost.code).toBe(1);
    expect(lost.errors.at(-1)).toMatch(/connection to the daemon lost/);
    expect(lost.lines.join("\n")).not.toMatch(/lost/);

    const broken = daemon((req) => {
      if (req.path === `/tasks/${ID_A}`) throw new Error("boom");
      return undefined;
    });
    const failed = await watch(broken, ID_A);
    expect(failed.code).toBe(1);
    expect(failed.errors).toEqual(["boom"]);
  });

  it("new -- passes a prompt that starts with a dash", async () => {
    process.env.INIT_CWD = "/home/me/project";
    const transport = fakeTransport(() => task(ID_A, "queued"));
    await run(createClient(transport), "new", "--", "-x");
    expect((transport.requests[0] as TransportRequest).body).toMatchObject({ prompt: "-x" });
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
            input: { command: "git push --force", description: "Push\u001b[8m\u009b" },
            canRemember: true,
            createdAt: "x",
          },
        ];
      }
      return {
        ...task(ID_A, "failed", "A task\u001b[2J"),
        branch: "agent/a",
        worktreePath: "/wt/a",
        error: "boom\u001b[2J",
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
    expect(out).toContain(`${ID_A}  A task[2J`);
    expect(out).toContain("error:    boom[2J");
    expect(out).toContain("perm-1  Bash  git push --force  [--always available]");
    // The full input under it, as JSON: control characters arrive escaped, never raw.
    expect(out).toContain(
      [
        "      {",
        '        "command": "git push --force",',
        '        "description": "Push\\u001b[8m\\u009b"',
        "      }",
      ].join("\n"),
    );
    expect(out).not.toMatch(/(?!\n)\p{Cc}/u);
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
