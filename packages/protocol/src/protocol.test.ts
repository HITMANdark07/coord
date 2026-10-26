import { describe, expect, it } from "vitest";
import {
  AgentEvent,
  branchSuggestion,
  CreateTaskInput,
  DaemonEvent,
  displayText,
  isCompatibleProtocol,
  ReadTaskStatus,
  RepoConfig,
  Task,
  TaskStatus,
  toolInputSummary,
} from "./index";

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

  it("rejects a baseBranch git would read as an option", () => {
    const input = { repoPath: "/repo", prompt: "x" };
    expect(() => CreateTaskInput.parse({ ...input, baseBranch: "--upload-pack=touch x" })).toThrow(/-/);
    expect(CreateTaskInput.parse({ ...input, baseBranch: "release/1.x" }).baseBranch).toBe("release/1.x");
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

  it("CreateTaskInput requires repoId or repoPath", () => {
    expect(() => CreateTaskInput.parse({ prompt: "x" })).toThrow();
    expect(CreateTaskInput.parse({ repoId: "r1", prompt: "x" })).toMatchObject({
      repoId: "r1",
      agent: "claude-code",
      permissionMode: "ask",
    });
  });

  it("rejects branch names outside agent/", () => {
    expect(() => CreateTaskInput.parse({ repoId: "r1", prompt: "x", branch: "main" })).toThrow();
    expect(CreateTaskInput.parse({ repoId: "r1", prompt: "x", branch: "agent/fix-login" }).branch).toBe(
      "agent/fix-login",
    );
  });

  it("RepoConfig fills defaults", () => {
    expect(RepoConfig.parse({})).toEqual({ envFiles: [], ports: { start: 41000, blockSize: 10 } });
  });

  it("Task from an older daemon still parses", () => {
    const task = Task.parse({
      id: "t1",
      repoPath: "/repo",
      title: "t",
      prompt: "p",
      agent: "claude-code",
      status: "running",
      branch: null,
      worktreePath: null,
      sessionId: null,
      costUsd: 0,
      createdAt: "2026-10-26T00:00:00.000Z",
    });
    expect(task.turns).toBe(0);
    expect(task.permissionMode).toBe("ask");
  });

  it("permission events round-trip", () => {
    const event = {
      seq: 4,
      at: "2026-10-26T00:00:00.000Z",
      payload: {
        kind: "permission.requested",
        request: {
          id: "p1",
          taskId: "t1",
          toolUseId: "tu1",
          tool: "Bash",
          input: { command: "ls" },
          canRemember: true,
          createdAt: "2026-10-26T00:00:00.000Z",
        },
      },
    };
    expect(DaemonEvent.parse(event)).toEqual(event);
  });

  it("old clients read pr_open", () => {
    expect(ReadTaskStatus.parse("pr_open")).toBe("pr_open");
  });
});

describe("display helpers", () => {
  it("branchSuggestion uses the first non-empty line", () => {
    expect(branchSuggestion("\n\nAdd CSV export to reports\nmore")).toBe("agent/add-csv-export-to-reports");
    expect(branchSuggestion("!!!")).toBe("agent/task");
  });

  it("displayText strips control and format characters but keeps newlines", () => {
    // ESC sequence, BEL, CR, a C1 CSI, a bidi override and a zero-width space.
    expect(displayText("a\u001b[2Kb\u0007\r\u009bc\u202ed\u200be\n\tf")).toBe("a[2Kbcde\n\tf");
  });

  it("toolInputSummary keeps the file name of a long path", () => {
    const path = `/Users/me/.coord/worktrees/repo/${"deep/".repeat(40)}the-file.ts`;
    const summary = toolInputSummary("Write", { file_path: path });
    expect(summary).toHaveLength(120);
    expect(summary).toMatch(/^\/Users\/me\/.+….+\/deep\/the-file\.ts$/);
    expect(toolInputSummary("Bash", { command: "ls\u001b[2K\nrm x" })).toBe("ls[2K⏎rm x");
    expect(toolInputSummary("mcp__x__y", { q: "a".repeat(300) }, 20)).toBe(`{"q":"${"a".repeat(13)}…`);
  });
});
