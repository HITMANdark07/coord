import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AgentAdapter,
  AgentEvent,
  AgentId,
  AgentRun,
  PermissionRequest,
  RunContext,
  RunOptions,
  TaskSpec,
} from "@coord/protocol";

/** One scripted step of a fake agent turn. */
export type FakeStep =
  | { event: AgentEvent }
  | { permission: PermissionRequest }
  | { edit: { file: string; content: string } }
  | { waitForMessage: true };

export type FakeAdapter = AgentAdapter & {
  calls: {
    start: TaskSpec[];
    resume: Array<{ sessionId: string; message: string; options?: RunOptions }>;
    /** Messages delivered with `send()` while a run was live. */
    send: string[];
  };
  /** Resolves once every agent process this fake started has finished. */
  settled(): Promise<void>;
};

const isTurnEnd = (s: FakeStep) => "event" in s && (s.event.type === "done" || s.event.type === "error");

/** Splits the script into turns: each ends with (and includes) a `done` or `error` event. */
function toTurns(script: FakeStep[]): FakeStep[][] {
  const turns: FakeStep[][] = [[]];
  for (const step of script) {
    turns.at(-1)!.push(step);
    if (isTurnEnd(step)) turns.push([]);
  }
  if (turns.length > 1 && turns.at(-1)!.length === 0) turns.pop();
  return turns;
}

export interface FakeAdapterOptions {
  id?: AgentId;
  /** The turn a message delivered with `send()` plays. Default: `text "received: <msg>"`, then `done`. */
  messageTurn?: (message: string) => FakeStep[];
  /** `send()` refuses every message (returns false), as a session whose input has closed does. */
  refuseSends?: boolean;
  /** `interrupt()` never resolves and does nothing, like an SDK control request that hangs. */
  hangInterrupt?: boolean;
}

/**
 * A scripted agent for runner tests. The script is split into turns at each `done`/`error`
 * event. Every `start()` plays the first turn, so concurrent tasks behave alike; `resume()`
 * plays the session's next turn (the first one for a session this fake never saw), and an
 * immediate `done` once the script is used up.
 *
 * Each run is an agent process, like the real one:
 * - It runs on its own. While the runner reads `events` it waits for each event to be read
 *   before going on, which keeps tests deterministic. Once the runner stops reading, it goes on
 *   anyway, as a real agent process does.
 * - Every message accepted by `send()` is its own turn (see `messageTurn`), played after the
 *   current turn ends. Messages accepted before `end()` still play after it, since the real
 *   agent has already read them (adapter-claude-code's message queue). Only an abort stops them.
 *
 * - `edit` writes into `ctx.cwd`; `permission` awaits `ctx.requestPermission` and then emits a
 *   `tool_result` with the decision; `waitForMessage` holds the turn until a message has
 *   arrived (the message still plays as its own turn afterwards).
 * - `interrupt()` ends the current turn with `done` ("interrupted"), like the real adapter; an
 *   aborted `ctx.signal` ends the run with `error`; `end()` stops the turn in progress (if any)
 *   and ends the run once the queued messages have played.
 */
export function fakeAdapter(script: FakeStep[], opts: FakeAdapterOptions = {}): FakeAdapter {
  const turns = toTurns(script);
  // sessionId -> index of the turn the next resume plays.
  const nextTurn = new Map<string, number>();
  const calls: FakeAdapter["calls"] = { start: [], resume: [], send: [] };
  const processes: Promise<void>[] = [];
  const messageTurn =
    opts.messageTurn ??
    ((message: string): FakeStep[] => [
      { event: { type: "text", text: `received: ${message}` } },
      { event: { type: "done" } },
    ]);

  function play(turnIndex: number, ctx: RunContext): AgentRun {
    const firstTurn = turns[turnIndex] ?? [{ event: { type: "done" } }];
    // Messages accepted by send() whose turn hasn't started yet.
    const inbox: string[] = [];
    // Events emitted but not read yet, and how far the reader has asked.
    const out: AgentEvent[] = [];
    let emitted = 0;
    let requested = 0;
    let detached = false;
    let finished = false;
    // Per turn: an interrupt (or end()) stops only the turn it lands in.
    let stop = new AbortController();
    let inTurn = false;
    let interrupted = false;
    let cut = false;
    let ended = false;

    // Every wait re-checks its condition whenever any of the state above changes.
    const waiters = new Set<() => void>();
    const changed = () => {
      for (const check of [...waiters]) check();
    };
    const until = (ready: () => boolean) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (!ready()) return;
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
        check();
      });
    ctx.signal.addEventListener("abort", changed);
    const settled = () => cut || interrupted || ctx.signal.aborted;

    /** Hands an event to the reader and waits until it asks for the next one (or stopped reading). */
    async function emit(event: AgentEvent): Promise<void> {
      out.push(event);
      const index = emitted++;
      changed();
      await until(() => requested > index + 1 || detached || ctx.signal.aborted);
    }

    /** Plays one turn. Returns true when it ended with `done` and the session goes on. */
    async function runTurn(steps: FakeStep[]): Promise<boolean> {
      stop = new AbortController();
      interrupted = false;
      cut = false;
      inTurn = true;
      try {
        for (const step of steps) {
          if (settled()) break;
          if ("event" in step) {
            if (step.event.type === "session") nextTurn.set(step.event.sessionId, turnIndex + 1);
            if (isTurnEnd(step)) {
              inTurn = false;
              await emit(step.event);
              return step.event.type === "done";
            }
            await emit(step.event);
          } else if ("edit" in step) {
            const file = join(ctx.cwd, step.edit.file);
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, step.edit.content);
          } else if ("permission" in step) {
            const signal = AbortSignal.any([ctx.signal, stop.signal]);
            const decision = await ctx.requestPermission(step.permission, signal);
            if (!settled())
              await emit({ type: "tool_result", toolUseId: step.permission.toolUseId, ok: decision.allow });
          } else {
            await until(() => inbox.length > 0 || settled() || ended);
          }
        }
        // Reached when the turn was cut short, or the script ran out without ending the turn.
        inTurn = false;
        if (ctx.signal.aborted) {
          await emit({ type: "error", message: "aborted" });
          return false;
        }
        if (interrupted) {
          await emit({ type: "done", summary: "interrupted" });
          return true;
        }
        return false;
      } finally {
        inTurn = false;
      }
    }

    const agent = (async () => {
      try {
        if (!(await runTurn(firstTurn))) return;
        for (;;) {
          await until(() => inbox.length > 0 || ended || ctx.signal.aborted);
          if (ctx.signal.aborted) {
            await emit({ type: "error", message: "aborted" });
            return;
          }
          const message = inbox.shift();
          if (message === undefined) return;
          if (!(await runTurn(messageTurn(message)))) return;
        }
      } finally {
        finished = true;
        ctx.signal.removeEventListener("abort", changed);
        changed();
      }
    })();
    processes.push(agent);

    async function* events(): AsyncGenerator<AgentEvent> {
      try {
        for (;;) {
          requested++;
          changed();
          await until(() => out.length > 0 || finished);
          const event = out.shift();
          if (event === undefined) return;
          yield event;
        }
      } finally {
        detached = true;
        changed();
      }
    }

    return {
      events: events(),
      send(message) {
        if (ended || opts.refuseSends) return false;
        calls.send.push(message);
        inbox.push(message);
        changed();
        return true;
      },
      async interrupt() {
        if (opts.hangInterrupt) return new Promise<void>(() => undefined);
        interrupted = true;
        stop.abort();
        changed();
      },
      end() {
        ended = true;
        if (inTurn) {
          cut = true;
          stop.abort();
        }
        changed();
      },
    };
  }

  return {
    id: opts.id ?? "claude-code",
    capabilities: { resume: true, permissionCallback: true, costReporting: true, liveMessages: true },
    calls,
    settled: async () => {
      await Promise.all(processes);
    },
    start(task, ctx) {
      calls.start.push(task);
      return play(0, ctx);
    },
    resume(sessionId, message, ctx, options) {
      calls.resume.push(options ? { sessionId, message, options } : { sessionId, message });
      const turn = nextTurn.get(sessionId) ?? 0;
      nextTurn.set(sessionId, turn + 1);
      return play(turn, ctx);
    },
  };
}
