import { spawn } from "node:child_process";
import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { GitError, git } from "./git";

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
  await git(["worktree", "add", "--no-track", "-b", opts.branch, opts.worktreePath, opts.baseRef], {
    cwd: opts.repoPath,
  });
}

export async function copyEnvFiles(
  repoPath: string,
  worktreePath: string,
  files: string[],
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
    await mkdir(dirname(join(worktreePath, rel)), { recursive: true });
    await copyFile(join(repoPath, rel), join(worktreePath, rel));
    copied.push(file);
  }
  return copied;
}

const OUTPUT_CAP = 64 * 1024;

export type RunResult = { ok: true } | { ok: false; command: string; exitCode: number; output: string };

export async function runCommands(
  commands: string[],
  opts: { cwd: string; env: Record<string, string>; signal?: AbortSignal },
): Promise<RunResult> {
  for (const command of commands) {
    const r = await runOne(command, opts);
    if (r.exitCode !== 0) return { ok: false, command, ...r };
  }
  return { ok: true };
}

function runOne(
  command: string,
  opts: { cwd: string; env: Record<string, string>; signal?: AbortSignal },
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    // Setup commands are user-configured shell lines, hence sh -c.
    const child = spawn("sh", ["-c", command], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const onData = (d: Buffer) => {
      output += d.toString();
      // Keep the tail: the failure reason is at the end.
      if (output.length > OUTPUT_CAP) output = output.slice(-OUTPUT_CAP);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    };
    if (opts.signal?.aborted) kill();
    opts.signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => resolve({ exitCode: -1, output: output + e.message }));
    child.on("close", (code, sig) => {
      opts.signal?.removeEventListener("abort", kill);
      resolve({ exitCode: code ?? (sig ? 128 : -1), output });
    });
  });
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  // No --force: git refuses a worktree with changes, which is the point (never lose work).
  await git(["worktree", "remove", worktreePath], { cwd: repoPath });
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  if (!branch.startsWith("agent/")) {
    throw new Error(`refusing to delete non-agent branch "${branch}"`);
  }
  await git(["branch", "-D", branch], { cwd: repoPath });
}
