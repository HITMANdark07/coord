import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommitError, commitTurn, hasChanges } from "./index";
import { makeTempRepo } from "./testing";

const trailers = ["Coord-Task: t1", "Co-Authored-By: Claude Code <noreply@anthropic.com>"];

describe("commitTurn", () => {
  it("commits with trailers and skips hooks", async () => {
    const { path, env } = await makeTempRepo();
    const hook = join(path, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await writeFile(join(path, "a.txt"), "a");
    expect(await hasChanges(path)).toBe(true);
    const r = await commitTurn({ cwd: path, message: "Do thing (turn 1)", trailers, env });
    expect(r.committed).toBe(true);
    const body = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: path, encoding: "utf8" });
    expect(body).toContain("Do thing (turn 1)\n\nCoord-Task: t1");
    expect(body).toContain("Co-Authored-By: Claude Code <noreply@anthropic.com>");
    expect(await hasChanges(path)).toBe(false);
  });

  it("is a no-op without changes", async () => {
    const { path, env } = await makeTempRepo();
    expect(await commitTurn({ cwd: path, message: "m", trailers, env })).toEqual({
      committed: false,
    });
  });

  it("raises CommitError when the commit fails", async () => {
    const { path } = await makeTempRepo();
    await writeFile(join(path, "a.txt"), "a");
    const home = await mkdtemp(join(tmpdir(), "coord-wm-home-"));
    await mkdir(join(home, "x"));
    const env = {
      HOME: home,
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "",
      GIT_AUTHOR_EMAIL: "",
      GIT_COMMITTER_NAME: "",
      GIT_COMMITTER_EMAIL: "",
      EMAIL: "",
    };
    await expect(commitTurn({ cwd: path, message: "m", trailers, env })).rejects.toBeInstanceOf(CommitError);
  });
});
