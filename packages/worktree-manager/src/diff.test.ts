import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitTurn, createWorktree, diffAgainstBase, localBaseRef } from "./index";
import { makeTempRepo } from "./testing";

describe("diffAgainstBase", () => {
  it("includes committed and uncommitted changes against the merge base", async () => {
    const { path, env } = await makeTempRepo();
    const wt = join(await mkdtemp(join(tmpdir(), "coord-wm-d-")), "wt");
    await createWorktree({ repoPath: path, worktreePath: wt, branch: "agent/d", baseRef: "main" });
    await writeFile(join(wt, "committed.txt"), "one\ntwo\n");
    await commitTurn({ cwd: wt, branch: "agent/d", message: "t (turn 1)", trailers: [], env });
    await writeFile(join(wt, "README.md"), "changed\n");
    await writeFile(join(wt, "bin.dat"), Buffer.from([0, 1, 2, 0, 255]));
    // main moves on; merge base must keep the diff scoped to the task
    await writeFile(join(path, "other.txt"), "x");
    execFileSync("git", ["add", "-A"], { cwd: path });
    execFileSync("git", ["commit", "-m", "later"], { cwd: path, env: { ...process.env, ...env } });

    const before = execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" });
    const d = await diffAgainstBase({ cwd: wt, baseRef: "main" });
    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(byPath["committed.txt"]).toMatchObject({ status: "added", additions: 2, deletions: 0 });
    expect(byPath["README.md"]).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
    expect(byPath["bin.dat"]?.additions).toBe(0);
    expect(byPath["other.txt"]).toBeUndefined();
    expect(d.patch).toContain("+changed");
    expect(d.truncated).toBe(false);
    expect(d.baseRef).toBe("main");
    // Read-only on the real index: status is identical and stash still works.
    const after = execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" });
    expect(after).toBe(before);
    expect(after).toContain("?? bin.dat");
    execFileSync("git", ["stash", "-u"], { cwd: wt, env: { ...process.env, ...env } });
    execFileSync("git", ["stash", "pop"], { cwd: wt, env: { ...process.env, ...env } });

    await rm(join(wt, "committed.txt"));
    const d2 = await diffAgainstBase({ cwd: wt, baseRef: "main" });
    expect(d2.files.find((f) => f.path === "committed.txt")).toBeUndefined();
  });

  it("truncates huge patches", async () => {
    const { path } = await makeTempRepo();
    await writeFile(join(path, "big.txt"), "x".repeat(1_100_000) + "\n");
    const d = await diffAgainstBase({ cwd: path, baseRef: "main" });
    expect(d.truncated).toBe(true);
    expect(d.patch.length).toBeLessThanOrEqual(1_000_000);
  });
});

describe("localBaseRef", () => {
  it("prefers a local origin/<base> and falls back to <base>, without fetching", async () => {
    const withOrigin = await makeTempRepo({ withOrigin: true });
    expect(await localBaseRef(withOrigin.path, "main")).toBe("origin/main");
    expect(await localBaseRef(withOrigin.path, "nope")).toBe("nope");
    const plain = await makeTempRepo();
    expect(await localBaseRef(plain.path, "main")).toBe("main");
  });
});
