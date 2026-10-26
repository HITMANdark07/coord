import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@coord/protocol";
import { openStore } from "@coord/task-store";
import { makeTempRepo } from "@coord/worktree-manager/testing";
import { EventBus } from "./event-bus";
import { PermissionBroker } from "./permission-broker";
import { TaskRunner } from "./runner/task-runner";
import { fakeAdapter, type FakeStep } from "./runner/testing";
import { createServer } from "./server";

export const TOKEN = "test-token-0123456789-0123456789-abcdef";
export const auth = { [PROTOCOL_HEADER]: PROTOCOL_VERSION, authorization: `Bearer ${TOKEN}` };

/** A daemon over `:memory:` SQLite, a scripted fake agent and a real temp git repo (not yet registered). */
export async function testDaemon(script: FakeStep[] = [{ event: { type: "done" } }]) {
  const repo = await makeTempRepo();
  const home = await mkdtemp(join(tmpdir(), "coord-daemon-home-"));
  const store = openStore(":memory:");
  const bus = new EventBus({ startSeq: store.maxSeq(), persist: (e) => store.saveEvent(e) });
  let runner: TaskRunner | undefined = undefined;
  const broker = new PermissionBroker({
    store,
    bus,
    onPendingChange: (t, c) => runner?.onPendingChange(t, c),
  });
  const adapter = fakeAdapter(script);
  const theRunner = (runner = new TaskRunner({
    store,
    bus,
    broker,
    adapters: { "claude-code": adapter },
    home,
    maxConcurrent: 3,
    gitEnv: repo.env,
  }));
  const app = createServer({ token: TOKEN, bus, store, runner: theRunner, broker });
  return {
    app,
    repo,
    store,
    bus,
    broker,
    runner: theRunner,
    adapter,
    /** Authenticated request helper. */
    call: (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
      app.inject({
        method,
        url,
        headers: auth,
        ...(payload === undefined ? {} : { payload: payload as object }),
      }),
    async close() {
      await theRunner.idle();
      await adapter.settled();
      await app.close();
      store.close();
      await rm(dirname(repo.path), { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    },
  };
}
