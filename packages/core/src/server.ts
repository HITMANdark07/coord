import { timingSafeEqual } from "node:crypto";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import {
  EVENTS_SUBPROTOCOL,
  isCompatibleProtocol,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TOKEN_SUBPROTOCOL_PREFIX,
  type ErrorBody,
  type ErrorCode,
  type Health,
} from "@wto/protocol";
import { EventBus } from "./event-bus";
import { TaskStore } from "./store";

export const DAEMON_VERSION = "0.1.0";

/** Browser origins allowed to call the daemon: the web app's dev and preview servers. */
export const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

const hostnameOf = (hostHeader: string) => hostHeader.replace(/:\d+$/, "").toLowerCase();

function sendError(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
  issues?: unknown[],
) {
  const body: ErrorBody = { code, message, ...(issues ? { issues } : {}) };
  return reply.code(status).send(body);
}

function clientProtocol(req: FastifyRequest): string | undefined {
  const header = req.headers[PROTOCOL_HEADER];
  if (typeof header === "string") return header;
  // Browsers can't set headers on a WebSocket, so /events takes it as a query parameter.
  const query = req.query as Record<string, unknown> | undefined;
  return typeof query?.protocol === "string" ? query.protocol : undefined;
}

/** Bearer header (HTTP, proxies), or a `wto.token.<token>` WebSocket subprotocol (browsers). */
function presentedToken(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  const offered = req.headers["sec-websocket-protocol"];
  return offered
    ?.split(",")
    .map((p) => p.trim())
    .find((p) => p.startsWith(TOKEN_SUBPROTOCOL_PREFIX))
    ?.slice(TOKEN_SUBPROTOCOL_PREFIX.length);
}

function tokensMatch(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ServerOptions {
  /** Every request except /health must present it (see @wto/local-daemon for how clients find it). */
  token: string;
  /** Exact browser origins that may call the daemon. Requests without an Origin are not browsers. */
  allowedOrigins?: string[];
  bus?: EventBus;
  store?: TaskStore;
}

export function createServer(options: ServerOptions) {
  const { token, bus = new EventBus(), store = new TaskStore(bus) } = options;
  const allowedOrigins = new Set(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);

  const app = Fastify({
    logger: process.env.WTO_LOG_LEVEL ? { level: process.env.WTO_LOG_LEVEL } : false,
    bodyLimit: 1024 * 1024,
    // Shutdown must not wait on idle keep-alive or half-open sockets.
    forceCloseConnections: true,
  });

  // The websocket plugin must load first: its own onRequest hook marks upgrade requests so a
  // rejected upgrade's socket gets destroyed. Our hooks and routes live in a scope after it.
  app.register(websocket, {
    options: {
      maxPayload: 64 * 1024,
      // Answer with the events subprotocol only; never echo the token subprotocol back.
      handleProtocols: (offered) => (offered.has(EVENTS_SUBPROTOCOL) ? EVENTS_SUBPROTOCOL : false),
    },
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError)
      return sendError(reply, 400, "invalid_request", "invalid request", err.issues);
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return sendError(reply, status, "invalid_request", err instanceof Error ? err.message : "bad request");
    app.log.error(err);
    return sendError(reply, 500, "internal", "internal error");
  });

  app.setNotFoundHandler((req, reply) =>
    sendError(reply, 404, "not_found", `no route ${req.method} ${req.url}`),
  );

  app.register(async (api) => {
    api.addHook("onRequest", async (req, reply) => {
      // Host must be local: blocks DNS rebinding.
      if (!LOCAL_HOSTNAMES.has(hostnameOf(req.headers.host ?? ""))) {
        return sendError(reply, 403, "forbidden", "only local clients may use the daemon");
      }
      // Browsers must come from an allowed origin: CORS does not protect WebSockets, and any
      // local page (e.g. an agent's dev server in a worktree) could otherwise connect.
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(origin)) {
        return sendError(reply, 403, "forbidden", `origin ${origin} is not allowed`);
      }
      // /health stays open so any client can probe for a daemon and learn its protocol version.
      if (req.routeOptions.url === "/health") return;
      if (!tokensMatch(presentedToken(req), token)) {
        return sendError(reply, 401, "unauthorized", "missing or wrong daemon token");
      }
      const version = clientProtocol(req);
      if (!version || !isCompatibleProtocol(version)) {
        return sendError(
          reply,
          426,
          "protocol_mismatch",
          `client protocol ${version ?? "missing"}, daemon ${PROTOCOL_VERSION}`,
        );
      }
    });

    api.get("/health", async (): Promise<Health> => ({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      daemonVersion: DAEMON_VERSION,
    }));

    api.get("/tasks", async () => store.list());

    api.get<{ Params: { id: string } }>("/tasks/:id", async (req, reply) => {
      const task = store.get(req.params.id);
      return task ?? sendError(reply, 404, "not_found", `task ${req.params.id} not found`);
    });

    api.post("/tasks", async (req, reply) => reply.code(201).send(store.create(req.body)));

    api.get("/events", { websocket: true }, (socket) => {
      const unsubscribe = bus.subscribe((event) => socket.send(JSON.stringify(event)));
      socket.on("close", unsubscribe);
      socket.on("error", () => socket.terminate());
    });
  });

  return app;
}
