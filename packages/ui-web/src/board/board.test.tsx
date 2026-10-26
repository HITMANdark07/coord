import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "@coord/app-state";
import { createClient } from "@coord/client";
import { fakeTransport } from "@coord/client/testing";
import { Board } from "./board";

// No vitest globals, so testing-library does not unmount between tests by itself.
afterEach(cleanup);

const mk = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  repoId: "r",
  repoPath: "/repo",
  title: `Task ${id}`,
  prompt: "p",
  agent: "claude-code",
  status,
  branch: null,
  worktreePath: null,
  sessionId: null,
  costUsd: 0.214,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
  ...over,
});

function setup(tasks: unknown[], permissions: unknown[] = [], onOpen = vi.fn(), agentsLoaded = true) {
  const transport = fakeTransport((req) => {
    if (req.path.startsWith("/permissions")) return permissions;
    if (req.path === "/agents")
      return !agentsLoaded
        ? new Promise(() => {})
        : [
            { id: "claude-code", available: true, costReporting: true, liveMessages: true },
            { id: "codex", available: true, costReporting: false, liveMessages: false },
          ];
    return req.path.includes("all=1")
      ? tasks
      : (tasks as { status: string }[]).filter((t) => t.status !== "cancelled");
  });
  render(
    <ClientProvider client={createClient(transport)}>
      <Board repoId="r" onOpen={onOpen} onNewTask={() => {}} />
    </ClientProvider>,
  );
  return onOpen;
}

describe("Board", () => {
  it("shows the six columns and the summary 1 running · 1 needs you", async () => {
    setup([mk("a", "running"), mk("b", "failed", { error: "boom" })]);
    expect(await screen.findByText("1 running · 1 needs you")).toBeTruthy();
    for (const name of ["Queued", "Running", "Needs you", "Review", "PR open", "Merged"])
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ New task" })).toBeTruthy();
  });

  it("needs-you card shows the pending prompt summary", async () => {
    setup(
      [mk("a", "needs_input", { agent: "codex" })],
      [
        {
          id: "p1",
          taskId: "a",
          toolUseId: "u",
          tool: "Bash",
          input: { command: "pnpm add zod" },
          canRemember: true,
          createdAt: "x",
        },
      ],
    );
    expect(await screen.findByText("pnpm add zod")).toBeTruthy();
    const card = screen.getByRole("button", { name: /Task a/ });
    expect(within(card).getByText("Codex")).toBeTruthy();
    expect(card.textContent).toContain("⚠");
  });

  it("shows the error of a failed task and a resume hint for an interrupted one", async () => {
    setup([mk("a", "failed", { error: "boom" }), mk("b", "interrupted")]);
    expect(await screen.findByText("boom")).toBeTruthy();
    expect(screen.getByText("interrupted — resume")).toBeTruthy();
  });

  it("uses tokens for agents that do not report cost", async () => {
    setup([mk("a", "running", { agent: "codex", inputTokens: 30_000, outputTokens: 11_000 })]);
    expect(await screen.findByText(/41k tok/)).toBeTruthy();
  });

  it("assumes Claude Code reports cost until the agent list loads", async () => {
    setup([mk("a", "running"), mk("b", "running", { agent: "codex" })], [], vi.fn(), false);
    expect(await screen.findByText(/\$0\.21/)).toBeTruthy();
    expect(screen.getByText(/0 tok/)).toBeTruthy();
  });

  it("show closed reveals cancelled tasks", async () => {
    setup([mk("a", "running"), mk("c", "cancelled")]);
    await screen.findByText("Task a");
    expect(screen.queryByText("Task c")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "show closed" }));
    expect(await screen.findByText("Task c")).toBeTruthy();
  });

  it("a failed poll keeps the cards on the board", async () => {
    let fail = false;
    const transport = fakeTransport((req) => {
      if (req.path.startsWith("/tasks")) {
        if (fail) throw new Error("daemon down");
        return [mk("a", "running")];
      }
      return [];
    });
    render(
      <ClientProvider client={createClient(transport)}>
        <Board repoId="r" onOpen={() => {}} onNewTask={() => {}} />
      </ClientProvider>,
    );
    await screen.findByText("Task a");
    fail = true;
    act(() => transport.setStatus("open"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Task a")).toBeTruthy();
  });

  it("a card click opens the task", async () => {
    const onOpen = setup([mk("a", "running")]);
    fireEvent.click(await screen.findByRole("button", { name: /Task a/ }));
    expect(onOpen).toHaveBeenCalledWith("a");
  });
});
