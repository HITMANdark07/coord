import { describe, expect, it } from "vitest";
import { PROTOCOL_HEADER, PROTOCOL_VERSION, type Task } from "@coord/protocol";
import { createClient } from "./client";
import { fakeTransport } from "./testing";
import { DaemonError, httpTransport } from "./transport";

const task: Task = {
  id: "t1",
  repoId: "",
  repoPath: "/repo",
  title: "Add dark mode",
  prompt: "Add dark mode",
  agent: "claude-code",
  status: "queued",
  branch: null,
  baseBranch: null,
  model: null,
  permissionMode: "ask",
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
  error: null,
  updatedAt: "2026-10-26T00:00:00.000Z",
  worktreePath: null,
  sessionId: null,
  costUsd: 0,
  createdAt: "2026-10-26T00:00:00.000Z",
};

describe("createClient", () => {
  it("validates responses against the protocol", async () => {
    const transport = fakeTransport((req) =>
      req.path === "/health"
        ? { ok: true, protocolVersion: PROTOCOL_VERSION, daemonVersion: "0.1.0" }
        : [task],
    );
    const client = createClient(transport);

    await expect(client.health()).resolves.toMatchObject({ ok: true });
    await expect(client.listTasks()).resolves.toHaveLength(1);
    expect(transport.requests.map((r) => r.path)).toEqual(["/health", "/tasks"]);
  });

  it("rejects malformed responses", async () => {
    await expect(createClient(fakeTransport(() => ({ ok: "yes" }))).health()).rejects.toThrow();
  });

  it("applies schema defaults and validation before sending", async () => {
    const transport = fakeTransport(() => task);
    await createClient(transport).createTask({ repoPath: "/repo", prompt: "Add dark mode" });
    expect(transport.requests[0]?.body).toMatchObject({ agent: "claude-code" });
    await expect(createClient(transport).createTask({ repoPath: "relative", prompt: "x" })).rejects.toThrow(
      /absolute/,
    );
  });

  it("delivers valid pushed events and drops invalid ones", () => {
    const transport = fakeTransport(() => undefined);
    const seen: number[] = [];
    const stop = createClient(transport).subscribe({ onEvent: (e) => seen.push(e.seq) });
    transport.emit({ seq: 1, at: "2026-10-26T00:00:00.000Z", payload: { kind: "task.updated", task } });
    (transport.emit as (e: unknown) => void)({ seq: "bad" });
    stop();
    transport.emit({ seq: 2, at: "2026-10-26T00:00:00.000Z", payload: { kind: "task.updated", task } });
    expect(seen).toEqual([1]);
  });

  it("shares one upstream connection between all subscribers", () => {
    const transport = fakeTransport(() => undefined);
    const client = createClient(transport);
    const stops = [client.subscribe({}), client.subscribe({}), client.subscribe({})];
    expect(transport.subscribeCalls).toBe(1);
    for (const stop of stops) stop();
    client.subscribe({});
    expect(transport.subscribeCalls).toBe(2);
  });

  it("tells late subscribers the connection is already open", () => {
    const transport = fakeTransport(() => undefined);
    const client = createClient(transport);
    client.subscribe({});
    transport.setStatus("open");
    const statuses: string[] = [];
    client.subscribe({ onStatus: (s) => statuses.push(s) });
    expect(statuses).toEqual(["open"]);
  });

  it("reads a task with a status from a newer daemon as unknown", async () => {
    const client = createClient(fakeTransport(() => [{ ...task, status: "paused-by-future-feature" }]));
    const [read] = await client.listTasks();
    expect(read?.status).toBe("unknown");
  });
});

const repo = {
  id: "r1",
  name: "repo",
  path: "/repo",
  defaultBranch: "main",
  remoteUrl: null,
  bypassAllowed: false,
  createdAt: "2026-10-26T00:00:00.000Z",
};
const diff = {
  baseRef: "main",
  files: [{ path: "a", status: "added", additions: 1, deletions: 0 }],
  patch: "",
  truncated: false,
};
const permission = {
  id: "p1",
  taskId: "t1",
  toolUseId: "tu",
  tool: "Bash",
  input: {},
  canRemember: false,
  createdAt: "2026-10-26T00:00:00.000Z",
};
const event = { seq: 1, at: "2026-10-26T00:00:00.000Z", payload: { kind: "task.updated", task } };

describe("createClient API methods", () => {
  /** Each case: how the method is called, the request it sends, the reply it validates. */
  const cases: Array<{
    name: string;
    call: (c: ReturnType<typeof createClient>) => Promise<unknown>;
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    reply: unknown;
    expected?: unknown;
    bad: unknown;
  }> = [
    {
      name: "listRepos",
      call: (c) => c.listRepos(),
      method: "GET",
      path: "/repos",
      reply: [repo],
      bad: [{ id: 1 }],
    },
    {
      name: "addRepo",
      call: (c) => c.addRepo("/repo"),
      method: "POST",
      path: "/repos",
      body: { path: "/repo" },
      reply: repo,
      bad: {},
    },
    {
      name: "listTasks",
      call: (c) => c.listTasks(),
      method: "GET",
      path: "/tasks",
      reply: [task],
      bad: [{}],
    },
    {
      name: "listTasks with a filter",
      call: (c) => c.listTasks({ repoId: "r 1", all: true }),
      method: "GET",
      path: "/tasks?repoId=r%201&all=1",
      reply: [task],
      bad: [{}],
    },
    {
      name: "getTask",
      call: (c) => c.getTask("t/1"),
      method: "GET",
      path: "/tasks/t%2F1",
      reply: task,
      bad: {},
    },
    {
      name: "taskEvents",
      call: (c) => c.taskEvents("t1"),
      method: "GET",
      path: "/tasks/t1/events",
      reply: [event],
      bad: [{ seq: "x" }],
    },
    {
      name: "taskEvents since",
      call: (c) => c.taskEvents("t1", 7),
      method: "GET",
      path: "/tasks/t1/events?sinceSeq=7",
      reply: [event],
      bad: [{ seq: "x" }],
    },
    {
      name: "taskDiff",
      call: (c) => c.taskDiff("t1"),
      method: "GET",
      path: "/tasks/t1/diff",
      reply: diff,
      bad: {},
    },
    {
      name: "sendMessage",
      call: (c) => c.sendMessage("t1", "hi"),
      method: "POST",
      path: "/tasks/t1/messages",
      body: { text: "hi" },
      reply: task,
      bad: {},
    },
    {
      name: "interrupt",
      call: (c) => c.interrupt("t1"),
      method: "POST",
      path: "/tasks/t1/interrupt",
      reply: task,
      bad: {},
    },
    {
      name: "cancel",
      call: (c) => c.cancel("t1"),
      method: "POST",
      path: "/tasks/t1/cancel",
      reply: task,
      bad: {},
    },
    {
      name: "discard",
      call: (c) => c.discard("t1"),
      method: "POST",
      path: "/tasks/t1/discard",
      reply: task,
      bad: {},
    },
    {
      name: "resumeTask",
      call: (c) => c.resumeTask("t1"),
      method: "POST",
      path: "/tasks/t1/resume",
      reply: task,
      bad: {},
    },
    {
      name: "listPermissions",
      call: (c) => c.listPermissions(),
      method: "GET",
      path: "/permissions",
      reply: [permission],
      bad: [{}],
    },
    {
      name: "listPermissions for a task",
      call: (c) => c.listPermissions("t1"),
      method: "GET",
      path: "/permissions?taskId=t1",
      reply: [permission],
      bad: [{}],
    },
    {
      name: "answerPermission",
      call: (c) => c.answerPermission("p1", { allow: true }),
      method: "POST",
      path: "/permissions/p1",
      body: { allow: true },
      reply: undefined,
      bad: undefined,
    },
  ];

  it.each(cases)("$name sends $method $path and validates the reply", async (c) => {
    const transport = fakeTransport(() => c.reply);
    await c.call(createClient(transport));
    expect(transport.requests).toEqual([
      { method: c.method, path: c.path, ...(c.body === undefined ? {} : { body: c.body }) },
    ]);
  });

  it.each(cases.filter((c) => c.reply !== undefined))("$name rejects a malformed reply", async (c) => {
    await expect(c.call(createClient(fakeTransport(() => c.bad)))).rejects.toThrow();
  });

  it("validates request bodies before sending", async () => {
    const transport = fakeTransport(() => repo);
    await expect(createClient(transport).addRepo("relative")).rejects.toThrow(/absolute/);
    await expect(createClient(transport).sendMessage("t1", "")).rejects.toThrow();
    await expect(createClient(transport).answerPermission("p1", { allow: "yes" } as never)).rejects.toThrow();
    expect(transport.requests).toEqual([]);
  });
});

describe("httpTransport", () => {
  it("sends the protocol version on every request", async () => {
    let headers: HeadersInit | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      headers = init.headers;
      return new Response("[]");
    }) as typeof fetch;
    await httpTransport({ baseUrl: "http://daemon", fetch: fakeFetch }).request({
      method: "GET",
      path: "/tasks",
    });
    expect(headers).toMatchObject({ [PROTOCOL_HEADER]: PROTOCOL_VERSION });
  });

  it("keeps the daemon's error code", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ code: "not_found", message: "task x not found" }), {
        status: 404,
      })) as typeof fetch;
    const err = await httpTransport({ baseUrl: "http://daemon", fetch: fakeFetch })
      .request({ method: "GET", path: "/tasks/x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect(err).toMatchObject({ status: 404, code: "not_found" });
  });

  it("sends the auth token when it has one", async () => {
    let headers: HeadersInit | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      headers = init.headers;
      return new Response("[]");
    }) as typeof fetch;
    await httpTransport({ baseUrl: "http://daemon", token: "s3cret", fetch: fakeFetch }).request({
      method: "GET",
      path: "/tasks",
    });
    expect(headers).toMatchObject({ authorization: "Bearer s3cret" });
  });

  it("times out while the body is still streaming", async () => {
    const stalledBody = ((_url: string, init: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("["));
              init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
            },
          }),
        ),
      )) as typeof fetch;
    const err = await httpTransport({ baseUrl: "http://daemon", fetch: stalledBody, timeoutMs: 20 })
      .request({ method: "GET", path: "/tasks" })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unavailable", message: expect.stringContaining("timed out") });
  });

  it("rejects a non-JSON success body with DaemonError", async () => {
    const fakeFetch = (async () => new Response("<html>")) as typeof fetch;
    const err = await httpTransport({ baseUrl: "http://daemon", fetch: fakeFetch })
      .request({ method: "GET", path: "/tasks" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
  });

  it("times out instead of hanging", async () => {
    const neverAnswers = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      )) as typeof fetch;
    const err = await httpTransport({ baseUrl: "http://daemon", fetch: neverAnswers, timeoutMs: 20 })
      .request({ method: "GET", path: "/health" })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unavailable", message: expect.stringContaining("timed out") });
  });
});
