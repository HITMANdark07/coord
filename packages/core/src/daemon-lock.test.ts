import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDaemonLock, DaemonLockedError } from "./daemon-lock.js";

describe("daemon lock", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "coord-lock-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("second lock on the same home fails while the first holder lives", async () => {
    await writeFile(join(home, "daemon.lock"), JSON.stringify({ pid: process.pid, port: 4545 }));
    const attempt = acquireDaemonLock(home, { pid: process.pid + 1, port: 4546 });
    await expect(attempt).rejects.toBeInstanceOf(DaemonLockedError);
    await expect(attempt).rejects.toThrow(new RegExp(`${process.pid}.*4545.*COORD_HOME`));
  });

  it("names the lock file, and says to delete it if no daemon is running", async () => {
    const file = join(home, "daemon.lock");
    await writeFile(file, JSON.stringify({ pid: process.pid, port: 4545 }));
    const err = await acquireDaemonLock(home, { pid: process.pid + 1, port: 4546 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonLockedError);
    expect((err as Error).message).toContain(`If no coord daemon is running, delete ${file}.`);
  });

  it.skipIf(process.platform === "win32")("creates a missing home owner-only (0700)", async () => {
    const fresh = join(home, "fresh");
    await acquireDaemonLock(fresh, { pid: process.pid, port: 4545 });
    expect((await stat(fresh)).mode & 0o777).toBe(0o700);
  });

  it("stale lock from a dead pid is replaced", async () => {
    await writeFile(join(home, "daemon.lock"), JSON.stringify({ pid: 999999, port: 4545 }));
    await acquireDaemonLock(home, { pid: process.pid, port: 4546 });
    const lock = JSON.parse(await readFile(join(home, "daemon.lock"), "utf8"));
    expect(lock).toEqual({ pid: process.pid, port: 4546 });
  });

  it("creates a missing home and release removes the lock", async () => {
    const nested = join(home, "nested", "home");
    const lock = await acquireDaemonLock(nested, { pid: process.pid, port: 4545 });
    await lock.release();
    await expect(readFile(join(nested, "daemon.lock"), "utf8")).rejects.toThrow();
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("release leaves a lock owned by another pid", async () => {
    const lock = await acquireDaemonLock(home, { pid: process.pid, port: 4545 });
    await writeFile(join(home, "daemon.lock"), JSON.stringify({ pid: 1, port: 1 }));
    await lock.release();
    expect(JSON.parse(await readFile(join(home, "daemon.lock"), "utf8")).pid).toBe(1);
  });
});
