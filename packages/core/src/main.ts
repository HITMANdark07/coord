import { join } from "node:path";
import { createClaudeCodeAdapter } from "@coord/adapter-claude-code";
import { coordHome, createToken, daemonPort, removeDaemonInfo, writeDaemonInfo } from "@coord/local-daemon";
import { PROTOCOL_VERSION } from "@coord/protocol";
import { openStore } from "@coord/task-store";
import { EventBus } from "./event-bus";
import { PermissionBroker } from "./permission-broker";
import { TaskRunner } from "./runner/task-runner";
import { createServer, DEFAULT_ALLOWED_ORIGINS } from "./server";

// Composition root: the only place that wires stores, adapters and the server together.
const port = daemonPort();
const token = createToken();
const allowedOrigins =
  process.env.COORD_ALLOWED_ORIGINS?.split(",").map((o) => o.trim()) ?? DEFAULT_ALLOWED_ORIGINS;
const home = coordHome();
const store = openStore(join(home, "coord.db"));
const bus = new EventBus({ startSeq: store.maxSeq(), persist: (e) => store.saveEvent(e) });
// The broker and the runner need each other; the runner exists before any task can run.
let runner: TaskRunner | undefined = undefined;
const broker = new PermissionBroker({
  store,
  bus,
  onPendingChange: (taskId, pending) => runner?.onPendingChange(taskId, pending),
});
const maxConcurrent = Number(process.env.COORD_MAX_CONCURRENT ?? 3);
runner = new TaskRunner({
  store,
  bus,
  broker,
  adapters: { "claude-code": createClaudeCodeAdapter() },
  home,
  maxConcurrent: Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 3,
});
const app = createServer({ token, allowedOrigins, bus, store, runner, broker });

// Localhost only: remote clients reach the daemon through the relay, never a public port (PRD §8).
await app.listen({ host: "127.0.0.1", port });
// Clients on this machine read the token from this owner-only file.
const infoPath = await writeDaemonInfo({ port, token, pid: process.pid, protocolVersion: PROTOCOL_VERSION });
console.log(`coord daemon listening on http://127.0.0.1:${port} (token in ${infoPath})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void removeDaemonInfo(port, process.pid)
      .then(() => app.close())
      .then(() => process.exit(0));
  });
}
