import { WebSocketServer, type WebSocket } from "ws";

export interface RelayOptions {
  port: number;
  /** Interface to bind. Defaults to localhost; a deployed relay sets this explicitly. */
  host?: string;
  /** Peers per room: one daemon plus its paired devices. */
  maxPeersPerRoom?: number;
  /** Connections across all rooms. */
  maxConnections?: number;
  heartbeatMs?: number;
}

const MAX_FRAME_BYTES = 256 * 1024;

/**
 * Forwards opaque (end-to-end encrypted) frames between a daemon and its paired clients.
 * Peers join a room named by the pairing id: ws://host:port/?room=<pairingId>
 * Phase 4 adds: pairing handshake, auth, offline queue, push (PRD FR-40..42).
 */
export function createRelay(options: RelayOptions) {
  const { maxPeersPerRoom = 8, maxConnections = 1_000, heartbeatMs = 30_000 } = options;
  const rooms = new Map<string, Set<WebSocket>>();
  const alive = new WeakSet<WebSocket>();
  const wss = new WebSocketServer({
    port: options.port,
    host: options.host ?? "127.0.0.1",
    maxPayload: MAX_FRAME_BYTES,
  });

  wss.on("connection", (ws, req) => {
    // Without this, one malformed frame raises an unhandled 'error' and kills the whole relay.
    ws.on("error", () => ws.terminate());

    if (wss.clients.size > maxConnections) return ws.close(1013, "relay full");

    const room = new URL(req.url ?? "/", "http://relay").searchParams.get("room");
    if (!room) return ws.close(1008, "room required");

    const peers = rooms.get(room) ?? new Set<WebSocket>();
    if (peers.size >= maxPeersPerRoom) return ws.close(1013, "room full");
    rooms.set(room, peers);
    peers.add(ws);
    alive.add(ws);

    ws.on("pong", () => alive.add(ws));
    ws.on("message", (data, isBinary) => {
      for (const peer of peers) {
        if (peer !== ws && peer.readyState === peer.OPEN) peer.send(data, { binary: isBinary });
      }
    });
    ws.on("close", () => {
      peers.delete(ws);
      if (peers.size === 0) rooms.delete(room);
    });
  });

  // Drop half-open connections that stop answering pings.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, heartbeatMs);
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}
