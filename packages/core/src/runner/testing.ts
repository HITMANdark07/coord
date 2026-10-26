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
 * Like the real adapter, every message accepted by `send()` is its own turn: once the current
 * turn's `done` is out, the fake plays one turn per queued message (see `messageTurn`), then
 * waits for more until `end()`.
 *
 * - `edit` writes into `ctx.cwd`; `permission` awaits `ctx.requestPermission` and then emits a
 *   `tool_result` with the decision; `waitForMessage` holds the turn until a message has
 *   arrived (the message still plays as its own turn afterwards).
 * - `interrupt()` ends the current turn with `done` ("interrupted"), like the real adapter; an
 *   aborted `ctx.signal` ends the run with `error`; `end()` ends the event stream once the agent
 *   is idle.
 */
export function fakeAdapter(script: FakeStep[], opts: FakeAdapterOptions = {}): FakeAdapter {
  const turns = toTurns(script);
  // sessionId -> index of the turn the next resume plays.
  const nextTurn = new Map<string, number>();
  const calls: FakeAdapter["calls"] = { start: [], resume: [], send: [] };
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
    // Per turn: an interrupt stops only the turn it lands in.
    let stop = new AbortController();
    let interrupted = false;
    let ended = false;
    let wake: (() => void) | undefined;
    const poke = () => {
      const w = wake;
      wake = undefined;
      w?.();
    };
    ctx.signal.addEventListener("abort", poke, { once: true });
    const settled = () => ended || interrupted || ctx.signal.aborted;
    const waitFor = (ready: () => boolean) =>
      new Promise<void>((resolve) => {
        if (ready()) return resolve();
        wake = resolve;
      });

    /** Plays one turn. Returns true when it ended with `done` and the session goes on. */
    async function* playTurn(steps: FakeStep[]): AsyncGenerator<AgentEvent, boolean> {
      stop = new AbortController();
      interrupted = false;
      for (const step of steps) {
        if (settled()) break;
        if ("event" in step) {
          if (step.event.type === "session") nextTurn.set(step.event.sessionId, turnIndex + 1);
          yield step.event;
          if (isTurnEnd(step)) return step.event.type === "done";
        } else if ("edit" in step) {
          const file = join(ctx.cwd, step.edit.file);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, step.edit.content);
        } else if ("permission" in step) {
          const signal = AbortSignal.any([ctx.signal, stop.signal]);
          const decision = await ctx.requestPermission(step.permission, signal);
          if (!settled())
            yield { type: "tool_result", toolUseId: step.permission.toolUseId, ok: decision.allow };
        } else {
          await waitFor(() => inbox.length > 0 || settled());
        }
      }
      // Reached when the turn was cut short, or the script ran out without ending the turn.
      if (ctx.signal.aborted) {
        yield { type: "error", message: "aborted" };
        return false;
      }
      if (interrupted) {
        yield { type: "done", summary: "interrupted" };
        return true;
      }
      return false;
    }

    async function* events(): AsyncGenerator<AgentEvent> {
      try {
        if (!(yield* playTurn(firstTurn))) return;
        for (;;) {
          await waitFor(() => inbox.length > 0 || ended || ctx.signal.aborted);
          const message = inbox.shift();
          if (message === undefined) {
            if (ctx.signal.aborted) yield { type: "error", message: "aborted" };
            return;
          }
          if (!(yield* playTurn(messageTurn(message)))) return;
        }
      } finally {
        ctx.signal.removeEventListener("abort", poke);
      }
    }

    return {
      events: events(),
      send(message) {
        if (ended || opts.refuseSends) return false;
        calls.send.push(message);
        inbox.push(message);
        poke();
        return true;
      },
      async interrupt() {
        if (opts.hangInterrupt) return new Promise<void>(() => undefined);
        interrupted = true;
        stop.abort();
        poke();
      },
      end() {
        ended = true;
        stop.abort();
        poke();
      },
    };
  }

  return {
    id: opts.id ?? "claude-code",
    capabilities: { resume: true, permissionCallback: true, costReporting: true, liveMessages: true },
    calls,
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
