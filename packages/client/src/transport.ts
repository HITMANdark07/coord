import {
  DEFAULT_DAEMON_PORT,
  ErrorBody,
  EVENTS_SUBPROTOCOL,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TOKEN_SUBPROTOCOL_PREFIX,
  type ErrorCode,
} from "@wto/protocol";

/** URL of a daemon on this machine. Node callers pass `process.env.WTO_PORT`. */
export function localDaemonUrl(port: string | number = DEFAULT_DAEMON_PORT): string {
  return `http://127.0.0.1:${port}`;
}

export const DEFAULT_DAEMON_URL = localDaemonUrl();

export interface TransportRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}

export type ConnectionStatus = "open" | "closed";

export interface EventHandlers {
  /** A pushed event, unvalidated (the client validates). */
  onEvent(event: unknown): void;
  /** Connection changes; after "open", callers should refetch what they may have missed. */
  onStatus?(status: ConnectionStatus): void;
}

/**
 * How a client reaches the daemon. Implementations: local HTTP + WebSocket (CLI, MCP server,
 * desktop main, web in dev), Electron IPC (desktop renderer), encrypted relay (mobile, PWA; Phase 4).
 */
export interface Transport {
  /** Resolves with the parsed JSON body; rejects with DaemonError. */
  request(req: TransportRequest): Promise<unknown>;
  /** Opens the daemon's event stream. Returns a function that closes it. */
  subscribe(handlers: EventHandlers): () => void;
}

export class DaemonError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

export interface HttpTransportOptions {
  baseUrl?: string;
  /** The daemon's auth token (see @wto/local-daemon). Omit only when a proxy adds it. */
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  reconnectDelayMs?: number;
}

export function httpTransport(options: HttpTransportOptions = {}): Transport {
  const baseUrl = options.baseUrl ?? DEFAULT_DAEMON_URL;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetchImpl = options.fetch ?? fetch;

  return {
    async request({ method, path, body }) {
      const context = `${method} ${path}`;
      // Manual timeout (AbortSignal.timeout is missing in some React Native versions). It covers
      // reading the body too, so a daemon that stalls mid-response can't hang the caller.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let status: number;
      let text: string;
      try {
        const res = await fetchImpl(`${baseUrl}${path}`, {
          method,
          signal: controller.signal,
          headers: {
            [PROTOCOL_HEADER]: PROTOCOL_VERSION,
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        status = res.status;
        text = await res.text();
      } catch (err) {
        const reason = controller.signal.aborted ? `timed out after ${timeoutMs}ms` : String(err);
        throw new DaemonError(0, "unavailable", `${context}: daemon unreachable (${reason})`);
      } finally {
        clearTimeout(timer);
      }
      if (status < 200 || status >= 300) throw toDaemonError(status, text, context);
      if (!text) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        throw new DaemonError(status, "internal", `${context}: response is not JSON`);
      }
    },

    subscribe({ onEvent, onStatus }) {
      const WS = options.WebSocket ?? WebSocket;
      const url = `${baseUrl.replace(/^http/, "ws")}/events?protocol=${PROTOCOL_VERSION}`;
      const protocols = options.token
        ? [EVENTS_SUBPROTOCOL, `${TOKEN_SUBPROTOCOL_PREFIX}${options.token}`]
        : [EVENTS_SUBPROTOCOL];
      let socket: WebSocket | undefined;
      let closed = false;
      let retry: ReturnType<typeof setTimeout> | undefined;

      const connect = () => {
        socket = new WS(url, protocols);
        socket.onopen = () => onStatus?.("open");
        socket.onmessage = (msg) => {
          try {
            onEvent(JSON.parse(String(msg.data)));
          } catch {
            // Not JSON: ignore the frame rather than kill the subscription.
          }
        };
        socket.onclose = () => {
          if (closed) return;
          onStatus?.("closed");
          // The status handler may have unsubscribed (e.g. to reconnect with a new token itself).
          if (closed) return;
          retry = setTimeout(connect, options.reconnectDelayMs ?? 2_000);
        };
      };
      connect();

      return () => {
        closed = true;
        clearTimeout(retry);
        socket?.close();
      };
    },
  };
}

/** Turns a non-2xx response body into a DaemonError, keeping the daemon's error code when present. */
export function toDaemonError(status: number, text: string, context: string): DaemonError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const body = ErrorBody.safeParse(parsed);
  return body.success
    ? new DaemonError(status, body.data.code, `${context}: ${body.data.message}`)
    : new DaemonError(status, status === 404 ? "not_found" : "internal", `${context} failed (${status})`);
}
