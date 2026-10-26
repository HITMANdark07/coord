import { access, copyFile, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { GitError, git } from "./git";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", ref], { cwd: repoPath });
    return true;
  } catch (e) {
    if (e instanceof GitError) return false;
    throw e;
  }
}

export async function uniqueBranch(repoPath: string, desired: string): Promise<string> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? desired : `${desired}-${n}`;
    const taken =
      (await refExists(repoPath, `refs/heads/${name}`)) ||
      (await refExists(repoPath, `refs/remotes/origin/${name}`));
    if (!taken) return name;
  }
}

export async function createWorktree(opts: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
}): Promise<void> {
  await mkdir(dirname(opts.worktreePath), { recursive: true });
  // --no-track: the agent branch must not pull from or push to the base by accident.
  // --end-of-options: the base ref is derived from a client's or the config's branch name.
  await git(
    ["worktree", "add", "--no-track", "-b", opts.branch, "--end-of-options", opts.worktreePath, opts.baseRef],
    {
      cwd: opts.repoPath,
    },
  );
}

export async function copyEnvFiles(
  repoPath: string,
  worktreePath: string,
  files: string[],
  /** Leave a file the worktree already has: on a setup retry the user may have fixed it there. */
  opts: { skipExisting?: boolean } = {},
): Promise<string[]> {
  const copied: string[] = [];
  for (const file of files) {
    const rel = normalize(file);
    // Config comes from the repo; never let it copy from or to outside the checkout.
    if (isAbsolute(rel) || rel.startsWith("..")) continue;
    try {
      await access(join(repoPath, rel));
    } catch {
      continue;
    }
    if (opts.skipExisting && (await exists(join(worktreePath, rel)))) continue;
    await mkdir(dirname(join(worktreePath, rel)), { recursive: true });
    await copyFile(join(repoPath, rel), join(worktreePath, rel));
    // Normalized: the caller excludes these paths from commits by exact path.
    copied.push(rel);
  }
  return copied;
}

/**
 * Deletes the worktree's copies of env files that are untracked there and still identical to
 * the user's checkout, so `removeWorktree` (which refuses untracked files) can go ahead. A copy
 * the agent changed, or a tracked file, stays: removing the worktree then fails and says why.
 */
export async function removeEnvCopies(
  repoPath: string,
  worktreePath: string,
  files: string[],
): Promise<void> {
  for (const file of files) {
    // -uall: with the user's status.showUntrackedFiles=no the copy wouldn't be listed at all.
    const status = await git(["status", "--porcelain", "-z", "-uall", "--", `:(literal)${file}`], {
      cwd: worktreePath,
    });
    if (status !== `?? ${file}\0`) continue;
    const [original, copy] = await Promise.all([
      readFile(join(repoPath, file)).catch(() => null),
      readFile(join(worktreePath, file)),
    ]);
    if (original !== null && original.equals(copy)) await rm(join(worktreePath, file));
  }
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  // No --force: git refuses a worktree with changes, which is the point (never lose work). Its
  // check is `git status`, which the user's status.showUntrackedFiles=no would blind to untracked
  // files (an edited env copy, say), and those would be deleted with the worktree.
  await git(["-c", "status.showUntrackedFiles=all", "worktree", "remove", worktreePath], { cwd: repoPath });
}

/** The real path of `path`, which may not exist: its nearest existing ancestor is resolved. */
async function realpathMissing(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (e) {
    const parent = dirname(path);
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw e;
    return join(await realpathMissing(parent), basename(path));
  }
}

/**
 * Drops git's record of one worktree whose directory is gone (deleted by hand). Unlike
 * `git worktree prune`, the user's other worktrees are left alone, missing or not. The branch
 * stays; a locked worktree is refused, as `git worktree prune` would keep it too.
 */
export async function forgetWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const common = resolve(repoPath, (await git(["rev-parse", "--git-common-dir"], { cwd: repoPath })).trim());
  const admin = join(common, "worktrees");
  // git records the real path of the worktree's .git file.
  const targets = new Set([resolve(worktreePath), await realpathMissing(resolve(worktreePath))]);
  let entries: string[];
  try {
    entries = await readdir(admin);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  for (const name of entries) {
    let gitdir: string;
    try {
      gitdir = (await readFile(join(admin, name, "gitdir"), "utf8")).trim();
    } catch {
      continue;
    }
    // With worktree.useRelativePaths (git 2.48+) the path is relative to the admin entry.
    if (!targets.has(dirname(resolve(admin, name, gitdir)))) continue;
    if (await exists(join(admin, name, "locked"))) {
      throw new Error(`worktree ${worktreePath} is locked; unlock it with \`git worktree unlock\``);
    }
    await rm(join(admin, name), { recursive: true, force: true });
  }
}

/** The commit `refs/heads/<branch>` points at, or null when there is no such branch. */
export async function branchTip(repoPath: string, branch: string): Promise<string | null> {
  try {
    return (
      await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath })
    ).trim();
  } catch (e) {
    if (e instanceof GitError) return null;
    throw e;
  }
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  if (!branch.startsWith("agent/")) {
    throw new Error(`refusing to delete non-agent branch "${branch}"`);
  }
  await git(["branch", "-D", branch], { cwd: repoPath });
}
