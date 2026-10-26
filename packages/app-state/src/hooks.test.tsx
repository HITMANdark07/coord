import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createClient, type CoordClient } from "@coord/client";
import { fakeTransport } from "@coord/client/testing";
import type { Task } from "@coord/protocol";
import { ClientProvider, useDaemonStatus, useTasks } from "./index";

const health = { ok: true, protocolVersion: "0.1.0", daemonVersion: "0.1.0" };
const task: Task = {
  id: "t1",
  repoPath: "/repo",
  title: "Add dark mode",
  prompt: "Add dark mode",
  agent: "claude-code",
  status: "queued",
  branch: null,
  worktreePath: null,
  sessionId: null,
  costUsd: 0,
  createdAt: "2026-10-26T00:00:00.000Z",
};

function wrapperFor(client: CoordClient) {
  return ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client}>{children}</ClientProvider>
  );
}

describe("app-state hooks", () => {
  it("reports the daemon as connected", async () => {
    const client = createClient(fakeTransport(() => health));
    const { result } = renderHook(() => useDaemonStatus(), { wrapper: wrapperFor(client) });
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ok"));
  });

  it("surfaces daemon errors", async () => {
    const client = createClient(
      fakeTransport(() => {
        throw new Error("daemon down");
      }),
    );
    const { result } = renderHook(() => useTasks(), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current).toEqual({ status: "error", error: "daemon down" }));
  });

  it("reloads tasks when the daemon pushes a task event", async () => {
    let tasks: Task[] = [];
    const transport = fakeTransport(() => tasks);
    const { result } = renderHook(() => useTasks(60_000), { wrapper: wrapperFor(createClient(transport)) });
    await waitFor(() => expect(result.current).toEqual({ status: "ok", data: [] }));

    tasks = [task];
    act(() => transport.emit({ seq: 1, at: task.createdAt, payload: { kind: "task.updated", task } }));
    await waitFor(() => expect(result.current).toEqual({ status: "ok", data: [task] }));
  });

  it("collapses a burst of events during a load into one reload, with one load in flight", async () => {
    // Each load waits until the test resolves it, so ordering is fully controlled.
    const pending: Array<(tasks: Task[]) => void> = [];
    const transport = fakeTransport(() => new Promise<Task[]>((resolve) => pending.push(resolve)));
    const { result } = renderHook(() => useTasks(60_000), { wrapper: wrapperFor(createClient(transport)) });
    await waitFor(() => expect(pending).toHaveLength(1));

    // 20 events arrive while the first load is still running.
    act(() => {
      for (let i = 0; i < 20; i++) {
        transport.emit({ seq: i, at: task.createdAt, payload: { kind: "task.updated", task } });
      }
    });
    expect(transport.requests).toHaveLength(1);

    await act(async () => pending[0]?.([]));
    expect(result.current).toEqual({ status: "ok", data: [] });
    // Exactly one follow-up load for the whole burst.
    await waitFor(() => expect(transport.requests).toHaveLength(2));

    await act(async () => pending[1]?.([task]));
    expect(result.current).toEqual({ status: "ok", data: [task] });
    expect(transport.requests).toHaveLength(2);
  });

  it("schedules the next poll only after the previous one settles", async () => {
    const pending: Array<(h: typeof health) => void> = [];
    const transport = fakeTransport(() => new Promise((resolve) => pending.push(resolve)));
    renderHook(() => useDaemonStatus(1), { wrapper: wrapperFor(createClient(transport)) });
    await waitFor(() => expect(pending).toHaveLength(1));
    // The interval (1 ms) passes many times while the load is unresolved: no second request.
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(transport.requests).toHaveLength(1);
    await act(async () => pending[0]?.(health));
    await waitFor(() => expect(transport.requests).toHaveLength(2));
  });

  it("refetches when the event connection reopens", async () => {
    const transport = fakeTransport(() => []);
    renderHook(() => useTasks(60_000), { wrapper: wrapperFor(createClient(transport)) });
    await waitFor(() => expect(transport.requests).toHaveLength(1));
    act(() => transport.setStatus("open"));
    await waitFor(() => expect(transport.requests).toHaveLength(2));
  });

  it("requires a ClientProvider", () => {
    expect(() => renderHook(() => useTasks())).toThrow(/ClientProvider/);
  });
});
