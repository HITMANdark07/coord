import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  GitError,
  branchTip,
  copyEnvFiles,
  createWorktree,
  deleteBranch,
  detectSetupCommands,
  forgetWorktree,
  readRepoConfig,
  readRepoInfo,
  removeEnvCopies,
  removeWorktree,
  resolveBaseRef,
  runCommands,
  uniqueBranch,
} from "./index";
import { makeTempRepo } from "./testing";

const git = (cwd: string, env: Record<string, string>, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
const tmp = () => mkdtemp(join(tmpdir(), "coord-wm-t-"));

describe("worktrees", () => {
  it("creates a worktree from origin/main without touching the main checkout", async () => {
    const { path, env } = await makeTempRepo({ withOrigin: true });
    await writeFile(join(path, "README.md"), "dirty\n");
    await writeFile(join(path, "untracked.txt"), "x\n");
    const before = git(path, env, "status", "--porcelain");
    const { ref, fetched } = await resolveBaseRef(path, "main");
    expect(ref).toBe("origin/main");
    expect(fetched).toBe(true);
    const wt = join(await tmp(), "wt");
    await createWorktree({ repoPath: path, worktreePath: wt, branch: "agent/x", baseRef: ref });
    expect(git(path, env, "status", "--porcelain")).toBe(before);
    expect(existsSync(join(wt, "README.md"))).toBe(true);
    expect(git(wt, env, "branch", "--show-current").trim()).toBe("agent/x");
  });

  it("works without a remote", async () => {
    const { path } = await makeTempRepo();
    expect(await resolveBaseRef(path, "main")).toEqual({ ref: "main", fetched: false });
    const wt = join(await tmp(), "wt");
    await createWorktree({ repoPath: path, worktreePath: wt, branch: "agent/y", baseRef: "main" });
    expect(existsSync(join(wt, "README.md"))).toBe(true);
  });

  it("reads repo info", async () => {
    const { path, origin } = await makeTempRepo({ withOrigin: true });
    const info = await readRepoInfo(path);
    expect(info).toEqual({ name: "repo", root: path, defaultBranch: "main", remoteUrl: origin });
    const bare = await makeTempRepo();
    expect((await readRepoInfo(bare.path)).remoteUrl).toBeNull();
    await expect(readRepoInfo(await tmp())).rejects.toBeInstanceOf(GitError);
  });

  it("unique branch names", async () => {
    const { path, env } = await makeTempRepo({ withOrigin: true });
    git(path, env, "branch", "agent/fix");
    expect(await uniqueBranch(path, "agent/fix")).toBe("agent/fix-2");
    git(path, env, "branch", "agent/fix-2");
    expect(await uniqueBranch(path, "agent/fix")).toBe("agent/fix-3");
    // remote-only branch also counts
    git(path, env, "push", "origin", "main:agent/other");
    git(path, env, "fetch", "origin");
    expect(await uniqueBranch(path, "agent/other")).toBe("agent/other-2");
  });

  it("reads config from the base ref, not the working tree", async () => {
    const { path, env } = await makeTempRepo();
    await mkdir(join(path, ".coord"));
    await writeFile(join(path, ".coord/config.json"), JSON.stringify({ checks: { t: "true" } }));
    git(path, env, "add", "-A");
    git(path, env, "commit", "-m", "cfg");
    const wt = join(await tmp(), "wt");
    await createWorktree({ repoPath: path, worktreePath: wt, branch: "agent/c", baseRef: "main" });
    await writeFile(join(wt, ".coord/config.json"), JSON.stringify({ checks: { t: "false" } }));
    expect((await readRepoConfig(path, "main")).checks).toEqual({ t: "true" });
  });

  it("a base that looks like a git option is a ref operand, never an option", async () => {
    const { path } = await makeTempRepo({ withOrigin: true });
    const dir = await tmp();
    const pwned = join(dir, "pwned");
    await expect(resolveBaseRef(path, `--upload-pack=touch ${pwned}`)).rejects.toBeInstanceOf(GitError);
    const out = join(dir, "out");
    await expect(readRepoConfig(path, `--output=${out}`)).rejects.toBeInstanceOf(GitError);
    expect(existsSync(pwned)).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it("missing config gives defaults; invalid config is a ConfigError", async () => {
    const { path, env } = await makeTempRepo();
    expect((await readRepoConfig(path, "main")).ports.start).toBe(41000);
    await mkdir(join(path, ".coord"));
    await writeFile(join(path, ".coord/config.json"), "{nope");
    git(path, env, "add", "-A");
    git(path, env, "commit", "-m", "bad");
    await expect(readRepoConfig(path, "main")).rejects.toBeInstanceOf(ConfigError);
    await writeFile(join(path, ".coord/config.json"), JSON.stringify({ envFiles: 3 }));
    git(path, env, "commit", "-am", "bad2");
    await expect(readRepoConfig(path, "main")).rejects.toBeInstanceOf(ConfigError);
  });

  it("detects pnpm and others", async () => {
    const d = await tmp();
    expect(await detectSetupCommands(d)).toEqual([]);
    await writeFile(join(d, "pnpm-lock.yaml"), "");
    expect(await detectSetupCommands(d)).toEqual(["pnpm install --frozen-lockfile"]);
    const n = await tmp();
    await writeFile(join(n, "package-lock.json"), "");
    expect(await detectSetupCommands(n)).toEqual(["npm ci"]);
    const y = await tmp();
    await writeFile(join(y, "yarn.lock"), "");
    expect(await detectSetupCommands(y)).toEqual(["yarn install --frozen-lockfile"]);
    const b = await tmp();
    await writeFile(join(b, "bun.lockb"), "");
    expect(await detectSetupCommands(b)).toEqual(["bun install"]);
  });

  it("copies only existing env files", async () => {
    const a = await tmp();
    const b = await tmp();
    await writeFile(join(a, ".env"), "A=1\n");
    await mkdir(join(a, "app"));
    await writeFile(join(a, "app/.env.local"), "B=2\n");
    const copied = await copyEnvFiles(a, b, [".env", ".env.missing", "app/.env.local", "../escape"]);
    expect(copied).toEqual([".env", "app/.env.local"]);
    expect(existsSync(join(b, "app/.env.local"))).toBe(true);
    expect(existsSync(join(b, ".env.missing"))).toBe(false);
  });

  it("copyEnvFiles with skipExisting keeps env files already in the worktree", async () => {
    const a = await tmp();
    const b = await tmp();
    await writeFile(join(a, ".env"), "A=from-checkout\n");
    await writeFile(join(a, ".env.local"), "B=2\n");
    await writeFile(join(b, ".env"), "A=fixed-by-user\n");
    const copied = await copyEnvFiles(a, b, [".env", ".env.local"], { skipExisting: true });
    expect(copied).toEqual([".env.local"]);
    expect(await readFile(join(b, ".env"), "utf8")).toBe("A=fixed-by-user\n");
    expect(await readFile(join(b, ".env.local"), "utf8")).toBe("B=2\n");
  });

  it("runCommands stops at the first failure with output", async () => {
    const d = await tmp();
    const r = await runCommands(["true", "echo boom; exit 3", "touch never"], { cwd: d, env: {} });
    expect(r).toMatchObject({ ok: false, command: "echo boom; exit 3", exitCode: 3 });
    if (!r.ok) expect(r.output).toContain("boom");
    expect(existsSync(join(d, "never"))).toBe(false);
    expect(await runCommands(["true"], { cwd: d, env: {} })).toEqual({ ok: true });
  });

  it("runCommands honors abort signal", async () => {
    const d = await tmp();
    const ac = new AbortController();
    const p = runCommands(["sleep 30"], { cwd: d, env: {}, signal: ac.signal });
    ac.abort();
    const r = await p;
    expect(r.ok).toBe(false);
  });

  it("removeEnvCopies deletes only untracked copies identical to the checkout's", async () => {
    const { path, env } = await makeTempRepo();
    for (const f of [".env", ".env.edited", ".env.tracked"]) await writeFile(join(path, f), "A=1\n");
    const wt = join(await tmp(), "wt");
    git(path, env, "add", ".env.tracked");
    git(path, env, "commit", "-m", "tracked env");
    await createWorktree({ repoPath: path, worktreePath: wt, branch: "agent/e", baseRef: "main" });
    const files = [".env", ".env.edited", ".env.tracked"];
    await copyEnvFiles(path, wt, files);
    await writeFile(join(wt, ".env.edited"), "A=2\n");

    await removeEnvCopies(path, wt, files);

    expect(existsSync(join(wt, ".env"))).toBe(false);
    expect(await readFile(join(wt, ".env.edited"), "utf8")).toBe("A=2\n");
    expect(existsSync(join(wt, ".env.tracked"))).toBe(true);
    expect(existsSync(join(path, ".env"))).toBe(true);
  });

  it("branchTip reads a local branch's commit, null when there is none", async () => {
    const { path, env } = await makeTempRepo();
    expect(await branchTip(path, "main")).toBe(git(path, env, "rev-parse", "main").trim());
    expect(await branchTip(path, "agent/none")).toBeNull();
  });

  it("removeWorktree refuses a dirty worktree", async () => {
    const { path } = await makeTempRepo();
    const wt = join(await tmp(), "wt");
    await createWorktree({ repoPath: path, worktreePath: wt, branch: "agent/r", baseRef: "main" });
    await writeFile(join(wt, "new.txt"), "x");
    await expect(removeWorktree(path, wt)).rejects.toBeInstanceOf(GitError);
    expect(existsSync(wt)).toBe(true);
  });

  it("removeWorktree removes a clean worktree; deleteBranch refuses non-agent branches", async () => {
    const { path, env } = await makeTempRepo();
    const wt = join(await tmp(), "wt");
    await createWorktree({ repoPath: path, worktreePath: wt, branch: "agent/r", baseRef: "main" });
    await removeWorktree(path, wt);
    expect(existsSync(wt)).toBe(false);
    await expect(deleteBranch(path, "main")).rejects.toThrow();
    expect(git(path, env, "branch", "--list", "main")).toContain("main");
    await deleteBranch(path, "agent/r");
    expect(git(path, env, "branch", "--list", "agent/r")).toBe("");
  });

  it("forgetWorktree drops only this worktree's record, keeping its branch", async () => {
    const { path, env } = await makeTempRepo();
    // Not realpath'd: on macOS tmpdir() is behind a symlink, and git records the real path.
    const root = await tmp();
    const a = join(root, "a");
    const b = join(root, "b");
    await createWorktree({ repoPath: path, worktreePath: a, branch: "agent/a", baseRef: "main" });
    await createWorktree({ repoPath: path, worktreePath: b, branch: "agent/b", baseRef: "main" });
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
    const listed = () => git(path, env, "worktree", "list", "--porcelain");

    await forgetWorktree(path, a);

    expect(listed()).not.toMatch(/\/a\n/);
    // Another worktree whose directory is also missing keeps its record.
    expect(listed()).toMatch(/\/b\n/);
    expect(git(path, env, "branch", "--list", "agent/a")).toContain("agent/a");
    // Nothing left to forget: a no-op.
    await forgetWorktree(path, a);
  });

  it("forgetWorktree finds a worktree git recorded with a relative path", async () => {
    const { path, env } = await makeTempRepo();
    // git 2.48+: the user's config can make git record worktree paths relative to its admin dir.
    git(path, env, "config", "worktree.useRelativePaths", "true");
    const wt = join(await tmp(), "rel");
    await createWorktree({ repoPath: path, worktreePath: wt, branch: "agent/rel", baseRef: "main" });
    const gitdirs = git(path, env, "worktree", "list", "--porcelain");
    expect(gitdirs).toMatch(/\/rel\n/);
    await rm(wt, { recursive: true, force: true });

    await forgetWorktree(path, wt);

    expect(git(path, env, "worktree", "list", "--porcelain")).not.toMatch(/\/rel\n/);
    // The record is gone, so the branch can be deleted later (the 14-day sweep).
    await deleteBranch(path, "agent/rel");
  });

  it("forgetWorktree refuses a locked worktree", async () => {
    const { path, env } = await makeTempRepo();
    const wt = join(await tmp(), "wt");
    await createWorktree({ repoPath: path, worktreePath: wt, branch: "agent/l", baseRef: "main" });
    git(path, env, "worktree", "lock", wt);
    await rm(wt, { recursive: true, force: true });
    await expect(forgetWorktree(path, wt)).rejects.toThrow(/locked/);
    expect(git(path, env, "worktree", "list", "--porcelain")).toMatch(/\/wt\n/);
  });
});
