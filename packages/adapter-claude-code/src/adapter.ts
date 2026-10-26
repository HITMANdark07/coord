import {
  query,
  type CanUseTool,
  type Options,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentAdapter,
  AgentEvent,
  AgentRun,
  PermissionMode,
  RunContext,
  RunOptions,
} from "@coord/protocol";
import { toAgentEvents } from "./events";
import { createMessageQueue } from "./message-queue";

/**
 * Always load the repo's own Claude Code setup (CLAUDE.md, settings, hooks, MCP servers, skills)
 * in every worktree — PRD FR-2, the top priority. Set explicitly so an SDK default change can't drop it.
 */
export const CLAUDE_SETTING_SOURCES: SettingSource[] = ["user", "project", "local"];

type QueryFn = typeof query;

/** Maps a permission prompt to the daemon and its answer back to the SDK (PRD FR-4, FR-34). */
export function permissionBridge(ctx: RunContext): CanUseTool {
  return async (toolName, input, options) => {
    const decision = await ctx.requestPermission(
      {
        toolUseId: options.toolUseID,
        tool: toolName,
        input,
        title: options.title,
        canRemember: !options.suppressAlwaysAllowRule && (options.suggestions?.length ?? 0) > 0,
      },
      options.signal,
    );
    if (!decision.allow) return { behavior: "deny", message: decision.reason ?? "Denied by the user" };
    return {
      behavior: "allow",
      updatedInput: decision.updatedInput ?? input,
      ...(decision.remember && !options.suppressAlwaysAllowRule
        ? // "Always allow" lasts for this session only; never write to the repo's or user's settings.
          { updatedPermissions: options.suggestions?.map((u) => ({ ...u, destination: "session" as const })) }
        : {}),
    };
  };
}

/**
 * SDK options for a run. Caller-supplied `extra` (model, resume) goes first so it can never
 * override the guarantees after it: the worktree cwd, the repo's Claude Code setup, permissions.
 */
const SDK_PERMISSION_MODE: Record<PermissionMode, NonNullable<Options["permissionMode"]>> = {
  ask: "default",
  accept_edits: "acceptEdits",
  bypass: "bypassPermissions",
};

export function buildOptions(
  extra: RunOptions & { resume?: string },
  ctx: RunContext,
  abortController: AbortController,
): Options {
  const { permissionMode, env, ...rest } = extra;
  return {
    ...rest,
    ...(permissionMode ? { permissionMode: SDK_PERMISSION_MODE[permissionMode] } : {}),
    env: { ...process.env, ...env },
    cwd: ctx.cwd,
    settingSources: CLAUDE_SETTING_SOURCES,
    canUseTool: permissionBridge(ctx),
    abortController,
  };
}

const userMessage = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});

export function createClaudeCodeAdapter(deps: { query?: QueryFn } = {}): AgentAdapter {
  const runQuery = deps.query ?? query;

  function run(firstMessage: string, ctx: RunContext, extra: RunOptions & { resume?: string }): AgentRun {
    const state = { interrupted: false };
    const input = createMessageQueue<SDKUserMessage>();
    input.push(userMessage(firstMessage));
    const abortController = new AbortController();
    let session: ReturnType<QueryFn> | undefined;

    async function* events(): AsyncGenerator<AgentEvent> {
      // The caller may have aborted before reading the first event.
      if (ctx.signal.aborted) {
        yield { type: "error", message: "run aborted before it started" };
        return;
      }
      const abort = () => abortController.abort();
      ctx.signal.addEventListener("abort", abort, { once: true });
      try {
        session = runQuery({ prompt: input.iterable, options: buildOptions(extra, ctx, abortController) });
        for await (const msg of session) yield* toAgentEvents(msg, state);
      } catch (err) {
        // An abort or a crashed Claude Code process ends the run with an event, not an exception.
        const reason = ctx.signal.aborted ? "run aborted" : err instanceof Error ? err.message : String(err);
        yield { type: "error", message: reason };
      } finally {
        ctx.signal.removeEventListener("abort", abort);
        input.end();
      }
    }

    return {
      events: events(),
      send: (message) => input.push(userMessage(message)),
      interrupt: async () => {
        state.interrupted = true;
        await session?.interrupt();
      },
      end: () => input.end(),
    };
  }

  return {
    id: "claude-code",
    capabilities: { resume: true, permissionCallback: true, costReporting: true, liveMessages: true },
    start: (task, ctx) =>
      run(task.prompt, ctx, { model: task.model, permissionMode: task.permissionMode, env: task.env }),
    resume: (sessionId, message, ctx, options) => run(message, ctx, { ...options, resume: sessionId }),
  };
}
