import { describe, expect, it } from "vitest";
import { AgentEvent, CreateTaskInput, DaemonEvent, isCompatibleProtocol, TaskStatus } from "./index";

describe("protocol", () => {
  it("defaults new tasks to the Claude Code agent", () => {
    expect(CreateTaskInput.parse({ repoPath: "/repo", prompt: "x" }).agent).toBe("claude-code");
  });

  it("rejects an empty prompt and relative repo paths", () => {
    expect(() => CreateTaskInput.parse({ repoPath: "/repo", prompt: "" })).toThrow();
    expect(() => CreateTaskInput.parse({ repoPath: "repo", prompt: "x" })).toThrow(/absolute/);
    expect(CreateTaskInput.parse({ repoPath: "C:\\code\\repo", prompt: "x" }).repoPath).toBe(
      "C:\\code\\repo",
    );
  });

  it("covers the PRD task lifecycle", () => {
    expect(TaskStatus.options).toContain("needs_input");
  });

  it("discriminates agent events by type", () => {
    expect(AgentEvent.parse({ type: "session", sessionId: "s1" })).toEqual({
      type: "session",
      sessionId: "s1",
    });
    expect(() => AgentEvent.parse({ type: "session" })).toThrow();
  });

  it("wraps pushed events in a sequenced envelope", () => {
    const event = {
      seq: 3,
      at: "2026-10-26T00:00:00.000Z",
      payload: { kind: "agent.event", taskId: "t1", event: { type: "done" } },
    };
    expect(DaemonEvent.parse(event)).toEqual(event);
    expect(() => DaemonEvent.parse({ ...event, seq: -1 })).toThrow();
  });

  it.each([
    ["0.1.0", "0.1.0", true],
    ["0.1.5", "0.1.0", true],
    ["0.0.9", "0.1.0", true], // previous minor: phones lag behind
    ["0.2.0", "0.1.0", false], // newer than the daemon
    ["0.0.1", "0.2.0", false], // two minors behind
    ["1.1.0", "0.1.0", false],
    ["garbage", "0.1.0", false],
  ])("client %s against daemon %s compatible: %s", (client, daemon, ok) => {
    expect(isCompatibleProtocol(client, daemon)).toBe(ok);
  });
});
