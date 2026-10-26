import { afterEach, describe, expect, it } from "vitest";
import { createClient, type CoordClient } from "@coord/client";
import { fakeTransport } from "@coord/client/testing";
import type { TransportRequest } from "@coord/client";
import { buildProgram } from "./program";

const health = { ok: true, protocolVersion: "0.1.0", daemonVersion: "0.1.0" };

async function run(client: CoordClient, ...args: string[]) {
  const lines: string[] = [];
  await buildProgram(client, { log: (l) => lines.push(l), readToken: async () => "tok" }).parseAsync(args, {
    from: "user",
  });
  return lines;
}

describe("coord cli", () => {
  const initCwd = process.env.INIT_CWD;
  afterEach(() => {
    if (initCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = initCwd;
  });

  it("prints daemon status", async () => {
    expect(await run(createClient(fakeTransport(() => health)), "status")).toEqual([
      "daemon 0.1.0 · protocol 0.1.0",
    ]);
  });

  it("prints the web app link with the token in the URL fragment", async () => {
    expect(await run(createClient(fakeTransport(() => [])), "web")).toEqual([
      "http://localhost:5173/#token=tok",
    ]);
  });

  it("says when there are no tasks", async () => {
    expect(await run(createClient(fakeTransport(() => [])), "ls")).toEqual(["no tasks"]);
  });

  it("resolves --repo against the directory the user ran pnpm from", async () => {
    process.env.INIT_CWD = "/home/me/project";
    const transport = fakeTransport(() => {
      throw new Error("stop");
    });
    await expect(run(createClient(transport), "new", "x", "--repo", "../other")).rejects.toThrow("stop");
    expect((transport.requests[0] as TransportRequest).body).toMatchObject({ repoPath: "/home/me/other" });
  });
});
