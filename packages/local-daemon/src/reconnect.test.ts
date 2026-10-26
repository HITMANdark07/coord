import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createToken, localTransport, writeDaemonInfo } from "./index";

/** Records every socket so the test can drop connections and count live ones. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen?: () => void;
  onmessage?: (m: { data: string }) => void;
  onclose?: () => void;
  open = true;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.all.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.onclose?.();
  }
  drop() {
    this.open = false;
    this.onclose?.();
  }
}

const live = () => FakeSocket.all.filter((s) => s.open);

describe("localTransport reconnects", () => {
  it("keeps exactly one connection after a drop, using the daemon's new token", async () => {
    FakeSocket.all = [];
    const home = await mkdtemp(join(tmpdir(), "coord-home-"));
    await writeDaemonInfo({ port: 4998, token: createToken(), pid: 1, protocolVersion: "0.1.0" }, home);
    const events: unknown[] = [];
    const stop = localTransport({
      port: 4998,
      home,
      reconnectDelayMs: 5,
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    }).subscribe({ onEvent: (e) => events.push(e) });
    await vi.waitFor(() => expect(live()).toHaveLength(1));

    // The daemon restarts with a new token, and the connection drops.
    const restartedToken = createToken();
    await writeDaemonInfo({ port: 4998, token: restartedToken, pid: 2, protocolVersion: "0.1.0" }, home);
    live()[0]?.drop();
    await vi.waitFor(() => expect(live()[0]?.protocols).toContain(`coord.token.${restartedToken}`));

    expect(live()).toHaveLength(1);
    live()[0]?.onmessage?.({ data: '{"n":1}' });
    expect(events).toEqual([{ n: 1 }]);

    stop();
    expect(live()).toHaveLength(0);
  });

  it("reports closed when there is no daemon to connect to, and keeps retrying", async () => {
    const home = await mkdtemp(join(tmpdir(), "coord-home-"));
    const statuses: string[] = [];
    const stop = localTransport({ port: 4997, home, reconnectDelayMs: 5 }).subscribe({
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
    });
    // Still retrying: a second attempt reports closed again.
    await vi.waitFor(() => expect(statuses.length).toBeGreaterThan(1));
    stop();
    expect(statuses[0]).toBe("closed");
  });
});
