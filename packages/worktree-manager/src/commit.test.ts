import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommitError, commitTurn, hasChanges } from "./index";
import { makeTempRepo } from "./testing";

async function agentRepo() {
  const r = await makeTempRepo();
  execFileSync("git", ["switch", "-c", "agent/t"], { cwd: r.path });
  return r;
}

const trailers = ["Coord-Task: t1", "Co-Authored-By: Claude Code <noreply@anthropic.com>"];

describe("commitTurn", () => {
  it("commits with trailers and skips hooks", async () => {
    const { path, env } = await agentRepo();
    const hook = join(path, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await writeFile(join(path, "a.txt"), "a");
    expect(await hasChanges(path)).toBe(true);
    const r = await commitTurn({ cwd: path, branch: "agent/t", message: "Do thing (turn 1)", trailers, env });
    expect(r.committed).toBe(true);
    const body = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: path, encoding: "utf8" });
    expect(body).toContain("Do thing (turn 1)\n\nCoord-Task: t1");
    expect(body).toContain("Co-Authored-By: Claude Code <noreply@anthropic.com>");
    expect(await hasChanges(path)).toBe(false);
  });

  it("never stages excluded files, and doesn't commit when only they changed", async () => {
    const { path, env } = await agentRepo();
    await mkdir(join(path, "app"));
    await writeFile(join(path, ".env"), "SECRET=1\n");
    await writeFile(join(path, "app/.env.local"), "SECRET=2\n");
    const exclude = [".env", "app/.env.local"];
    expect(await commitTurn({ cwd: path, branch: "agent/t", message: "m", trailers, env, exclude })).toEqual({
      committed: false,
    });
    await writeFile(join(path, "a.txt"), "a");
    const r = await commitTurn({ cwd: path, branch: "agent/t", message: "m", trailers, env, exclude });
    expect(r.committed).toBe(true);
    const files = execFileSync("git", ["show", "--name-only", "--format="], { cwd: path, encoding: "utf8" });
    expect(files.trim()).toBe("a.txt");
    const st = execFileSync("git", ["status", "--porcelain"], { cwd: path, encoding: "utf8" });
    expect(st).toBe("?? .env\n?? app/\n");
  });

  it("leaves out excluded files the agent staged itself", async () => {
    const { path, env } = await agentRepo();
    await writeFile(join(path, ".env"), "SECRET=1\n");
    // `git add .env` from the agent's own shell: the exclude pathspec doesn't undo it.
    execFileSync("git", ["add", ".env"], { cwd: path });
    const exclude = [".env"];
    expect(await commitTurn({ cwd: path, branch: "agent/t", message: "m", trailers, env, exclude })).toEqual({
      committed: false,
    });
    execFileSync("git", ["add", ".env"], { cwd: path });
    await writeFile(join(path, "a.txt"), "a");
    const r = await commitTurn({ cwd: path, branch: "agent/t", message: "m", trailers, env, exclude });
    expect(r.committed).toBe(true);
    const files = execFileSync("git", ["show", "--name-only", "--format="], { cwd: path, encoding: "utf8" });
    expect(files.trim()).toBe("a.txt");
    const st = execFileSync("git", ["status", "--porcelain"], { cwd: path, encoding: "utf8" });
    expect(st).toBe("?? .env\n");
  });

  it("is a no-op without changes", async () => {
    const { path, env } = await agentRepo();
    expect(await commitTurn({ cwd: path, branch: "agent/t", message: "m", trailers, env })).toEqual({
      committed: false,
    });
  });

  it("raises CommitError when the commit fails", async () => {
    const { path } = await agentRepo();
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
    await expect(
      commitTurn({ cwd: path, branch: "agent/t", message: "m", trailers, env }),
    ).rejects.toBeInstanceOf(CommitError);
  });

  it("refuses a detached HEAD and stages nothing", async () => {
    const { path, env } = await agentRepo();
    execFileSync("git", ["switch", "--detach"], { cwd: path });
    await writeFile(join(path, "a.txt"), "a");
    await expect(
      commitTurn({ cwd: path, branch: "agent/t", message: "m", trailers, env }),
    ).rejects.toBeInstanceOf(CommitError);
    const st = execFileSync("git", ["status", "--porcelain"], { cwd: path, encoding: "utf8" });
    expect(st).toBe("?? a.txt\n");
    const n = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: path, encoding: "utf8" });
    expect(n.trim()).toBe("1");
  });

  it("refuses when HEAD is on another branch", async () => {
    const { path, env } = await agentRepo();
    execFileSync("git", ["switch", "main"], { cwd: path });
    await writeFile(join(path, "a.txt"), "a");
    await expect(commitTurn({ cwd: path, branch: "agent/t", message: "m", trailers, env })).rejects.toThrow(
      /not on the task branch/,
    );
    await expect(
      commitTurn({ cwd: path, branch: "main", message: "m", trailers, env }),
    ).rejects.toBeInstanceOf(CommitError);
    const st = execFileSync("git", ["status", "--porcelain"], { cwd: path, encoding: "utf8" });
    expect(st).toBe("?? a.txt\n");
  });
});
