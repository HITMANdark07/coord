import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const live = () => FakeSocket.all.filter((s) => s.open);

describe("localTransport reconnects", () => {
  it("keeps exactly one connection after a drop, using the daemon's new token", async () => {
    FakeSocket.all = [];
    const home = await mkdtemp(join(tmpdir(), "wto-home-"));
    await writeDaemonInfo({ port: 4998, token: createToken(), pid: 1, protocolVersion: "0.1.0" }, home);
    const events: unknown[] = [];
    const stop = localTransport({
      port: 4998,
      home,
      reconnectDelayMs: 5,
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    }).subscribe({ onEvent: (e) => events.push(e) });
    await tick(10);
    expect(live()).toHaveLength(1);

    // The daemon restarts with a new token, and the connection drops.
    const restartedToken = createToken();
    await writeDaemonInfo({ port: 4998, token: restartedToken, pid: 2, protocolVersion: "0.1.0" }, home);
    live()[0]?.drop();
    await tick(40);

    expect(live()).toHaveLength(1);
    expect(live()[0]?.protocols).toContain(`wto.token.${restartedToken}`);
    live()[0]?.onmessage?.({ data: '{"n":1}' });
    expect(events).toEqual([{ n: 1 }]);

    stop();
    expect(live()).toHaveLength(0);
  });
});
