import { useEffect, useState } from "react";
import type { DaemonEvent } from "@coord/protocol";
import { useClient } from "./client-context";

export type TaskEventsState = {
  status: "loading" | "ok" | "error";
  events: DaemonEvent[];
  error?: string;
};

/** Sorted by seq, one entry per seq: history and pushed events overlap, and a retry can repeat both. */
function merge(have: DaemonEvent[], incoming: DaemonEvent[]): DaemonEvent[] {
  const bySeq = new Map(have.map((e) => [e.seq, e]));
  for (const e of incoming) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function isForTask(event: DaemonEvent, taskId: string): boolean {
  const p = event.payload;
  switch (p.kind) {
    case "task.updated":
      return p.task.id === taskId;
    case "agent.event":
    case "permission.resolved":
      return p.taskId === taskId;
    case "permission.requested":
      return p.request.taskId === taskId;
    default:
      return false;
  }
}

/** A task's event history plus live events. After the event connection reopens it fetches what it missed. */
export function useTaskEvents(taskId: string): TaskEventsState {
  const client = useClient();
  // Keyed by taskId so the first render after the id changes never shows the old task's events.
  const [held, setHeld] = useState<{ taskId: string; state: TaskEventsState }>({
    taskId,
    state: { status: "loading", events: [] },
  });
  const state: TaskEventsState = held.taskId === taskId ? held.state : { status: "loading", events: [] };

  useEffect(() => {
    let active = true;
    let lastSeq: number | undefined;
    let subscribing = true;
    let historyLoaded = false;
    const setState = (update: (s: TaskEventsState) => TaskEventsState) =>
      setHeld((h) => ({
        taskId,
        state: update(h.taskId === taskId ? h.state : { status: "loading", events: [] }),
      }));

    const add = (incoming: DaemonEvent[]) => {
      for (const e of incoming) lastSeq = Math.max(lastSeq ?? e.seq, e.seq);
      return incoming;
    };
    const fetchSince = (sinceSeq?: number) =>
      client.taskEvents(taskId, sinceSeq).then(
        (events) => {
          if (!active) return;
          if (sinceSeq === undefined) historyLoaded = true;
          setState((s) => ({ status: "ok", events: merge(s.events, add(events)) }));
        },
        (err: unknown) => {
          if (active) {
            setState((s) => ({
              ...s,
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            }));
          }
        },
      );

    // Subscribe before loading so no event can fall in the gap between the two.
    const unsubscribe = client.subscribe({
      onEvent: (event) => {
        if (isForTask(event, taskId)) setState((s) => ({ ...s, events: merge(s.events, add([event])) }));
      },
      onStatus: (status) => {
        // An "open" replayed inside subscribe() is a connection the initial load already covers.
        // Any later one (even the first this hook sees) may follow a gap the socket never delivered.
        // Until the history has loaded, lastSeq may come from a live event alone, so refetch it all.
        if (status === "open" && !subscribing) void fetchSince(historyLoaded ? lastSeq : undefined);
      },
    });
    subscribing = false;
    void fetchSince();

    return () => {
      active = false;
      unsubscribe();
    };
  }, [client, taskId]);

  return state;
}
