import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { fakeTransport } from "@coord/client/testing";
import { DaemonError, createClient, type CoordClient } from "@coord/client";
import type { DaemonEvent, PermissionRequestView, Task } from "@coord/protocol";
import {
  ClientProvider,
  useAction,
  useDaemonStatus,
  usePermissions,
  useTask,
  useTaskEvents,
  type TaskEventsState,
  useTasks,
} from "./index";

const health = { ok: true, protocolVersion: "0.1.0", daemonVersion: "0.1.0" };
const task: Task = {
  id: "t1",
  repoId: "",
  repoPath: "/repo",
  title: "Add dark mode",
  prompt: "Add dark mode",
  agent: "claude-code",
  status: "queued",
  branch: null,
  baseBranch: null,
  model: null,
  permissionMode: "ask",
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
  error: null,
  updatedAt: "2026-10-26T00:00:00.000Z",
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

  it("a failed refresh keeps the last data", async () => {
    let fail = false;
    const transport = fakeTransport(() => {
      if (fail) throw new Error("daemon down");
      return [task];
    });
    const { result } = renderHook(() => useTasks(undefined, 60_000), {
      wrapper: wrapperFor(createClient(transport)),
    });
    await waitFor(() => expect(result.current).toEqual({ status: "ok", data: [task] }));
    fail = true;
    act(() => transport.setStatus("open"));
    await waitFor(() =>
      expect(result.current).toEqual({ status: "error", error: "daemon down", data: [task] }),
    );
  });

  it("reloads tasks when the daemon pushes a task event", async () => {
    let tasks: Task[] = [];
    const transport = fakeTransport(() => tasks);
    const { result } = renderHook(() => useTasks(undefined, 60_000), {
      wrapper: wrapperFor(createClient(transport)),
    });
    await waitFor(() => expect(result.current).toEqual({ status: "ok", data: [] }));

    tasks = [task];
    act(() => transport.emit({ seq: 1, at: task.createdAt, payload: { kind: "task.updated", task } }));
    await waitFor(() => expect(result.current).toEqual({ status: "ok", data: [task] }));
  });

  it("collapses a burst of events during a load into one reload, with one load in flight", async () => {
    // Each load waits until the test resolves it, so ordering is fully controlled.
    const pending: Array<(tasks: Task[]) => void> = [];
    const transport = fakeTransport(() => new Promise<Task[]>((resolve) => pending.push(resolve)));
    const { result } = renderHook(() => useTasks(undefined, 60_000), {
      wrapper: wrapperFor(createClient(transport)),
    });
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
    renderHook(() => useTasks(undefined, 60_000), { wrapper: wrapperFor(createClient(transport)) });
    await waitFor(() => expect(transport.requests).toHaveLength(1));
    act(() => transport.setStatus("open"));
    await waitFor(() => expect(transport.requests).toHaveLength(2));
  });

  it("requires a ClientProvider", () => {
    expect(() => renderHook(() => useTasks())).toThrow(/ClientProvider/);
  });

  describe("useTaskEvents", () => {
    const agentEvent = (seq: number, taskId = "t1"): DaemonEvent => ({
      seq,
      at: task.createdAt,
      payload: { kind: "agent.event", taskId, event: { type: "done" } },
    });
    const seqs = (events: DaemonEvent[]) => events.map((e) => e.seq);

    it("merges history and live events in seq order without duplicates", async () => {
      const transport = fakeTransport(() => [agentEvent(1), agentEvent(2)]);
      const { result } = renderHook(() => useTaskEvents("t1"), {
        wrapper: wrapperFor(createClient(transport)),
      });
      await waitFor(() => expect(result.current.status).toBe("ok"));

      act(() => {
        transport.emit(agentEvent(4));
        transport.emit(agentEvent(3));
        transport.emit(agentEvent(2)); // already in the history
        transport.emit(agentEvent(9, "other-task"));
      });
      expect(seqs(result.current.events)).toEqual([1, 2, 3, 4]);
    });

    it("fetches what it missed after the connection reopens", async () => {
      let stored = 4; // events 1..stored exist on the daemon
      const transport = fakeTransport(
        (req) => {
          const since = Number(new URL(req.path, "http://x").searchParams.get("sinceSeq") ?? 0);
          return Array.from({ length: stored }, (_, i) => agentEvent(i + 1)).filter((e) => e.seq > since);
        },
        { gateEvents: true },
      );
      const { result } = renderHook(() => useTaskEvents("t1"), {
        wrapper: wrapperFor(createClient(transport)),
      });
      await waitFor(() => expect(seqs(result.current.events)).toEqual([1, 2, 3, 4]));
      act(() => transport.setStatus("open")); // the socket opened after the load: check the gap too
      await waitFor(() => expect(transport.requests).toHaveLength(2));
      act(() => transport.setStatus("closed"));

      stored = 7; // 5-7 happen while disconnected; a closed gated socket delivers none of them
      for (let n = 5; n <= 7; n++) act(() => transport.emit(agentEvent(n)));
      expect(seqs(result.current.events)).toEqual([1, 2, 3, 4]);

      act(() => transport.setStatus("open"));
      await waitFor(() => expect(seqs(result.current.events)).toEqual([1, 2, 3, 4, 5, 6, 7]));
      expect(transport.requests.map((r) => r.path)).toContain("/tasks/t1/events?sinceSeq=4");
      expect(transport.requests).toHaveLength(3);
    });

    it("subscribed while the connection is closed, the first open fetches what fell between load and open", async () => {
      let stored = 2;
      const transport = fakeTransport(
        (req) => {
          const since = Number(new URL(req.path, "http://x").searchParams.get("sinceSeq") ?? 0);
          return Array.from({ length: stored }, (_, i) => agentEvent(i + 1)).filter((e) => e.seq > since);
        },
        { gateEvents: true },
      );
      const { result } = renderHook(() => useTaskEvents("t1"), {
        wrapper: wrapperFor(createClient(transport)),
      });
      await waitFor(() => expect(seqs(result.current.events)).toEqual([1, 2]));

      stored = 3; // after the history load, before the socket opened: never pushed
      act(() => transport.emit(agentEvent(3)));
      act(() => transport.setStatus("open"));
      await waitFor(() => expect(seqs(result.current.events)).toEqual([1, 2, 3]));
      expect(transport.requests.at(-1)?.path).toBe("/tasks/t1/events?sinceSeq=2");
    });

    it("a failed first load is retried on the first open", async () => {
      let fail = true;
      const transport = fakeTransport(
        () => {
          if (fail) throw new Error("boom");
          return [agentEvent(1)];
        },
        { gateEvents: true },
      );
      const { result } = renderHook(() => useTaskEvents("t1"), {
        wrapper: wrapperFor(createClient(transport)),
      });
      await waitFor(() => expect(result.current.status).toBe("error"));
      fail = false;
      act(() => transport.setStatus("open"));
      await waitFor(() => expect(seqs(result.current.events)).toEqual([1]));
      expect(transport.requests.at(-1)?.path).toBe("/tasks/t1/events");
    });

    it("joining a connection that is already open makes no extra fetch", async () => {
      const transport = fakeTransport(() => [agentEvent(1)]);
      const client = createClient(transport);
      const unsubscribe = client.subscribe({}); // another screen holds the open connection
      act(() => transport.setStatus("open"));
      const { result } = renderHook(() => useTaskEvents("t1"), { wrapper: wrapperFor(client) });
      await waitFor(() => expect(result.current.status).toBe("ok"));
      expect(transport.requests).toHaveLength(1);
      unsubscribe();
    });
  });

  it("usePermissions without a task id lists all pending and drops a resolved one", async () => {
    const perm = (id: string, taskId: string): PermissionRequestView => ({
      id,
      taskId,
      toolUseId: `u-${id}`,
      tool: "Bash",
      input: {},
      canRemember: false,
      createdAt: task.createdAt,
    });
    let pending = [perm("p1", "t1"), perm("p2", "t2")];
    const transport = fakeTransport(() => pending);
    const { result } = renderHook(() => usePermissions(undefined, 60_000), {
      wrapper: wrapperFor(createClient(transport)),
    });
    await waitFor(() => expect(result.current).toEqual({ status: "ok", data: pending }));
    expect(transport.requests[0]?.path).toBe("/permissions");

    pending = [perm("p2", "t2")];
    act(() =>
      transport.emit({
        seq: 1,
        at: task.createdAt,
        payload: { kind: "permission.resolved", requestId: "p1", taskId: "t1", outcome: "allowed" },
      }),
    );
    await waitFor(() => expect(result.current).toEqual({ status: "ok", data: pending }));
  });

  it("useAction records the daemon error and clears it on the next success", async () => {
    let fail = true;
    const fn = async (n: number) => {
      if (fail) throw new DaemonError(409, "conflict", "Already answered");
      return n * 2;
    };
    const { result } = renderHook(() => useAction(fn));
    let first: number | undefined = 1;
    await act(async () => {
      first = await result.current.run(2);
    });
    expect(first).toBeUndefined();
    expect(result.current.error).toBe("Already answered");
    expect(result.current.pending).toBe(false);

    fail = false;
    let second: number | undefined;
    await act(async () => {
      second = await result.current.run(2);
    });
    expect(second).toBe(4);
    expect(result.current.error).toBeNull();
  });

  it("useAction shows a client validation failure as its first issue's message", async () => {
    // The client validates input with zod before sending; a PWA user can type a relative path.
    const client = createClient(fakeTransport(() => ({})));
    const { result } = renderHook(() => useAction(client.addRepo));
    await act(async () => {
      await result.current.run("relative/path");
    });
    expect(result.current.error).toBe("path: must be an absolute path");
  });

  it("useAction is pending while the call runs", async () => {
    let finish: () => void = () => {};
    const { result } = renderHook(() => useAction(() => new Promise<void>((r) => (finish = r))));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.run();
    });
    expect(result.current.pending).toBe(true);
    await act(async () => {
      finish();
      await done;
    });
    expect(result.current.pending).toBe(false);
  });

  it("useTask returns null for a null id and makes no request", async () => {
    const transport = fakeTransport(() => task);
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useTask(id), {
      wrapper: wrapperFor(createClient(transport)),
      initialProps: { id: null as string | null },
    });
    expect(result.current).toBeNull();
    expect(transport.requests).toHaveLength(0);

    rerender({ id: "t1" });
    await waitFor(() => expect(result.current).toEqual({ status: "ok", data: task }));
    expect(transport.requests).toHaveLength(1);
  });

  it("useTasks passes its filter to the daemon", async () => {
    const transport = fakeTransport(() => []);
    renderHook(() => useTasks({ repoId: "r1", all: true }, 60_000), {
      wrapper: wrapperFor(createClient(transport)),
    });
    await waitFor(() => expect(transport.requests[0]?.path).toBe("/tasks?repoId=r1&all=1"));
  });

  it("a changed id or filter never shows the previous data", async () => {
    const transport = fakeTransport((req) => ({ ...task, id: req.path.split("/")[2] ?? "" }));
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useTask(id), {
      wrapper: wrapperFor(createClient(transport)),
      initialProps: { id: "a" as string | null },
    });
    await waitFor(() => expect(result.current).toMatchObject({ status: "ok", data: { id: "a" } }));

    const seen: unknown[] = [];
    const { result: r2, rerender: rerender2 } = renderHook(
      ({ id }: { id: string | null }) => {
        const v = useTask(id);
        seen.push(v);
        return v;
      },
      { wrapper: wrapperFor(createClient(transport)), initialProps: { id: "a" as string | null } },
    );
    await waitFor(() => expect(r2.current).toMatchObject({ status: "ok" }));
    seen.length = 0;
    rerender2({ id: "b" });
    expect(seen[0]).toEqual({ status: "loading" }); // the very first render after the change
    await waitFor(() => expect(r2.current).toMatchObject({ status: "ok", data: { id: "b" } }));

    rerender({ id: null });
    expect(result.current).toBeNull();
    rerender({ id: "b" });
    expect(result.current).toEqual({ status: "loading" });
  });

  it("useTaskEvents never shows the previous task's events after the id changes", async () => {
    const transport = fakeTransport((req) => [
      {
        seq: 1,
        at: task.createdAt,
        payload: { kind: "agent.event", taskId: req.path.split("/")[2] ?? "", event: { type: "done" } },
      },
    ]);
    const seen: TaskEventsState[] = [];
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => {
        const v = useTaskEvents(id);
        seen.push(v);
        return v;
      },
      { wrapper: wrapperFor(createClient(transport)), initialProps: { id: "a" } },
    );
    await waitFor(() => expect(result.current.status).toBe("ok"));
    seen.length = 0;
    rerender({ id: "b" });
    expect(seen[0]).toEqual({ status: "loading", events: [] });
  });

  it("useTaskEvents refetches the full history on reopen if the first load failed", async () => {
    let fail = true;
    const transport = fakeTransport(
      () => {
        if (fail) throw new Error("boom");
        return [1, 2, 3].map((n) => ({
          seq: n,
          at: task.createdAt,
          payload: { kind: "agent.event" as const, taskId: "t1", event: { type: "done" as const } },
        }));
      },
      { gateEvents: true },
    );
    const { result } = renderHook(() => useTaskEvents("t1"), {
      wrapper: wrapperFor(createClient(transport)),
    });
    await waitFor(() => expect(result.current.status).toBe("error"));
    act(() => transport.setStatus("open"));
    act(() =>
      transport.emit({
        seq: 3,
        at: task.createdAt,
        payload: { kind: "agent.event", taskId: "t1", event: { type: "done" } },
      }),
    );
    fail = false;
    act(() => transport.setStatus("closed"));
    act(() => transport.setStatus("open"));
    await waitFor(() => expect(result.current.events.map((e) => e.seq)).toEqual([1, 2, 3]));
    expect(transport.requests.at(-1)?.path).toBe("/tasks/t1/events");
  });

  it("useAction stays pending until every overlapping run finishes", async () => {
    const finishers: Array<() => void> = [];
    const { result } = renderHook(() => useAction(() => new Promise<void>((r) => finishers.push(r))));
    let p1: Promise<unknown> = Promise.resolve();
    let p2: Promise<unknown> = Promise.resolve();
    act(() => {
      p1 = result.current.run();
      p2 = result.current.run();
    });
    await act(async () => {
      finishers[0]?.();
      await p1;
    });
    expect(result.current.pending).toBe(true);
    await act(async () => {
      finishers[1]?.();
      await p2;
    });
    expect(result.current.pending).toBe(false);
  });
});
