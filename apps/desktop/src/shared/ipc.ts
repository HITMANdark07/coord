import { DaemonError, type ConnectionStatus, type TransportRequest } from "@coord/client";
import type { ErrorBody } from "@coord/protocol";

/** Renderer → main: a daemon request, forwarded by the main process. */
export const DAEMON_REQUEST_CHANNEL = "coord:daemon-request";
/** Main → renderer: daemon push events. */
export const DAEMON_EVENT_CHANNEL = "coord:daemon-event";

/** Renderer → main: ask the user for a folder with the OS dialog; resolves to its path or null. */
export const PICK_FOLDER_CHANNEL = "coord:pick-folder";

const METHODS = new Set<TransportRequest["method"]>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Checks an untrusted renderer message before the main process forwards it to the daemon.
 * The path must be a plain absolute path, so it cannot change the host (e.g. "@evil.com").
 */
export function isDaemonRequest(value: unknown): value is TransportRequest {
  if (typeof value !== "object" || value === null) return false;
  const { method, path } = value as Record<string, unknown>;
  return (
    typeof method === "string" &&
    METHODS.has(method as TransportRequest["method"]) &&
    typeof path === "string" &&
    /^\/[A-Za-z0-9\-._~%/?=&]*$/.test(path) &&
    !path.startsWith("//")
  );
}

/**
 * Errors thrown in an ipcMain handler reach the renderer as a bare message, so the main
 * process returns this envelope and the renderer rebuilds a DaemonError from it.
 */
export type IpcReply = { ok: true; body: unknown } | { ok: false; status: number; error: ErrorBody };

export function toIpcReply(err: unknown): IpcReply {
  if (err instanceof DaemonError)
    return { ok: false, status: err.status, error: { code: err.code, message: err.message } };
  return {
    ok: false,
    status: 0,
    error: { code: "internal", message: err instanceof Error ? err.message : String(err) },
  };
}

export function fromIpcReply(reply: IpcReply): unknown {
  if (reply.ok) return reply.body;
  throw new DaemonError(reply.status, reply.error.code, reply.error.message);
}

/** Main → renderer message: a daemon event or a change in the daemon connection. */
export type DaemonPush = { event: unknown } | { status: ConnectionStatus };

export interface CoordBridge {
  request(req: TransportRequest): Promise<IpcReply>;
  pickFolder(): Promise<string | null>;
  onPush(listener: (push: DaemonPush) => void): () => void;
}
