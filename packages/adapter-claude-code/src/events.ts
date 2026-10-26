import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@coord/protocol";

/** Maps one Claude Agent SDK message to zero or more agent-neutral events. Unknown messages are ignored. */
export function toAgentEvents(
  msg: SDKMessage,
  state: { interrupted: boolean } = { interrupted: false },
): AgentEvent[] {
  switch (msg.type) {
    case "system":
      return msg.subtype === "init" ? [{ type: "session", sessionId: msg.session_id }] : [];

    case "assistant": {
      // Subagent (Task tool) output carries the parent tool use, so UIs can nest it.
      const nest = msg.parent_tool_use_id ? { parentToolUseId: msg.parent_tool_use_id } : {};
      return msg.message.content.flatMap((block): AgentEvent[] => {
        if (block.type === "text") return [{ type: "text", text: block.text, ...nest }];
        if (block.type === "tool_use")
          return [{ type: "tool_call", toolUseId: block.id, name: block.name, input: block.input, ...nest }];
        return [];
      });
    }

    case "user": {
      const content = msg.message.content;
      if (typeof content === "string") return [];
      return content.flatMap((block): AgentEvent[] =>
        block.type === "tool_result"
          ? [{ type: "tool_result", toolUseId: block.tool_use_id, ok: !block.is_error }]
          : [],
      );
    }

    case "result": {
      const usage = resultUsage(msg);
      // A turn can end with subtype "success" yet is_error (e.g. API or auth failure); that is a failure.
      if (msg.subtype === "success" && !msg.is_error) return [usage, { type: "done", summary: msg.result }];
      // A user interrupt surfaces as an error result; it ends the turn, it is not a failure.
      if (state.interrupted) return [usage, { type: "done", summary: "Interrupted by user" }];
      const detail = msg.subtype === "success" ? msg.result : msg.errors.join("; ") || msg.subtype;
      return [usage, { type: "error", message: `Claude Code stopped (${msg.subtype}): ${detail}` }];
    }

    default:
      return [];
  }
}

/** Per-model usage includes cache tokens that `usage` omits; fall back to `usage` when absent. */
function resultUsage(msg: Extract<SDKMessage, { type: "result" }>): AgentEvent {
  const models = Object.values(msg.modelUsage ?? {});
  if (models.length === 0)
    return {
      type: "usage",
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      costUsd: msg.total_cost_usd,
    };
  return {
    type: "usage",
    inputTokens: models.reduce(
      (n, m) => n + m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens,
      0,
    ),
    outputTokens: models.reduce((n, m) => n + m.outputTokens, 0),
    costUsd: models.reduce((n, m) => n + m.costUSD, 0),
  };
}
