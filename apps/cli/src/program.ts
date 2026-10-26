import { resolve } from "node:path";
import { Command, Option } from "commander";
import type { CoordClient, DaemonEventListener } from "@coord/client";
import { resolveTaskId } from "./resolve-task";

// `pnpm coord` runs this script from apps/cli; INIT_CWD is the directory the user ran it in.
const userCwd = () => process.env.INIT_CWD ?? process.cwd();

export interface ProgramDeps {
  log?: (line: string) => void;
  /** The daemon's token, read from the owner-only token file. */
  readToken?: () => Promise<string | undefined>;
  /** Sets the process exit code (`coord watch`). Default: `process.exitCode`. */
  exit?: (code: number) => void;
}

type DaemonEvent = Parameters<NonNullable<DaemonEventListener["onEvent"]>>[0];

/** Statuses `coord watch` stops at, with the exit code each gives. */
const WATCH_END: Record<string, number> = { review: 0, cancelled: 0, merged: 0, cleaned_up: 0, failed: 1 };

const oneLine = (text: string, max = 200) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** One printable line for an event of this task, or undefined for events not worth printing. */
function describeEvent(event: DaemonEvent, taskId: string): string | undefined {
  const p = event.payload;
  switch (p.kind) {
    case "task.updated":
      return p.task.id === taskId ? `status: ${p.task.status}` : undefined;
    case "permission.requested":
      return p.request.taskId === taskId
        ? `permission ${p.request.id}: ${p.request.tool}${p.request.title ? ` (${oneLine(p.request.title)})` : ""}`
        : undefined;
    case "permission.resolved":
      return p.taskId === taskId ? `permission ${p.requestId}: ${p.outcome}` : undefined;
    case "agent.event": {
      if (p.taskId !== taskId) return undefined;
      const e = p.event;
      switch (e.type) {
        case "text":
          return oneLine(e.text);
        case "tool_call":
          return `tool: ${e.name}`;
        case "tool_result":
          return e.ok ? undefined : "tool failed";
        case "usage":
          return undefined;
        case "done":
          return e.summary ? `done: ${oneLine(e.summary)}` : "done";
        case "error":
          return `error: ${oneLine(e.message)}`;
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

export function buildProgram(
  client: CoordClient,
  { log = console.log, readToken, exit = (code) => void (process.exitCode = code) }: ProgramDeps = {},
) {
  const program = new Command("coord").description("Run coding agents in parallel git worktrees");
  const id = (input: string) => resolveTaskId(client, input);

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

  const repo = program.command("repo").description("manage repositories");
  repo
    .command("add")
    .description("register a repository (default: current directory)")
    .argument("[path]", "path inside the repository")
    .action(async (path: string | undefined) => {
      const added = await client.addRepo(resolve(userCwd(), path ?? "."));
      log(`added ${added.name} (${added.path})`);
    });
  repo
    .command("ls")
    .description("list registered repositories")
    .action(async () => {
      const repos = await client.listRepos();
      if (repos.length === 0) return log("no repos: add one with `coord repo add`");
      for (const r of repos) log(`${r.name}  ${r.path}`);
    });

  program
    .command("ls")
    .description("list tasks")
    .option("--all", "include discarded and cleaned-up tasks")
    .action(async (opts: { all?: boolean }) => {
      const tasks = await client.listTasks({ all: opts.all === true });
      if (tasks.length === 0) return log("no tasks");
      for (const t of tasks) log(`${t.id.slice(0, 8)}  ${t.status.padEnd(11)}  ${t.title}`);
    });

  program
    .command("new")
    .description("create a task")
    .argument("<prompt>", "what the agent should do")
    .option("-r, --repo <path>", "repository path (default: current directory)")
    .addOption(new Option("--agent <agent>", "which agent runs it").choices(["claude-code", "codex"]))
    .option("--model <model>", "model the agent uses")
    .option("--branch <branch>", "branch name (must start with agent/)")
    .option("--base <branch>", "branch to start from")
    .addOption(
      new Option("--permission <mode>", "how tool calls are approved").choices(["ask", "accept_edits"]),
    )
    .action(
      async (
        prompt: string,
        opts: {
          repo?: string;
          agent?: "claude-code" | "codex";
          model?: string;
          branch?: string;
          base?: string;
          permission?: "ask" | "accept_edits";
        },
      ) => {
        const task = await client.createTask({
          prompt,
          repoPath: resolve(userCwd(), opts.repo ?? "."),
          ...(opts.agent && { agent: opts.agent }),
          ...(opts.model && { model: opts.model }),
          ...(opts.branch && { branch: opts.branch }),
          ...(opts.base && { baseBranch: opts.base }),
          ...(opts.permission && { permissionMode: opts.permission }),
        });
        log(`created ${task.id.slice(0, 8)} (${task.status})`);
      },
    );

  program
    .command("show")
    .description("show a task, its recent events and pending permissions")
    .argument("<id>", "task id or unique prefix")
    .action(async (input: string) => {
      const taskId = await id(input);
      const [task, events, pending] = await Promise.all([
        client.getTask(taskId),
        client.taskEvents(taskId),
        client.listPermissions(taskId),
      ]);
      log(`${task.id}  ${task.title}`);
      log(`status:   ${task.status}`);
      log(`branch:   ${task.branch ?? "-"}`);
      log(`worktree: ${task.worktreePath ?? "-"}`);
      log(
        `usage:    ${task.inputTokens} in / ${task.outputTokens} out tokens · $${task.costUsd.toFixed(4)} · ${task.turns} turns`,
      );
      if (task.error) log(`error:    ${task.error}`);
      if (pending.length > 0) {
        log("pending permissions:");
        for (const p of pending) log(`  ${p.id}  ${p.tool}${p.title ? `  ${oneLine(p.title)}` : ""}`);
      }
      const lines = events.flatMap((e) => describeEvent(e, taskId) ?? []).slice(-20);
      if (lines.length > 0) {
        log("recent events:");
        for (const l of lines) log(`  ${l}`);
      }
    });

  program
    .command("watch")
    .description("print a task's events until it reaches review, failed or cancelled")
    .argument("<id>", "task id or unique prefix")
    .action(async (input: string) => {
      const taskId = await id(input);
      await new Promise<void>((done) => {
        let finished = false;
        let unsubscribe: (() => void) | undefined = undefined;
        const finish = (code: number, line?: string) => {
          if (finished) return;
          finished = true;
          if (line) log(line);
          unsubscribe?.();
          exit(code);
          done();
        };
        const check = (status: string) => {
          const code = WATCH_END[status];
          if (code !== undefined) finish(code, `task ${status}`);
        };
        // Subscribe before reading the task: a transition between the two can't be missed.
        unsubscribe = client.subscribe({
          onEvent: (event) => {
            const line = describeEvent(event, taskId);
            if (line) log(line);
            if (event.payload.kind === "task.updated" && event.payload.task.id === taskId) {
              check(event.payload.task.status);
            }
          },
          onStatus: (s) => {
            if (s === "closed") finish(1, "connection to the daemon lost");
          },
        });
        client.getTask(taskId).then(
          (task) => {
            if (finished) return;
            log(`status: ${task.status}`);
            check(task.status);
          },
          (err: unknown) => finish(1, err instanceof Error ? err.message : String(err)),
        );
      });
    });

  program
    .command("allow")
    .description("allow a pending permission request")
    .argument("<permissionId>")
    .option("--always", "also allow it for the rest of the session")
    .action(async (permissionId: string, opts: { always?: boolean }) => {
      await client.answerPermission(permissionId, { allow: true, ...(opts.always && { remember: true }) });
      log(`allowed ${permissionId}${opts.always ? " (always)" : ""}`);
    });

  program
    .command("deny")
    .description("deny a pending permission request")
    .argument("<permissionId>")
    .option("--reason <text>", "tell the agent why")
    .action(async (permissionId: string, opts: { reason?: string }) => {
      await client.answerPermission(permissionId, {
        allow: false,
        ...(opts.reason !== undefined && { reason: opts.reason }),
      });
      log(`denied ${permissionId}`);
    });

  program
    .command("msg")
    .description("send a message to a task's agent")
    .argument("<id>", "task id or unique prefix")
    .argument("<text>")
    .action(async (input: string, text: string) => {
      const task = await client.sendMessage(await id(input), text);
      log(`sent to ${task.id.slice(0, 8)} (${task.status})`);
    });

  const actions = [
    ["interrupt", "stop the agent's current turn", (i: string) => client.interrupt(i)],
    ["cancel", "cancel a task", (i: string) => client.cancel(i)],
    ["discard", "discard a task and its worktree", (i: string) => client.discard(i)],
    ["resume", "resume an interrupted or finished task", (i: string) => client.resumeTask(i)],
  ] as const;
  for (const [name, description, act] of actions) {
    program
      .command(name)
      .description(description)
      .argument("<id>", "task id or unique prefix")
      .action(async (input: string) => {
        const task = await act(await id(input));
        log(`${task.id.slice(0, 8)} ${task.status}`);
      });
  }

  program
    .command("diff")
    .description("print a task's diff")
    .argument("<id>", "task id or unique prefix")
    .action(async (input: string) => {
      const diff = await client.taskDiff(await id(input));
      log(diff.patch);
      if (diff.truncated) log("(diff truncated)");
    });

  return program;
}
