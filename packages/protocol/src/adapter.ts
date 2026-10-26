import type { AgentEvent, PermissionDecision } from "./events";
import type { AgentId } from "./task";

export interface TaskSpec {
  taskId: string;
  prompt: string;
  model?: string;
}

/** What an agent asks permission for; shown on desktop and phone (PRD FR-4, FR-34). */
export interface PermissionRequest {
  /** Pairs the prompt with the agent's `tool_call` event. */
  toolUseId: string;
  tool: string;
  input: Record<string, unknown>;
  /** Ready-made prompt text from the agent, when it provides one. */
  title?: string;
  /** False when the agent says this request must not be approved permanently. */
  canRemember: boolean;
}

export interface RunContext {
  cwd: string;
  signal: AbortSignal;
  /**
   * Resolved by the daemon once a user answers on desktop or phone. `signal` aborts when the
   * agent no longer needs the answer, so the daemon can withdraw the prompt from every client.
   */
  requestPermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>;
}

/**
 * A running agent session. The daemon drives it; users steer it from any client (PRD FR-17).
 * The session stays open between turns: a `done` event means the current turn finished, not
 * the session. Call `end()` when the task is over, or the agent process keeps running.
 * `events` never throws: failures and aborts arrive as an `error` event.
 */
export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  /** Send a follow-up message into the session. Returns false if the session has ended. */
  send(message: string): boolean;
  /** Stop the current turn; the session stays open for more messages. */
  interrupt(): Promise<void>;
  /** No more messages: the session finishes after the current turn. */
  end(): void;
}

/**
 * Every coding agent sits behind this interface. Claude Code sets the bar;
 * weaker agents declare missing features through `capabilities`.
 * Only the daemon's composition root (packages/core/src/main.ts) registers adapters.
 */
export interface AgentAdapter {
  id: AgentId;
  capabilities: {
    resume: boolean;
    permissionCallback: boolean;
    costReporting: boolean;
    /** send() and interrupt() work while a turn is running. */
    liveMessages: boolean;
  };
  start(task: TaskSpec, ctx: RunContext): AgentRun;
  resume(sessionId: string, message: string, ctx: RunContext): AgentRun;
}
