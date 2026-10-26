import { resolve } from "node:path";
import { Command } from "commander";
import type { WtoClient } from "@wto/client";

// `pnpm wto` runs this script from apps/cli; INIT_CWD is the directory the user ran it in.
const userCwd = () => process.env.INIT_CWD ?? process.cwd();

export interface ProgramDeps {
  log?: (line: string) => void;
  /** The daemon's token, read from the owner-only token file. */
  readToken?: () => Promise<string | undefined>;
}

export function buildProgram(client: WtoClient, { log = console.log, readToken }: ProgramDeps = {}) {
  const program = new Command("wto").description("Run coding agents in parallel git worktrees");

  program
    .command("web")
    .description("print the link that opens the web app connected to this daemon")
    .option("--url <url>", "web app address", "http://localhost:5173")
    .action(async (opts: { url: string }) => {
      const token = await readToken?.();
      if (!token) throw new Error("no daemon running: start it with `pnpm daemon`");
      // The token travels in the URL fragment, which browsers never send to a server.
      log(`${opts.url}/#token=${token}`);
    });

  program
    .command("status")
    .description("check that the daemon is running")
    .action(async () => {
      const h = await client.health();
      log(`daemon ${h.daemonVersion} · protocol ${h.protocolVersion}`);
    });

  program
    .command("ls")
    .description("list tasks")
    .action(async () => {
      const tasks = await client.listTasks();
      if (tasks.length === 0) return log("no tasks");
      for (const t of tasks) log(`${t.id.slice(0, 8)}  ${t.status.padEnd(11)}  ${t.title}`);
    });

  program
    .command("new")
    .description("create a task")
    .argument("<prompt>", "what the agent should do")
    .option("-r, --repo <path>", "repository path (default: current directory)")
    .action(async (prompt: string, opts: { repo?: string }) => {
      const task = await client.createTask({ prompt, repoPath: resolve(userCwd(), opts.repo ?? ".") });
      log(`created ${task.id.slice(0, 8)} (${task.status})`);
    });

  return program;
}
