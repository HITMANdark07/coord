import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DaemonLockInfo {
  pid: number;
  port: number;
}

export class DaemonLockedError extends Error {
  constructor(readonly holder: DaemonLockInfo) {
    super(
      `Another Coord daemon (pid ${holder.pid}, port ${holder.port}) already uses this COORD_HOME. ` +
        `Stop it, or set a different COORD_HOME.`,
    );
    this.name = "DaemonLockedError";
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(file: string): Promise<DaemonLockInfo | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    const { pid, port } = parsed as Partial<DaemonLockInfo>;
    return typeof pid === "number" && typeof port === "number" ? { pid, port } : undefined;
  } catch {
    return undefined; // missing or corrupt: treat as no holder
  }
}

/** Refuses a second daemon on the same COORD_HOME; a lock left by a dead process is replaced. */
export async function acquireDaemonLock(
  home: string,
  info: DaemonLockInfo,
): Promise<{ release(): Promise<void> }> {
  await mkdir(home, { recursive: true });
  const file = join(home, "daemon.lock");
  const body = JSON.stringify({ pid: info.pid, port: info.port });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, body, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = await readLock(file);
      if (holder && isAlive(holder.pid)) throw new DaemonLockedError(holder);
      await rm(file, { force: true });
      if (attempt === 1) throw error;
    }
  }

  return {
    async release() {
      const holder = await readLock(file);
      if (holder?.pid === info.pid) await rm(file, { force: true });
    },
  };
}
