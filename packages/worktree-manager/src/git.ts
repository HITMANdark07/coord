import { execFile } from "node:child_process";

export class GitError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly stderr: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export type GitOptions = {
  cwd: string;
  env?: Record<string, string>;
  input?: string;
  maxBuffer?: number;
};

/**
 * Every git call goes through here: execFile, no shell. Tests pass `env` for a git identity;
 * production passes nothing so the user's own identity and signing config apply.
 */
export function git(args: string[], opts: GitOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        const exitCode = typeof e.code === "number" ? e.code : -1;
        const command = `git ${args.join(" ")}`;
        const error = new GitError(
          `${command} failed: ${stderr.trim() || e.message}`,
          command,
          stderr,
          exitCode,
        );
        // Callers that tolerate a capped buffer (diff patches) read the partial output.
        (error as GitError & { stdout?: string }).stdout = stdout;
        reject(error);
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}
