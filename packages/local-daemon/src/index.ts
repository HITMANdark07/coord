import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  DaemonError,
  httpTransport,
  localDaemonUrl,
  type HttpTransportOptions,
  type Transport,
} from "@coord/client";
import { DEFAULT_DAEMON_PORT } from "@coord/protocol";

/**
 * How Node clients on this machine find and authenticate to the daemon. The daemon writes
 * `<COORD_HOME>/daemon-<port>.json` (mode 0600) with a random token; only the same OS user can read it.
 */
export const DaemonInfo = z.object({
  port: z.number().int(),
  token: z.string().min(32),
  pid: z.number().int(),
  protocolVersion: z.string(),
});
export type DaemonInfo = z.infer<typeof DaemonInfo>;

export const coordHome = (env: NodeJS.ProcessEnv = process.env) =>
  env.COORD_HOME ?? join(homedir(), ".coord");
export const daemonPort = (env: NodeJS.ProcessEnv = process.env) =>
  Number(env.COORD_PORT ?? DEFAULT_DAEMON_PORT);
export const daemonInfoPath = (port: number, home = coordHome()) => join(home, `daemon-${port}.json`);

export const createToken = () => randomBytes(32).toString("base64url");

export async function writeDaemonInfo(info: DaemonInfo, home = coordHome()): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = daemonInfoPath(info.port, home);
  await writeFile(path, JSON.stringify(info), { mode: 0o600 });
  await chmod(path, 0o600); // writeFile's mode is ignored when the file already exists
  return path;
}

export async function readDaemonInfo(port: number, home = coordHome()): Promise<DaemonInfo | undefined> {
  try {
    return DaemonInfo.parse(JSON.parse(await readFile(daemonInfoPath(port, home), "utf8")));
  } catch {
    return undefined;
  }
}

/** Removes the info file, but only if it still belongs to this process (another daemon may own it now). */
export async function removeDaemonInfo(port: number, pid: number, home = coordHome()): Promise<void> {
  const info = await readDaemonInfo(port, home);
  if (info?.pid === pid) await rm(daemonInfoPath(port, home), { force: true });
}

/**
 * Transport to the daemon on this machine. Reads the token on demand, so it keeps working
 * when the daemon (re)starts after this transport was created.
 */
export interface LocalTransportOptions extends Pick<
  HttpTransportOptions,
  "timeoutMs" | "WebSocket" | "reconnectDelayMs"
> {
  port?: number;
  home?: string;
}

export function localTransport(options: LocalTransportOptions = {}): Transport {
  const port = options.port ?? daemonPort();
  const home = options.home ?? coordHome();
  let cached: { token: string; transport: Transport } | undefined;

  const current = async (): Promise<Transport> => {
    const info = await readDaemonInfo(port, home);
    if (!info) {
      throw new DaemonError(
        0,
        "unavailable",
        `no daemon running on port ${port} (${daemonInfoPath(port, home)} missing)`,
      );
    }
    if (cached?.token !== info.token) {
      cached = {
        token: info.token,
        transport: httpTransport({
          baseUrl: localDaemonUrl(port),
          token: info.token,
          timeoutMs: options.timeoutMs,
          WebSocket: options.WebSocket,
          reconnectDelayMs: options.reconnectDelayMs,
        }),
      };
    }
    return cached.transport;
  };

  return {
    request: async (req) => (await current()).request(req),
    subscribe(handlers) {
      let stopInner: (() => void) | undefined;
      let closed = false;
      let retry: ReturnType<typeof setTimeout> | undefined;
      const reconnect = () => {
        if (!closed) retry = setTimeout(() => void connect(), options.reconnectDelayMs ?? 2_000);
      };
      // Reconnects re-read the token, in case the daemon restarted with a new one.
      const connect = async () => {
        try {
          const transport = await current();
          if (closed) return;
          stopInner = transport.subscribe({
            onEvent: handlers.onEvent,
            onStatus: (status) => {
              handlers.onStatus?.(status);
              if (status === "closed") {
                stopInner?.();
                stopInner = undefined;
                reconnect();
              }
            },
          });
        } catch {
          // No daemon to reach (no info file, or the connection failed): tell the subscriber, as
          // a dropped socket would, then keep trying.
          handlers.onStatus?.("closed");
          reconnect();
        }
      };
      void connect();
      return () => {
        closed = true;
        clearTimeout(retry);
        stopInner?.();
      };
    },
  };
}
