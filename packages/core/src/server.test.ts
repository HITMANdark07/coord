import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, DaemonError, httpTransport, type WtoClient } from "@wto/client";
import {
  EVENTS_SUBPROTOCOL,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  Task,
  TOKEN_SUBPROTOCOL_PREFIX,
  type DaemonEvent,
} from "@wto/protocol";
import { createServer } from "./server";

const TOKEN = "test-token-0123456789-0123456789-abcdef";
const auth = { [PROTOCOL_HEADER]: PROTOCOL_VERSION, authorization: `Bearer ${TOKEN}` };

describe("daemon API", () => {
  let app: ReturnType<typeof createServer>;
  beforeEach(() => {
    app = createServer({ token: TOKEN });
  });
  afterEach(() => app.close());

  it("reports health without a token or protocol header, even with a query string", async () => {
    for (const url of ["/health", "/health?probe=1"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, protocolVersion: PROTOCOL_VERSION });
    }
  });

  it("creates and lists tasks", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: auth,
      payload: { repoPath: "/repo", prompt: "Add dark mode" },
    });
    expect(created.statusCode).toBe(201);
    const task = Task.parse(created.json());
    expect(task.status).toBe("queued");

    expect((await app.inject({ method: "GET", url: "/tasks", headers: auth })).json()).toHaveLength(1);
    expect(
      (await app.inject({ method: "GET", url: `/tasks/${task.id}`, headers: auth })).json(),
    ).toMatchObject({ id: task.id });
  });

  it.each([
    ["no token", { [PROTOCOL_HEADER]: PROTOCOL_VERSION }],
    ["a wrong token", { [PROTOCOL_HEADER]: PROTOCOL_VERSION, authorization: "Bearer nope" }],
  ])("rejects %s with 401", async (_name, headers) => {
    const res = await app.inject({ method: "GET", url: "/tasks", headers });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "unauthorized" });
  });

  it.each([
    ["invalid input", { payload: { prompt: "" } }, 400, "invalid_request"],
    ["a relative repo path", { payload: { repoPath: "repo", prompt: "x" } }, 400, "invalid_request"],
    [
      "malformed JSON",
      { payload: "{", headers: { "content-type": "application/json" } },
      400,
      "invalid_request",
    ],
    [
      "an unsupported content type",
      { payload: "<x/>", headers: { "content-type": "application/xml" } },
      415,
      "invalid_request",
    ],
  ])("rejects %s with a client error", async (_name, req, status, code) => {
    const res = await app.inject({
      method: "POST",
      url: "/tasks",
      ...req,
      headers: { ...auth, ...("headers" in req ? req.headers : {}) },
    });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ code });
  });

  it("returns a typed 404", async () => {
    const res = await app.inject({ method: "GET", url: "/tasks/nope", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "not_found" });
  });

  it("rejects a missing or incompatible protocol version", async () => {
    const { [PROTOCOL_HEADER]: _omit, ...tokenOnly } = auth;
    expect((await app.inject({ method: "GET", url: "/tasks", headers: tokenOnly })).statusCode).toBe(426);
    const res = await app.inject({
      method: "GET",
      url: "/tasks",
      headers: { ...auth, [PROTOCOL_HEADER]: "9.0.0" },
    });
    expect(res.statusCode).toBe(426);
    expect(res.json()).toMatchObject({ code: "protocol_mismatch" });
  });

  it("blocks DNS rebinding and origins that are not allowed", async () => {
    const status = async (headers: Record<string, string>) =>
      (await app.inject({ method: "GET", url: "/tasks", headers: { ...auth, ...headers } })).statusCode;
    expect(await status({ host: "attacker.example:4545" })).toBe(403);
    expect(await status({ origin: "https://attacker.example" })).toBe(403);
    // Another local page, e.g. an agent-run dev server in a worktree.
    expect(await status({ origin: "http://localhost:3000" })).toBe(403);
    expect(await status({ origin: "http://localhost:5173" })).toBe(200);
  });
});

describe("daemon over a real socket", () => {
  let app: ReturnType<typeof createServer>;
  let baseUrl: string;
  let client: WtoClient;
  beforeEach(async () => {
    app = createServer({ token: TOKEN });
    await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    client = createClient(httpTransport({ baseUrl, token: TOKEN }));
  });
  afterEach(() => app.close());

  /** Opens a raw WebSocket to /events and reports whether the daemon accepted it. */
  function tryEvents(protocols: string[], headers: Record<string, string> = {}) {
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/events?protocol=${PROTOCOL_VERSION}`, {
      protocols,
      headers,
    } as unknown as string[]);
    return new Promise<string>((resolve) => {
      ws.onopen = () => {
        resolve(`open:${ws.protocol}`);
        ws.close();
      };
      ws.onerror = () => resolve("refused");
    });
  }

  it("pushes task updates to subscribed clients", async () => {
    const received = new Promise<DaemonEvent>((resolve) => {
      let created = false;
      const stop = client.subscribe({
        onStatus: (s) => {
          if (s === "open" && !created) {
            created = true;
            void client.createTask({ repoPath: "/repo", prompt: "Add dark mode" });
          }
        },
        onEvent: (event) => {
          stop();
          resolve(event);
        },
      });
    });
    const event = await received;
    expect(event.seq).toBe(1);
    expect(event.payload).toMatchObject({ kind: "task.updated", task: { title: "Add dark mode" } });
  });

  it("authenticates browsers by subprotocol and never echoes the token", async () => {
    expect(await tryEvents([EVENTS_SUBPROTOCOL, `${TOKEN_SUBPROTOCOL_PREFIX}${TOKEN}`])).toBe(
      `open:${EVENTS_SUBPROTOCOL}`,
    );
    expect(await tryEvents([EVENTS_SUBPROTOCOL])).toBe("refused");
    expect(await tryEvents([EVENTS_SUBPROTOCOL, `${TOKEN_SUBPROTOCOL_PREFIX}wrong`])).toBe("refused");
  });

  it("refuses event subscriptions from other websites even with the token", async () => {
    const outcome = await tryEvents([EVENTS_SUBPROTOCOL, `${TOKEN_SUBPROTOCOL_PREFIX}${TOKEN}`], {
      origin: "https://attacker.example",
    });
    expect(outcome).toBe("refused");
  });

  it("surfaces daemon errors as DaemonError with the error code", async () => {
    const err = await client.getTask("missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect(err).toMatchObject({ status: 404, code: "not_found" });
  });
});
