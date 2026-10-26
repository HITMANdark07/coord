import { displayText, toolInputSummary, type DaemonEvent } from "@coord/protocol";

export type LiveRow = {
  key: string;
  depth: 0 | 1;
  kind: "text" | "tool" | "result" | "turn" | "error" | "status";
  text: string;
  ok?: boolean;
};

/** The Live tab's stream: one display-safe row per thing the agent did, from the task's events. */
export function liveRows(events: DaemonEvent[]): LiveRow[] {
  const rows: LiveRow[] = [];
  const calls = new Map<string, LiveRow>();
  let status: string | undefined;
  for (const { seq, payload: p } of events) {
    const key = String(seq);
    if (p.kind === "task.updated") {
      if (p.task.status !== status)
        rows.push({ key, depth: 0, kind: "status", text: `Status: ${p.task.status}` });
      status = p.task.status;
      continue;
    }
    if (p.kind !== "agent.event") continue;
    const e = p.event;
    // Sub-agent events nest under the tool call that started them (spec §10).
    const depth = "parentToolUseId" in e && e.parentToolUseId !== undefined ? 1 : 0;
    switch (e.type) {
      case "text":
        rows.push({ key, depth, kind: "text", text: displayText(e.text) });
        break;
      case "tool_call": {
        const row: LiveRow = {
          key,
          depth,
          kind: "tool",
          text: `▸ ${displayText(e.name)} ${toolInputSummary(e.name, e.input)}`,
        };
        calls.set(e.toolUseId, row);
        rows.push(row);
        break;
      }
      case "tool_result": {
        if (e.ok) break;
        const call = calls.get(e.toolUseId);
        const row: LiveRow = { key, depth: call?.depth ?? 0, kind: "result", text: "✗ failed", ok: false };
        // Parallel calls finish out of order, so the failure goes right under the call it belongs to.
        if (call) rows.splice(rows.indexOf(call) + 1, 0, row);
        else rows.push(row);
        break;
      }
      case "done":
        rows.push({
          key,
          depth: 0,
          kind: "turn",
          text: e.summary ? `Turn finished — ${displayText(e.summary)}` : "Turn finished",
        });
        break;
      case "error":
        rows.push({ key, depth: 0, kind: "error", text: displayText(e.message) });
        break;
      // usage and session are bookkeeping; permission prompts render from usePermissions.
    }
  }
  return rows;
}
