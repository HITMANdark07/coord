import { describe, expect, it } from "vitest";
import type { AgentEvent, DaemonEvent, Task } from "@coord/protocol";
import { liveRows } from "./live-rows";

let seq = 0;
const agent = (event: AgentEvent): DaemonEvent => ({
  seq: ++seq,
  at: "x",
  payload: { kind: "agent.event", taskId: "t", event },
});
const updated = (status: Task["status"]): DaemonEvent => ({
  seq: ++seq,
  at: "x",
  payload: { kind: "task.updated", task: { status } as Task },
});
const view = (events: DaemonEvent[]) =>
  liveRows(events).map(({ depth, kind, text, ok }) => ({ depth, kind, text, ok }));

describe("liveRows", () => {
  it("text becomes its text, made display-safe", () => {
    expect(view([agent({ type: "text", text: "Reading‮ the code" })])).toEqual([
      { depth: 0, kind: "text", text: "Reading the code", ok: undefined },
    ]);
  });

  it("a tool call shows its name and input summary", () => {
    expect(
      view([
        agent({ type: "tool_call", toolUseId: "u1", name: "Bash", input: { command: "pnpm test auth" } }),
      ]),
    ).toEqual([{ depth: 0, kind: "tool", text: "▸ Bash pnpm test auth", ok: undefined }]);
  });

  it("a failed result sits right under its call; a successful one adds no row", () => {
    const rows = view([
      agent({ type: "tool_call", toolUseId: "u1", name: "Read", input: { file_path: "a.ts" } }),
      agent({ type: "tool_call", toolUseId: "u2", name: "Bash", input: { command: "ls" } }),
      agent({ type: "tool_result", toolUseId: "u2", ok: true }),
      agent({ type: "tool_result", toolUseId: "u1", ok: false }),
    ]);
    expect(rows.map((r) => r.text)).toEqual(['▸ Read {"file_path":"a.ts"}', "✗ failed", "▸ Bash ls"]);
    expect(rows[1]).toEqual({ depth: 0, kind: "result", text: "✗ failed", ok: false });
  });

  it("done becomes Turn finished plus the summary", () => {
    expect(view([agent({ type: "done", summary: "Fixed it" }), agent({ type: "done" })])).toEqual([
      { depth: 0, kind: "turn", text: "Turn finished — Fixed it", ok: undefined },
      { depth: 0, kind: "turn", text: "Turn finished", ok: undefined },
    ]);
  });

  it("error becomes its message", () => {
    expect(view([agent({ type: "error", message: "agent crashed" })])).toEqual([
      { depth: 0, kind: "error", text: "agent crashed", ok: undefined },
    ]);
  });

  it("task.updated becomes a status row only when the status changed", () => {
    const rows = view([updated("queued"), updated("running"), updated("running"), updated("review")]);
    expect(rows.map((r) => [r.kind, r.text])).toEqual([
      ["status", "Status: queued"],
      ["status", "Status: running"],
      ["status", "Status: review"],
    ]);
  });

  it("usage, session and permission events are skipped", () => {
    expect(
      liveRows([
        agent({ type: "usage", inputTokens: 1, outputTokens: 2 }),
        agent({ type: "session", sessionId: "s" }),
        agent({
          type: "permission_request",
          requestId: "p",
          toolUseId: "u",
          tool: "Bash",
          input: {},
          canRemember: true,
        }),
        {
          seq: ++seq,
          at: "x",
          payload: { kind: "permission.resolved", requestId: "p", taskId: "t", outcome: "allowed" },
        },
      ]),
    ).toEqual([]);
  });

  it("sub-agent events nest one level under the call that started them, results included", () => {
    const rows = view([
      agent({ type: "tool_call", toolUseId: "task1", name: "Task", input: { description: "explore" } }),
      agent({ type: "text", text: "looking around", parentToolUseId: "task1" }),
      agent({
        type: "tool_call",
        toolUseId: "g1",
        name: "Grep",
        input: { pattern: "x" },
        parentToolUseId: "task1",
      }),
      agent({ type: "tool_result", toolUseId: "g1", ok: false }),
    ]);
    expect(rows.map((r) => [r.depth, r.kind])).toEqual([
      [0, "tool"],
      [1, "text"],
      [1, "tool"],
      [1, "result"],
    ]);
  });

  it("row keys are unique", () => {
    const rows = liveRows([
      agent({ type: "tool_call", toolUseId: "u1", name: "Bash", input: { command: "x" } }),
      agent({ type: "tool_result", toolUseId: "u1", ok: false }),
      agent({ type: "text", text: "a" }),
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});
