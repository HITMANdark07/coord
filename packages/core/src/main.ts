import { createToken, daemonPort, removeDaemonInfo, writeDaemonInfo } from "@coord/local-daemon";
import { PROTOCOL_VERSION } from "@coord/protocol";
import { createServer, DEFAULT_ALLOWED_ORIGINS } from "./server";

// Composition root: the only place that wires stores, adapters and the server together.
const port = daemonPort();
const token = createToken();
const allowedOrigins =
  process.env.COORD_ALLOWED_ORIGINS?.split(",").map((o) => o.trim()) ?? DEFAULT_ALLOWED_ORIGINS;
const app = createServer({ token, allowedOrigins });

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
