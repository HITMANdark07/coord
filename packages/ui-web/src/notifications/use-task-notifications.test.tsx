import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "@coord/app-state";
import { createClient } from "@coord/client";
import { fakeTransport } from "@coord/client/testing";
import type { Notify } from "../app";
import { useTaskNotifications } from "./use-task-notifications";

// No vitest globals, so testing-library does not unmount between tests by itself.
afterEach(cleanup);

const task = (over: Record<string, unknown>) => ({
  id: "t1",
  repoPath: "/repo",
  title: "Fix login",
  prompt: "p",
  agent: "claude-code",
  status: "running",
  branch: "b",
  worktreePath: "/wt",
  sessionId: null,
  costUsd: 0,
  createdAt: "2026-10-26T00:00:00.000Z",
  ...over,
});
const update = (seq: number, over: Record<string, unknown>) => ({
  seq,
  at: "x",
  payload: { kind: "task.updated", task: task(over) },
});

/** `listed` answers GET /tasks?all=1: the tasks that existed before the app opened. */
function setup(listed: () => unknown = () => []) {
  const transport = fakeTransport((req) => (req.path.startsWith("/tasks") ? listed() : []));
  const client = createClient(transport);
  const list = vi.spyOn(client, "listTasks");
  const notify = vi.fn<Notify>();
  const onOpen = vi.fn();
  function Probe() {
    useTaskNotifications(notify, onOpen);
    return null;
  }
  render(
    <ClientProvider client={client}>
      <Probe />
    </ClientProvider>,
  );
  let seq = 0;
  const emit = (over: Record<string, unknown>) => transport.emit(update(++seq, over) as never);
  // The hook's own .then on this promise was attached first, so it has run once this settles.
  const listLoaded = async () => {
    await waitFor(() => expect(list).toHaveBeenCalledWith({ all: true }));
    await list.mock.results[0]!.value;
  };
  return { transport, notify, onOpen, emit, listLoaded };
}

describe("useTaskNotifications", () => {
  it("no notification for tasks already waiting when the app opens", async () => {
    const { emit, notify, listLoaded } = setup(() => [
      task({ id: "a", status: "needs_input" }),
      task({ id: "b", status: "review" }),
      task({ id: "c", status: "failed", error: "x" }),
    ]);
    await listLoaded();
    emit({ id: "a", status: "needs_input" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("a task that existed before the app opened notifies on its next transition", async () => {
    const { emit, notify, listLoaded } = setup(() => [task({ status: "running" })]);
    await listLoaded();
    emit({ status: "review", turns: 2 });
    expect(notify.mock.calls.map(([n]) => n.title)).toEqual(["Ready for review: Fix login"]);
  });

  it("a new task created after mount that arrives in needs_input notifies", async () => {
    const { emit, notify, listLoaded } = setup();
    await listLoaded();
    emit({ id: "new", status: "needs_input" });
    expect(notify.mock.calls.map(([n]) => n.title)).toEqual(["Needs you: Fix login"]);
  });

  it("a list that resolves after a live event does not overwrite it", async () => {
    let answer: ((tasks: unknown[]) => void) | undefined;
    const { emit, notify, listLoaded } = setup(() => new Promise((resolve) => (answer = resolve)));
    await waitFor(() => expect(answer).toBeDefined());
    emit({ status: "review" });
    answer!([task({ status: "running" })]); // read before the transition reached it
    await listLoaded();
    emit({ status: "review", turns: 2 });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies once on entering needs_input, review and failed", () => {
    const { emit, notify } = setup();
    emit({ status: "running" });
    emit({ status: "needs_input" });
    emit({ status: "running", turns: 4 });
    emit({ status: "review", turns: 4 });
    emit({ status: "failed", error: "boom\u0007‮".padEnd(300, "x") });
    expect(notify.mock.calls.map(([n]) => [n.title, n.body])).toEqual([
      ["Needs you: Fix login", "Waiting for your answer"],
      ["Ready for review: Fix login", "4 turns"],
      ["Failed: Fix login", "boom".padEnd(120, "x")],
    ]);
  });

  it("clicking a notification opens the task", () => {
    const { emit, notify, onOpen } = setup();
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    emit({ status: "running" });
    emit({ status: "review" });
    notify.mock.calls[0]![0].onClick();
    expect(onOpen).toHaveBeenCalledWith("t1");
    expect(focus).toHaveBeenCalled();
  });

  it("a repeated status does not notify again", () => {
    const { emit, notify } = setup();
    emit({ status: "running" });
    emit({ status: "review" });
    emit({ status: "review", turns: 2 });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("a reconnect keeps what was seen, so the next transition still notifies", () => {
    const { emit, notify, transport } = setup();
    emit({ status: "running" });
    transport.setStatus("closed");
    transport.setStatus("open");
    emit({ status: "review" });
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
