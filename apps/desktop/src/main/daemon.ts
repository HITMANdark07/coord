import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { app } from "electron";
import { isCompatibleProtocol, PROTOCOL_VERSION, type Health } from "@wto/protocol";

const STARTUP_TIMEOUT_MS = 15_000;

/**
 * Makes sure a compatible daemon is running. The daemon is a separate, detached process so
 * agents keep running when the window closes (PRD §9.1). Dev only for now: the packaged app
 * ships a bundled daemon in Phase 2.
 */
export async function ensureDaemon(health: () => Promise<Health>): Promise<void> {
  if (await isUp(health)) return;
  // `pnpm dev` starts the daemon itself (with watch mode); just wait for it.
  if (process.env.WTO_EXTERNAL_DAEMON) return waitUntilUp(health);
  if (app.isPackaged) throw new Error("bundled daemon is not implemented yet (Phase 2)");

  let spawnError: Error | undefined;
  const child = spawn("pnpm", ["--filter", "@wto/core", "start"], {
    cwd: join(app.getAppPath(), "../.."),
    detached: true,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  // e.g. pnpm not on PATH (common when the app is launched from the Finder): fail fast.
  child.on("error", (err) => (spawnError = err));
  child.unref();

  await waitUntilUp(health, () => spawnError);
}

async function waitUntilUp(health: () => Promise<Health>, failed: () => Error | undefined = () => undefined) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const err = failed();
    if (err) throw new Error(`could not start the daemon: ${err.message}`);
    if (await isUp(health)) return;
    await sleep(300);
  }
  throw new Error(`daemon did not answer within ${STARTUP_TIMEOUT_MS / 1000}s`);
}

/** Up = a wto daemon (valid Health) that speaks a compatible protocol. */
async function isUp(health: () => Promise<Health>): Promise<boolean> {
  let h: Health;
  try {
    h = await health();
  } catch {
    return false;
  }
  if (!isCompatibleProtocol(PROTOCOL_VERSION, h.protocolVersion)) {
    throw new Error(
      `daemon speaks protocol ${h.protocolVersion}, this app ${PROTOCOL_VERSION}; restart the daemon`,
    );
  }
  return true;
}
