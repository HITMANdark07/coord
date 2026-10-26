import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonError } from "@wto/client";
import {
  createToken,
  daemonInfoPath,
  localTransport,
  readDaemonInfo,
  removeDaemonInfo,
  writeDaemonInfo,
} from "./index";

const tempHome = () => mkdtemp(join(tmpdir(), "wto-home-"));
const info = (pid = 1) => ({ port: 4999, token: createToken(), pid, protocolVersion: "0.1.0" });

describe("daemon info file", () => {
  it("is readable only by the owner", async () => {
    const home = await tempHome();
    const path = await writeDaemonInfo(info(), home);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o077).toBe(0);
  });

  it("round-trips and is only removed by the daemon that wrote it", async () => {
    const home = await tempHome();
    const written = info(42);
    await writeDaemonInfo(written, home);
    expect(await readDaemonInfo(4999, home)).toEqual(written);

    await removeDaemonInfo(4999, 7, home);
    expect(await readDaemonInfo(4999, home)).toEqual(written);
    await removeDaemonInfo(4999, 42, home);
    expect(await readDaemonInfo(4999, home)).toBeUndefined();
  });

  it("uses a separate file per port, so worktrees can run their own daemons", async () => {
    expect(daemonInfoPath(4545, "/h")).not.toBe(daemonInfoPath(4546, "/h"));
  });

  it("generates unguessable tokens", () => {
    const a = createToken();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).not.toBe(createToken());
  });
});

describe("localTransport", () => {
  it("reports a missing daemon as unavailable", async () => {
    const transport = localTransport({ port: 4999, home: await tempHome() });
    const err = await transport.request({ method: "GET", path: "/tasks" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect(err).toMatchObject({ code: "unavailable" });
  });
});
