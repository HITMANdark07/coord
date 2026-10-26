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
