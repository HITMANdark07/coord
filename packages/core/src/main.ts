import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createClaudeCodeAdapter } from "@coord/adapter-claude-code";
import { coordHome, createToken, daemonPort, removeDaemonInfo, writeDaemonInfo } from "@coord/local-daemon";
import { PROTOCOL_VERSION } from "@coord/protocol";
import { openStore } from "@coord/task-store";
import { acquireDaemonLock, DaemonLockedError } from "./daemon-lock";
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
// Home holds the token file, the database and the worktrees (AGENTS.md rule 8). mkdir's mode
// only applies to a new directory, so chmod repairs a home an older daemon created 0755.
await mkdir(home, { recursive: true, mode: 0o700 });
try {
  await chmod(home, 0o700);
} catch (error) {
  // A home the user doesn't own (EPERM): say which directory and why, not a stack trace. The
  // daemon never runs with a home it can't keep private.
  const code = (error as NodeJS.ErrnoException).code ?? String(error);
  console.error(
    `coord: can't make ${home} owner-only (chmod 700 failed: ${code}); set COORD_HOME to a directory you own`,
  );
  process.exit(1);
}
// Take the lock before touching the database or the port: a second daemon on this COORD_HOME
// must exit without opening anything.
let lock: Awaited<ReturnType<typeof acquireDaemonLock>>;
try {
  lock = await acquireDaemonLock(home, { pid: process.pid, port });
} catch (error) {
  if (error instanceof DaemonLockedError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
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
const taskRunner: TaskRunner = runner;
const app = createServer({ token, allowedOrigins, bus, store, runner, broker });

// Tasks a previous daemon left mid-flight are settled before any client can connect.
const recovered = await runner.recoverOnStart();
console.log(`recovered ${recovered} task${recovered === 1 ? "" : "s"} from the previous run`);

const sweep = () =>
  runner.sweepDiscardedBranches().then(
    (n) => {
      if (n > 0) console.log(`swept ${n} discarded branch${n === 1 ? "" : "es"}`);
    },
    (error: unknown) => console.error("branch sweep failed:", error instanceof Error ? error.message : error),
  );
void sweep(); // never delays listen; errors are logged inside
const sweepTimer = setInterval(() => void sweep(), 60 * 60 * 1000);
sweepTimer.unref();

// Localhost only: remote clients reach the daemon through the relay, never a public port (PRD §8).
await app.listen({ host: "127.0.0.1", port });
// Clients on this machine read the token from this owner-only file.
const infoPath = await writeDaemonInfo({ port, token, pid: process.pid, protocolVersion: PROTOCOL_VERSION });
console.log(`coord daemon listening on http://127.0.0.1:${port} (token in ${infoPath})`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(sweepTimer);
  // Each step is guarded: one failure must not leave the lock or the daemon info behind.
  const steps: Array<[string, () => unknown]> = [
    ["close server", () => app.close()],
    // Stops live agent runs before the store closes, so none publishes into a closed database.
    ["stop runs", () => taskRunner.shutdown()],
    ["close store", () => store.close()],
    ["remove daemon info", () => removeDaemonInfo(port, process.pid)],
    ["release lock", () => lock.release()],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      console.error(`shutdown: ${name} failed:`, error instanceof Error ? error.message : error);
    }
  }
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown());
}
