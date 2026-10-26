import { resolve } from "node:path";
import { Command, Option } from "commander";
import type { CoordClient, DaemonEventListener } from "@coord/client";
import { resolvePermission, resolveTaskId } from "./resolve-task";

// `pnpm coord` runs this script from apps/cli; INIT_CWD is the directory the user ran it in.
const userCwd = () => process.env.INIT_CWD ?? process.cwd();

export interface ProgramDeps {
  log?: (line: string) => void;
  /** Where errors and hints go (stderr). */
  logError?: (line: string) => void;
  /** The daemon's token, read from the owner-only token file. */
  readToken?: () => Promise<string | undefined>;
  /** Sets the process exit code (`coord watch`). Default: `process.exitCode`. */
  exit?: (code: number) => void;
}

type DaemonEvent = Parameters<NonNullable<DaemonEventListener["onEvent"]>>[0];
type Task = Awaited<ReturnType<CoordClient["getTask"]>>;
type PermissionRequestView = Awaited<ReturnType<CoordClient["listPermissions"]>>[number];

/** Statuses `coord watch` stops at, with the exit code each gives. */
const WATCH_END: Record<string, number> = {
  review: 0,
  cancelled: 0,
  merged: 0,
  cleaned_up: 0,
  failed: 1,
  interrupted: 1,
};

/**
 * C0 and C1 control characters (other than tab and newline, which callers render) and format
 * characters (bidi overrides, zero-width and direction marks). Agent text and tool input reach the
 * terminal through here: an ESC sequence could erase or recolor part of a command the user is
 * about to allow, a bidi override reorder it, a zero-width character hide a difference.
 */
const CONTROL = /(?![\t\n])[\p{Cc}\p{Cf}]/gu;
const stripControl = (text: string) => text.replace(CONTROL, "");

/**
 * One terminal-safe line of at most `max` characters. `cut: "middle"` keeps the end, for paths
 * whose file name is what the user must see (acceptance run 2, D3).
 */
const oneLine = (text: string, max = 200, cut: "end" | "middle" = "end") => {
  const flat = stripControl(text).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  if (cut === "end") return `${flat.slice(0, max - 1)}…`;
  const tail = Math.ceil(((max - 1) * 2) / 3);
  return `${flat.slice(0, max - 1 - tail)}…${flat.slice(-tail)}`;
};

/** Tools whose input names the file they change; the path is what the user must judge. */
const FILE_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];
const SUMMARY_MAX = 120;

/**
 * What a permission prompt would let the agent do, on one line (acceptance D2): the tool name
 * alone can't be judged. The Bash command, the file an edit writes, or else the input as JSON.
 * A newline shows as ⏎: a second line of a Bash command is a second command.
 */
function inputSummary(p: Pick<PermissionRequestView, "tool" | "input">): string {
  const input = (typeof p.input === "object" && p.input !== null ? p.input : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) =>
    keys.map((k) => input[k]).find((v) => typeof v === "string") as string | undefined;
  const path = FILE_TOOLS.includes(p.tool) ? pick("file_path", "notebook_path", "path") : undefined;
  if (path !== undefined) return oneLine(path, SUMMARY_MAX, "middle");
  const text = (p.tool === "Bash" ? pick("command") : undefined) ?? JSON.stringify(p.input) ?? "";
  return oneLine(text.replace(/\r?\n/g, "⏎"), SUMMARY_MAX);
}

/** `<tool> <input summary>`: what a permission answer applies to. */
function describeAction(p: Pick<PermissionRequestView, "tool" | "input">, sep = " "): string {
  const summary = inputSummary(p);
  return `${oneLine(p.tool)}${summary ? `${sep}${summary}` : ""}`;
}

/** `<tool> <input summary> (<title>)`, plus whether `coord allow --always` applies. */
function describePermission(p: PermissionRequestView, sep = " "): string {
  return (
    describeAction(p, sep) +
    `${p.title ? `${sep}(${oneLine(p.title)})` : ""}` +
    `${p.canRemember ? "  [--always available]" : ""}`
  );
}

/**
 * The whole tool input, indented under a pending permission in `coord show`: the summary leaves
 * fields out. JSON escapes C0 controls; C1 controls and bidi overrides are escaped the same way,
 * so the user sees they are there.
 */
function fullInput(input: unknown, indent: string): string[] {
  const escape = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  return (JSON.stringify(input, null, 2) ?? "undefined")
    .split("\n")
    .map((l) => indent + l.replace(CONTROL, escape));
}

/** A task parked by a failed commit: needs_input with an error and no agent waiting on a prompt. */
async function parkedError(client: CoordClient, task: Task): Promise<string | undefined> {
  if (task.status !== "needs_input" || !task.error) return undefined;
  const pending = await client.listPermissions(task.id);
  return pending.length === 0 ? task.error : undefined;
}

/** One printable line for an event of this task, or undefined for events not worth printing. */
function describeEvent(event: DaemonEvent, taskId: string): string | undefined {
  const p = event.payload;
  switch (p.kind) {
    case "task.updated":
      return p.task.id === taskId ? `status: ${p.task.status}` : undefined;
    case "permission.requested":
      return p.request.taskId === taskId
        ? `permission ${p.request.id}: ${describePermission(p.request)}`
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
  {
    log = console.log,
    logError = console.error,
    readToken,
    exit = (code) => void (process.exitCode = code),
  }: ProgramDeps = {},
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
    .argument("<prompt>", "what the agent should do (use `--` first if it starts with -)")
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
      log(`${task.id}  ${stripControl(task.title)}`);
      log(`status:   ${task.status}`);
      log(`branch:   ${task.branch ?? "-"}`);
      log(`worktree: ${task.worktreePath ?? "-"}`);
      log(
        `usage:    ${task.inputTokens} in / ${task.outputTokens} out tokens · $${task.costUsd.toFixed(4)} · ${task.turns} turns`,
      );
      if (task.error) log(`error:    ${stripControl(task.error)}`);
      if (pending.length > 0) {
        log("pending permissions:");
        for (const p of pending) {
          log(`  ${p.id}  ${describePermission(p, "  ")}`);
          for (const l of fullInput(p.input, "      ")) log(l);
        }
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
        const finish = (code: number, line?: string, toError = false) => {
          if (finished) return;
          finished = true;
          if (line) (toError ? logError : log)(line);
          unsubscribe?.();
          exit(code);
          done();
        };
        const check = (task: Task) => {
          const code = WATCH_END[task.status];
          if (code === undefined) {
            // Parked by a failed commit, nothing will move the task on by itself: report it.
            parkedError(client, task).then(
              (error) => {
                if (error !== undefined) {
                  finish(1, `needs input: ${error}\nsend a message to retry the commit, or discard`, true);
                }
              },
              (err: unknown) => finish(1, err instanceof Error ? err.message : String(err), true),
            );
            return;
          }
          if (task.status === "interrupted") {
            finish(code, `interrupted; resume it with coord resume ${taskId.slice(0, 8)}`, true);
          } else finish(code, `task ${task.status}`);
        };
        unsubscribe = client.subscribe({
          onEvent: (event) => {
            const line = describeEvent(event, taskId);
            if (line) log(line);
            if (event.payload.kind === "task.updated" && event.payload.task.id === taskId) {
              check(event.payload.task);
            }
          },
          onStatus: (s) => {
            if (s === "closed") return finish(1, "connection to the daemon lost", true);
            // The daemon never replays events, and a socket delivers nothing before it opens: a
            // transition before this point is only visible in the task itself, so read it now.
            client.getTask(taskId).then(
              (task) => {
                if (finished) return;
                log(`status: ${task.status}`);
                check(task);
              },
              (err: unknown) => finish(1, err instanceof Error ? err.message : String(err), true),
            );
          },
        });
      });
    });

  program
    .command("allow")
    .description("allow a pending permission request")
    .argument("<permissionId>", "permission id or unique prefix")
    .option("--always", "also allow it for the rest of the session")
    .action(async (input: string, opts: { always?: boolean }) => {
      const p = await resolvePermission(client, input);
      await client.answerPermission(p.id, { allow: true, ...(opts.always && { remember: true }) });
      // What was allowed, not only its id: a prefix could have matched another prompt than meant.
      log(`allowed ${p.id}${opts.always ? " (always)" : ""}: ${describeAction(p)}`);
    });

  program
    .command("deny")
    .description("deny a pending permission request")
    .argument("<permissionId>", "permission id or unique prefix")
    .option("--reason <text>", "tell the agent why")
    .action(async (input: string, opts: { reason?: string }) => {
      const p = await resolvePermission(client, input);
      await client.answerPermission(p.id, {
        allow: false,
        ...(opts.reason !== undefined && { reason: opts.reason }),
      });
      log(`denied ${p.id}: ${describeAction(p)}`);
    });

  program
    .command("msg")
    .description("send a message to a task's agent")
    .argument("<id>", "task id or unique prefix")
    .argument("<text>", "the message (use `--` first if it starts with -)")
    .action(async (input: string, text: string) => {
      const task = await client.sendMessage(await id(input), text);
      // A busy agent gets the message as its next turn, not mid-turn (the SDK would fold it in).
      log(
        task.status === "running" || task.status === "needs_input"
          ? `queued for ${task.id.slice(0, 8)}: delivered when the current turn ends`
          : `sent to ${task.id.slice(0, 8)} (${task.status})`,
      );
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
