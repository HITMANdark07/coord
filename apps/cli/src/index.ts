import { createClient } from "@wto/client";
import { daemonPort, localTransport, readDaemonInfo } from "@wto/local-daemon";
import { buildProgram } from "./program";

const client = createClient(localTransport());
const readToken = async () => (await readDaemonInfo(daemonPort()))?.token;

buildProgram(client, { readToken })
  .parseAsync()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
