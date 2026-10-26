import { execFile } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** Temp repo with one commit on `main`; optionally a bare `origin` that main is pushed to. */
export async function makeTempRepo(
  opts: { withOrigin?: boolean } = {},
): Promise<{ path: string; origin?: string; env: Record<string, string> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coord-wm-")));
  const path = join(root, "repo");
  const env: Record<string, string> = { ...IDENTITY };
  const git = (cwd: string, ...args: string[]) => run("git", args, { cwd, env: { ...process.env, ...env } });

  await run("git", ["init", "-b", "main", path], { env: { ...process.env, ...env } });
  await writeFile(join(path, "README.md"), "hello\n");
  await git(path, "add", "-A");
  await git(path, "-c", "commit.gpgsign=false", "commit", "-m", "init");

  if (!opts.withOrigin) return { path, env };
  const origin = join(root, "origin.git");
  await run("git", ["init", "--bare", "-b", "main", origin]);
  await git(path, "remote", "add", "origin", origin);
  await git(path, "push", "-u", "origin", "main");
  await git(path, "remote", "set-head", "origin", "main");
  return { path, origin, env };
}
