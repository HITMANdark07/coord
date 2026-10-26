import { GitError, git } from "./git";

export class CommitError extends GitError {
  constructor(cause: GitError) {
    super(cause.message, cause.command, cause.stderr, cause.exitCode);
    this.name = "CommitError";
  }
}

export async function hasChanges(cwd: string, env?: Record<string, string>): Promise<boolean> {
  return (await git(["status", "--porcelain"], { cwd, env })).trim().length > 0;
}

async function hasStagedChanges(cwd: string, env?: Record<string, string>): Promise<boolean> {
  return (await git(["diff", "--cached", "--name-only"], { cwd, env })).trim().length > 0;
}

export async function commitTurn(opts: {
  cwd: string;
  /** The `agent/` branch this task owns; HEAD must still be on it. */
  branch: string;
  message: string;
  trailers: string[];
  /**
   * Paths (relative to `cwd`) never staged: the env files Coord copied in hold secrets, and
   * the repo may not ignore them. They stay on disk, uncommitted.
   */
  exclude?: string[];
  env?: Record<string, string>;
}): Promise<{ committed: false } | { committed: true; sha: string }> {
  const { cwd, env } = opts;
  // The agent can switch branches or detach HEAD; Coord only commits to its own agent/ branch.
  let head = "";
  try {
    head = (await git(["symbolic-ref", "--short", "HEAD"], { cwd, env })).trim();
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
  }
  if (!opts.branch.startsWith("agent/") || head !== opts.branch) {
    throw new CommitError(
      new GitError(
        `HEAD is not on the task branch ${opts.branch} (HEAD: ${head || "detached"})`,
        "commitTurn",
        "",
        -1,
      ),
    );
  }
  const exclude = opts.exclude ?? [];
  const excluded = exclude.map((f) => `:(exclude,literal)${f}`);
  await git(["add", "-A", "--", ".", ...excluded], { cwd, env });
  // The exclude only keeps Coord's own `git add` off them: one the agent staged itself is unstaged
  // here, or the commit would carry its secrets. (`git reset` treats an unborn HEAD as empty.)
  if (exclude.length > 0) {
    await git(["reset", "-q", "--", ...exclude.map((f) => `:(literal)${f}`)], { cwd, env });
  }
  // Staged, not `status`: an excluded file that changed is not a reason to commit.
  if (!(await hasStagedChanges(cwd, env))) return { committed: false };
  const body = opts.trailers.length
    ? `${opts.message}\n\n${opts.trailers.join("\n")}\n`
    : `${opts.message}\n`;
  try {
    // --no-verify: the user's hooks must not block an automatic checkpoint.
    await git(["commit", "--no-verify", "-F", "-"], { cwd, env, input: body });
  } catch (e) {
    throw e instanceof GitError ? new CommitError(e) : e;
  }
  return { committed: true, sha: (await git(["rev-parse", "HEAD"], { cwd, env })).trim() };
}
