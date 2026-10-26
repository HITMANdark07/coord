import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type WebSocketServer } from "ws";
import { createRelay, type RelayOptions } from "./relay";

let relay: WebSocketServer;
afterEach(() => new Promise<void>((done) => relay.close(() => done())));

async function start(options: Partial<RelayOptions> = {}) {
  relay = createRelay({ port: 0, ...options });
  await once(relay, "listening");
}

async function connect(room?: string) {
  const { port } = relay.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${room ? `?room=${room}` : ""}`);
  await once(ws, "open");
  return ws;
}

describe("relay", () => {
  it("forwards frames only to peers in the same room", async () => {
    await start();
    const [daemon, phone, stranger] = await Promise.all([connect("a"), connect("a"), connect("b")]);
    const strangerGot: string[] = [];
    stranger.on("message", (d) => strangerGot.push(String(d)));

    const received = once(phone, "message");
    daemon.send("ciphertext");
    expect(String((await received)[0])).toBe("ciphertext");
    expect(strangerGot).toEqual([]);
    for (const ws of [daemon, phone, stranger]) ws.close();
  });

  it("closes connections without a room", async () => {
    await start();
    const { port } = relay.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const [code] = await once(ws, "close");
    expect(code).toBe(1008);
  });

  it("survives a malformed frame from one client", async () => {
    await start();
    const bad = await connect("a");
    // Client frames must be masked; this unmasked text frame is a protocol violation.
    (bad as unknown as { _socket: Socket })._socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    await once(bad, "close");

    const [a, b] = await Promise.all([connect("a"), connect("a")]);
    const received = once(b, "message");
    a.send("still up");
    expect(String((await received)[0])).toBe("still up");
    a.close();
    b.close();
  });

  it("refuses connections beyond the relay-wide limit", async () => {
    await start({ maxConnections: 2 });
    const [a, b] = await Promise.all([connect("r1"), connect("r2")]);
    const third = await connect("r3");
    const [code] = await once(third, "close");
    expect(code).toBe(1013);
    a.close();
    b.close();
  });

  it("refuses peers beyond the room limit", async () => {
    await start({ maxPeersPerRoom: 2 });
    const [a, b] = await Promise.all([connect("r"), connect("r")]);
    const third = await connect("r");
    const [code] = await once(third, "close");
    expect(code).toBe(1013);
    a.close();
    b.close();
  });
});
