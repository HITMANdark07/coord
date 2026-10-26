import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@coord/protocol";

/** Maps one Claude Agent SDK message to zero or more agent-neutral events. Unknown messages are ignored. */
export function toAgentEvents(msg: SDKMessage): AgentEvent[] {
  switch (msg.type) {
    case "system":
      return msg.subtype === "init" ? [{ type: "session", sessionId: msg.session_id }] : [];

    case "assistant":
      return msg.message.content.flatMap((block): AgentEvent[] => {
        if (block.type === "text") return [{ type: "text", text: block.text }];
        if (block.type === "tool_use")
          return [{ type: "tool_call", toolUseId: block.id, name: block.name, input: block.input }];
        return [];
      });

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
      const usage: AgentEvent = {
        type: "usage",
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        costUsd: msg.total_cost_usd,
      };
      // A turn can end with subtype "success" yet is_error (e.g. API or auth failure); that is a failure.
      if (msg.subtype === "success" && !msg.is_error) return [usage, { type: "done", summary: msg.result }];
      const detail = msg.subtype === "success" ? msg.result : msg.errors.join("; ") || msg.subtype;
      return [usage, { type: "error", message: `Claude Code stopped (${msg.subtype}): ${detail}` }];
    }

    default:
      return [];
  }
}
