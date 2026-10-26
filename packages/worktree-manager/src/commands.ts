import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

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
