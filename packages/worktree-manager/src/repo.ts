import { basename } from "node:path";
import { RepoConfig } from "@coord/protocol";
import { GitError, git } from "./git";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

async function tryGit(args: string[], cwd: string): Promise<string | null> {
  try {
    return (await git(args, { cwd })).trim();
  } catch (e) {
    if (e instanceof GitError) return null;
    throw e;
  }
}

export async function readRepoInfo(
  path: string,
): Promise<{ name: string; root: string; defaultBranch: string; remoteUrl: string | null }> {
  const top = (await git(["rev-parse", "--show-toplevel"], { cwd: path })).trim();
  const head = await tryGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], path);
  const current = await tryGit(["branch", "--show-current"], path);
  const defaultBranch = head?.replace(/^origin\//, "") || current || "main";
  const remoteUrl = (await tryGit(["remote", "get-url", "origin"], path)) || null;
  // `root` is git's canonical top level, so one repo has one spelling however it was reached.
  return { name: basename(top), root: top, defaultBranch, remoteUrl };
}

export async function resolveBaseRef(
  repoPath: string,
  base: string,
): Promise<{ ref: string; fetched: boolean }> {
  const remotes = (await git(["remote"], { cwd: repoPath })).split("\n");
  if (!remotes.includes("origin")) return { ref: base, fetched: false };
  const ref = `origin/${base}`;
  try {
    // --end-of-options: `base` comes from a client or the repo's config; "--upload-pack=<cmd>"
    // must be a (bad) refspec, never an option that runs a command.
    await git(["fetch", "--end-of-options", "origin", base], { cwd: repoPath });
    return { ref, fetched: true };
  } catch (e) {
    // Offline: a previously fetched origin/<base> is still a sound starting point.
    if (
      e instanceof GitError &&
      (await tryGit(["rev-parse", "--verify", "--end-of-options", ref], repoPath))
    ) {
      return { ref, fetched: false };
    }
    throw e;
  }
}

/** Like `resolveBaseRef` but never touches the network: reads (diff) must not fetch. */
export async function localBaseRef(repoPath: string, base: string): Promise<string> {
  const ref = `origin/${base}`;
  return (await tryGit(["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`], repoPath)) === null
    ? base
    : ref;
}

export async function readRepoConfig(repoPath: string, ref: string): Promise<RepoConfig> {
  // --end-of-options throughout: `ref` is derived from a base branch name (`git show --output=`
  // would write a file).
  await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd: repoPath });
  const spec = `${ref}:.coord/config.json`;
  if ((await tryGit(["cat-file", "-e", "--end-of-options", spec], repoPath)) === null) {
    return RepoConfig.parse({});
  }
  const raw = await git(["show", "--end-of-options", spec], { cwd: repoPath });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`.coord/config.json is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = RepoConfig.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`.coord/config.json is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** True when git failed because the path is not inside a repository (as opposed to git itself failing). */
export function isNotARepoError(e: unknown): boolean {
  return e instanceof GitError && /not a git repository/i.test(e.stderr);
}
