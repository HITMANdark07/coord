import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "@coord/app-state";
import { createClient } from "@coord/client";
import { fakeTransport } from "@coord/client/testing";
import type { Notify } from "../app";
import { useTaskNotifications } from "./use-task-notifications";

// No vitest globals, so testing-library does not unmount between tests by itself.
afterEach(cleanup);

const update = (seq: number, over: Record<string, unknown>) => ({
  seq,
  at: "x",
  payload: {
    kind: "task.updated",
    task: {
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
    },
  },
});

function setup() {
  const transport = fakeTransport(() => []);
  const notify = vi.fn<Notify>();
  const onOpen = vi.fn();
  function Probe() {
    useTaskNotifications(notify, onOpen);
    return null;
  }
  render(
    <ClientProvider client={createClient(transport)}>
      <Probe />
    </ClientProvider>,
  );
  let seq = 0;
  const emit = (over: Record<string, unknown>) => transport.emit(update(++seq, over) as never);
  return { transport, notify, onOpen, emit };
}

describe("useTaskNotifications", () => {
  it("no notification for statuses seen on first load", () => {
    const { emit, notify } = setup();
    emit({ id: "a", status: "needs_input" });
    emit({ id: "b", status: "review" });
    emit({ id: "c", status: "failed", error: "x" });
    expect(notify).not.toHaveBeenCalled();
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
