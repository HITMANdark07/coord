import { z } from "zod";

/** Bumped on any change to the wire format (PRD §8 Protocol versioning). */
export const PROTOCOL_VERSION = "0.1.0";

/** Every request carries the client's protocol version in this header (HTTP) or field (relay frames). */
export const PROTOCOL_HEADER = "x-coord-protocol";

export const DEFAULT_DAEMON_PORT = 4545;

/**
 * Auth for the local daemon. HTTP sends `Authorization: Bearer <token>`. Browsers can't set
 * headers on a WebSocket, so /events offers two subprotocols: EVENTS_SUBPROTOCOL and
 * `${TOKEN_SUBPROTOCOL_PREFIX}<token>`; the daemon answers with EVENTS_SUBPROTOCOL.
 */
export const EVENTS_SUBPROTOCOL = "coord.v1";
export const TOKEN_SUBPROTOCOL_PREFIX = "coord.token.";

/**
 * The daemon accepts clients on the same major version and the current or previous minor,
 * because phones update slower than desktops.
 */
export function isCompatibleProtocol(
  clientVersion: string,
  daemonVersion: string = PROTOCOL_VERSION,
): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1, 3).map(Number);
  const client = parse(clientVersion);
  const daemon = parse(daemonVersion);
  if (!client || !daemon) return false;
  const [cMajor, cMinor] = client as [number, number];
  const [dMajor, dMinor] = daemon as [number, number];
  return cMajor === dMajor && (cMinor === dMinor || cMinor === dMinor - 1);
}

export const Health = z.object({
  ok: z.literal(true),
  protocolVersion: z.string(),
  daemonVersion: z.string(),
});
export type Health = z.infer<typeof Health>;
