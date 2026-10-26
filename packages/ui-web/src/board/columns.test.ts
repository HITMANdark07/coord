import { describe, expect, it } from "vitest";
import type { Task } from "@coord/protocol";
import { boardSummary, columnFor, groupTasks } from "./columns";

const now = new Date("2026-10-26T12:00:00.000Z");
const day = 86_400_000;
const task = (status: string, over: Partial<Task> = {}): Task => ({
  id: status + Math.random(),
  repoId: "r",
  repoPath: "/repo",
  title: status,
  prompt: "p",
  agent: "claude-code",
  status: status as Task["status"],
  branch: null,
  baseBranch: null,
  worktreePath: null,
  sessionId: null,
  model: null,
  permissionMode: "ask",
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
  error: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: now.toISOString(),
  ...over,
});
const ago = (days: number) => new Date(now.getTime() - days * day).toISOString();

describe("columnFor", () => {
  it.each([
    ["queued", "queued"],
    ["setting_up", "running"],
    ["running", "running"],
    ["checking", "running"],
    ["needs_input", "needs_you"],
    ["failed", "needs_you"],
    ["interrupted", "needs_you"],
    ["review", "review"],
    ["pr_open", "pr_open"],
    ["closed", "closed"],
    ["cancelled", "closed"],
    ["cleaned_up", "closed"],
  ])("%s goes to %s", (status, column) => {
    expect(columnFor(task(status), now)).toBe(column);
  });

  it("unknown status goes to needs you", () => {
    expect(columnFor(task("unknown"), now)).toBe("needs_you");
  });

  it("merged stays on the board for 7 days, then closes", () => {
    expect(columnFor(task("merged", { updatedAt: ago(6) }), now)).toBe("merged");
    expect(columnFor(task("merged", { updatedAt: ago(8) }), now)).toBe("closed");
  });
});

describe("groupTasks", () => {
  it("sorts newest first and hides closed unless asked", () => {
    const old = task("running", { updatedAt: ago(2) });
    const fresh = task("running", { updatedAt: ago(1) });
    const cancelled = task("cancelled");
    const hidden = groupTasks([old, fresh, cancelled], { now, showClosed: false });
    expect(hidden.running).toEqual([fresh, old]);
    expect(hidden.closed).toEqual([]);
    expect(groupTasks([cancelled], { now, showClosed: true }).closed).toEqual([cancelled]);
  });
});

describe("boardSummary", () => {
  it("counts running, needs you and in review, omitting zeros", () => {
    const tasks = [task("running"), task("setting_up"), task("failed"), task("review"), task("queued")];
    expect(boardSummary(tasks)).toBe("2 running · 1 needs you · 1 in review");
    expect(boardSummary([task("failed")])).toBe("1 needs you");
  });

  it("says so when there are no tasks", () => {
    expect(boardSummary([])).toBe("No tasks yet");
  });
});
