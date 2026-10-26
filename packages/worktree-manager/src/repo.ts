import { access } from "node:fs/promises";
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
): Promise<{ name: string; defaultBranch: string; remoteUrl: string | null }> {
  const top = (await git(["rev-parse", "--show-toplevel"], { cwd: path })).trim();
  const head = await tryGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], path);
  const current = await tryGit(["branch", "--show-current"], path);
  const defaultBranch = head?.replace(/^origin\//, "") || current || "main";
  const remoteUrl = (await tryGit(["remote", "get-url", "origin"], path)) || null;
  return { name: basename(top), defaultBranch, remoteUrl };
}

export async function resolveBaseRef(
  repoPath: string,
  base: string,
): Promise<{ ref: string; fetched: boolean }> {
  const remotes = (await git(["remote"], { cwd: repoPath })).split("\n");
  if (!remotes.includes("origin")) return { ref: base, fetched: false };
  const ref = `origin/${base}`;
  try {
    await git(["fetch", "origin", base], { cwd: repoPath });
    return { ref, fetched: true };
  } catch (e) {
    // Offline: a previously fetched origin/<base> is still a sound starting point.
    if (e instanceof GitError && (await tryGit(["rev-parse", "--verify", ref], repoPath))) {
      return { ref, fetched: false };
    }
    throw e;
  }
}

export async function readRepoConfig(repoPath: string, ref: string): Promise<RepoConfig> {
  await git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoPath });
  const spec = `${ref}:.coord/config.json`;
  if ((await tryGit(["cat-file", "-e", spec], repoPath)) === null) return RepoConfig.parse({});
  const raw = await git(["show", spec], { cwd: repoPath });
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

export async function detectSetupCommands(worktreePath: string): Promise<string[]> {
  const has = (f: string) =>
    access(`${worktreePath}/${f}`).then(
      () => true,
      () => false,
    );
  if (await has("pnpm-lock.yaml")) return ["pnpm install --frozen-lockfile"];
  if (await has("package-lock.json")) return ["npm ci"];
  if (await has("yarn.lock")) return ["yarn install --frozen-lockfile"];
  if ((await has("bun.lock")) || (await has("bun.lockb"))) return ["bun install"];
  return [];
}
