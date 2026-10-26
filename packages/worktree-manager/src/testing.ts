import { execFile } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A fixed identity, and no global or system git config: the developer's own config (signing,
 * hooksPath, diff settings, init.defaultBranch) must not change what the tests see.
 */
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/**
 * Temp repo with one commit on `main`; optionally a bare `origin` that main is pushed to. Pass
 * the returned `env` to git calls (and as the runner's `gitEnv`) to keep them isolated too.
 */
export async function makeTempRepo(
  opts: { withOrigin?: boolean } = {},
): Promise<{ path: string; origin?: string; env: Record<string, string> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coord-wm-")));
  const path = join(root, "repo");
  const env: Record<string, string> = { ...GIT_ENV };
  const git = (cwd: string, ...args: string[]) => run("git", args, { cwd, env: { ...process.env, ...env } });

  await run("git", ["init", "-b", "main", path], { env: { ...process.env, ...env } });
  await writeFile(join(path, "README.md"), "hello\n");
  await git(path, "add", "-A");
  await git(path, "-c", "commit.gpgsign=false", "commit", "-m", "init");

  if (!opts.withOrigin) return { path, env };
  const origin = join(root, "origin.git");
  await run("git", ["init", "--bare", "-b", "main", origin], { env: { ...process.env, ...env } });
  await git(path, "remote", "add", "origin", origin);
  await git(path, "push", "-u", "origin", "main");
  await git(path, "remote", "set-head", "origin", "main");
  return { path, origin, env };
}
