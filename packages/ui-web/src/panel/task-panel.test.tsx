import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "@coord/app-state";
import { createClient, DaemonError, type TransportRequest } from "@coord/client";
import { fakeTransport } from "@coord/client/testing";
import { TaskPanel } from "./task-panel";

// No vitest globals, so testing-library does not unmount between tests by itself.
afterEach(cleanup);

const task = (over: Record<string, unknown> = {}) => ({
  id: "t",
  repoPath: "/repo",
  title: "Fix login redirect",
  prompt: "p",
  agent: "codex",
  status: "running",
  branch: "agent/fix-login-redirect",
  worktreePath: "/wt",
  sessionId: "s",
  turns: 3,
  costUsd: 0,
  createdAt: "2026-10-26T00:00:00.000Z",
  ...over,
});

const prompt = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  taskId: "t",
  toolUseId: `u-${id}`,
  tool: "Bash",
  input: { command: "pnpm add zod" },
  canRemember: true,
  createdAt: "x",
  ...over,
});

const agentEvent = (seq: number, event: Record<string, unknown>) => ({
  seq,
  at: "x",
  payload: { kind: "agent.event", taskId: "t", event },
});

function setup(
  options: {
    task?: Record<string, unknown>;
    events?: unknown[];
    permissions?: unknown[];
    post?: (req: TransportRequest) => unknown;
  } = {},
) {
  const state = { permissions: options.permissions ?? [] };
  const transport = fakeTransport((req) => {
    if (req.method === "POST") return options.post ? options.post(req) : task(options.task);
    if (req.path.startsWith("/permissions")) return state.permissions;
    if (req.path.startsWith("/tasks/t/events")) return options.events ?? [];
    if (req.path === "/tasks/t") return task(options.task);
    return [];
  });
  const onClose = vi.fn();
  render(
    <ClientProvider client={createClient(transport)}>
      <TaskPanel taskId="t" surface="desktop" onClose={onClose} />
    </ClientProvider>,
  );
  const posts = () => transport.requests.filter((r) => r.method === "POST");
  return { transport, state, onClose, posts };
}

describe("TaskPanel", () => {
  it("shows the live stream and the header", async () => {
    const { transport } = setup({
      events: [
        agentEvent(1, { type: "text", text: "Looking at the redirect" }),
        agentEvent(2, {
          type: "tool_call",
          toolUseId: "u1",
          name: "Bash",
          input: { command: "pnpm test auth" },
        }),
      ],
    });
    expect(await screen.findByRole("heading", { name: "Fix login redirect" })).toBeTruthy();
    expect(
      screen.getByText("Codex · default model · branch agent/fix-login-redirect · 3 commits"),
    ).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    expect(await screen.findByText("Looking at the redirect")).toBeTruthy();
    expect(screen.getByText("▸ Bash pnpm test auth")).toBeTruthy();
    for (const name of ["Live", "Diff", "Checks"]) expect(screen.getByRole("tab", { name })).toBeTruthy();

    transport.emit(agentEvent(3, { type: "done", summary: "Fixed" }) as never);
    expect(await screen.findByText("Turn finished — Fixed")).toBeTruthy();
  });

  it("answering Allow sends the decision", async () => {
    const { posts } = setup({ permissions: [prompt("p1")] });
    expect(await screen.findByText("Codex wants to run: pnpm add zod")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(posts()).toEqual([{ method: "POST", path: "/permissions/p1", body: { allow: true } }]),
    );
  });

  it("after a successful answer the buttons are gone before any refresh", async () => {
    setup({ permissions: [prompt("p1")], post: () => undefined });
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByText("Answered")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    expect(screen.queryByText("Already answered")).toBeNull();
  });

  it("Deny opens an optional reason field and sends the reason", async () => {
    const { posts } = setup({ permissions: [prompt("p1")] });
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    expect(posts()).toEqual([]);
    fireEvent.change(screen.getByRole("textbox", { name: "Reason (optional)" }), {
      target: { value: "use pnpm add -D" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(posts()).toEqual([
        { method: "POST", path: "/permissions/p1", body: { allow: false, reason: "use pnpm add -D" } },
      ]),
    );
  });

  it("Always allow appears only when canRemember", async () => {
    const { posts } = setup({
      task: { status: "needs_input" },
      permissions: [
        prompt("p1"),
        prompt("p2", {
          tool: "Edit",
          input: { file_path: "src/auth/redirect.ts" },
          canRemember: false,
          title: "Edit redirect.ts?",
        }),
      ],
    });
    expect(await screen.findByText("Codex wants to use Edit: src/auth/redirect.ts")).toBeTruthy();
    expect(screen.getByText("Edit redirect.ts?")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Allow" })).toHaveLength(2);
    const always = screen.getAllByRole("button", { name: "Always allow this session" });
    expect(always).toHaveLength(1);
    fireEvent.click(always[0]!);
    await waitFor(() =>
      expect(posts()).toEqual([
        { method: "POST", path: "/permissions/p1", body: { allow: true, remember: true } },
      ]),
    );
  });

  it("a prompt answered elsewhere disappears, and a stale click shows Already answered", async () => {
    const { transport, state } = setup({
      task: { status: "needs_input" },
      permissions: [prompt("p1"), prompt("p2", { input: { command: "rm -rf dist" } })],
      post: () => {
        throw new DaemonError(409, "conflict", "permission request p2 was already answered");
      },
    });
    await screen.findByText("Codex wants to run: pnpm add zod");

    // Answered in the CLI: the daemon resolves it and the list no longer has it.
    state.permissions = [prompt("p2", { input: { command: "rm -rf dist" } })];
    transport.emit({
      seq: 10,
      at: "x",
      payload: { kind: "permission.resolved", requestId: "p1", taskId: "t", outcome: "allowed" },
    });
    await waitFor(() => expect(screen.queryByText("Codex wants to run: pnpm add zod")).toBeNull());

    // p2 was answered too, but this window has not refreshed yet.
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await screen.findByText("Already answered")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();

    state.permissions = [];
    transport.emit({
      seq: 11,
      at: "x",
      payload: { kind: "permission.resolved", requestId: "p2", taskId: "t", outcome: "allowed" },
    });
    await waitFor(() => expect(screen.queryByText("Codex wants to run: rm -rf dist")).toBeNull());
    expect(screen.queryByText("Already answered")).toBeNull();
  });

  it("any other failed answer shows the daemon's message inline", async () => {
    setup({
      permissions: [prompt("p1")],
      post: () => {
        throw new DaemonError(500, "internal", "database is locked");
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect((await screen.findByRole("alert")).textContent).toBe("database is locked");
    expect(screen.queryByText("Already answered")).toBeNull();
  });

  it("send while running shows the turn-end hint and posts the message", async () => {
    const { posts } = setup();
    expect(await screen.findByText("Delivered when the current turn ends")).toBeTruthy();
    const box = screen.getByRole("textbox", { name: "Message the agent" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "also cover the logout path" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(posts()).toEqual([
        { method: "POST", path: "/tasks/t/messages", body: { text: "also cover the logout path" } },
      ]),
    );
    await waitFor(() => expect(box.value).toBe(""));
    // A plain Enter is a newline, not a send.
    fireEvent.change(box, { target: { value: "more" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(posts()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
  });

  it("the message box has no hint at rest and is disabled once the task is cancelled", async () => {
    setup({ task: { status: "review" } });
    await screen.findByText("review");
    expect(screen.queryByText("Delivered when the current turn ends")).toBeNull();
    cleanup();
    setup({ task: { status: "cancelled" } });
    await screen.findByText("cancelled");
    expect((screen.getByRole("textbox", { name: "Message the agent" }) as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Interrupt is offered while running and calls interrupt", async () => {
    const { posts } = setup({
      post: () => {
        throw new DaemonError(409, "conflict", "task is review; there is no turn to interrupt");
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Interrupt" }));
    await waitFor(() => expect(posts()).toEqual([{ method: "POST", path: "/tasks/t/interrupt" }]));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "task is review; there is no turn to interrupt",
    );
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("Resume is offered for an interrupted task and calls resume", async () => {
    const { posts } = setup({ task: { status: "interrupted" } });
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(posts()).toEqual([{ method: "POST", path: "/tasks/t/resume" }]));
    expect(screen.queryByRole("button", { name: "Interrupt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("cancel asks for confirmation first", async () => {
    const { posts } = setup({ task: { status: "queued" } });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Cancel this task? Work so far is committed to its branch.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByText("Cancel this task? Work so far is committed to its branch.")).toBeNull();
    expect(posts()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel task" }));
    await waitFor(() => expect(posts()).toEqual([{ method: "POST", path: "/tasks/t/cancel" }]));
  });

  it("the stream follows new rows unless the user has scrolled up", async () => {
    const { transport } = setup({ events: [agentEvent(1, { type: "text", text: "one" })] });
    await screen.findByText("one");
    // jsdom has no layout: give the stream a height and content taller than it.
    const log = screen.getByRole("log");
    Object.defineProperty(log, "clientHeight", { value: 100 });
    Object.defineProperty(log, "scrollHeight", { value: 1000 });

    transport.emit(agentEvent(2, { type: "text", text: "two" }) as never);
    await screen.findByText("two");
    expect(log.scrollTop).toBe(1000);

    log.scrollTop = 200;
    fireEvent.scroll(log);
    transport.emit(agentEvent(3, { type: "text", text: "three" }) as never);
    await screen.findByText("three");
    expect(log.scrollTop).toBe(200);
  });

  it("multi-line agent text keeps its line breaks", async () => {
    setup({ events: [agentEvent(1, { type: "text", text: "line one\nline two" })] });
    const row = await screen.findByText(
      (_, el) => el?.children.length === 0 && el.textContent === "line one\nline two",
    );
    expect(row.style.whiteSpace).toBe("pre-wrap");
  });

  it("Esc keeps the panel open while a text field holds text or an IME is composing", async () => {
    const { onClose } = setup();
    const box = await screen.findByRole("textbox", { name: "Message the agent" });
    fireEvent.change(box, { target: { value: "half-written follow-up" } });
    fireEvent.keyDown(box, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc closes the panel", async () => {
    const { onClose } = setup();
    await screen.findByRole("heading", { name: "Fix login redirect" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
