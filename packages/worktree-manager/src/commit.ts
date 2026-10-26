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

export async function commitTurn(opts: {
  cwd: string;
  message: string;
  trailers: string[];
  env?: Record<string, string>;
}): Promise<{ committed: false } | { committed: true; sha: string }> {
  const { cwd, env } = opts;
  await git(["add", "-A"], { cwd, env });
  if (!(await hasChanges(cwd, env))) return { committed: false };
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
