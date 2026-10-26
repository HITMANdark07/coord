import { useEffect, useRef } from "react";
import { useClient } from "@coord/app-state";
import { displayText } from "@coord/protocol";
import type { Notify } from "../app";

/**
 * Notify when a task enters needs_input, review or failed (PRD: the user shouldn't watch the board).
 * The daemon publishes task.updated only on creation and transitions and never replays, so every
 * event is live. Statuses from the list at mount are recorded so opening the app with tasks
 * already waiting is silent; the map survives reconnects so a repeat never notifies twice.
 */
export function useTaskNotifications(notify: Notify, onOpen: (taskId: string) => void): void {
  const client = useClient();
  // Refs keep the subscription (and the seen map) alive when the callbacks change identity.
  const latest = useRef({ notify, onOpen });
  latest.current = { notify, onOpen };
  useEffect(() => {
    const seen = new Map<string, string>();
    // Only ids no event has recorded yet: a live event is newer than the list.
    client.listTasks({ all: true }).then(
      (tasks) => {
        for (const t of tasks) if (!seen.has(t.id)) seen.set(t.id, t.status);
      },
      () => {}, // a failed list loses only the seed: every pushed event is still a live transition
    );
    return client.subscribe({
      onEvent: ({ payload }) => {
        if (payload.kind !== "task.updated") return;
        const { id, status, turns, error } = payload.task;
        const before = seen.get(id);
        seen.set(id, status);
        if (before === status) return;
        const title = displayText(payload.task.title);
        const body =
          status === "needs_input"
            ? "Waiting for your answer"
            : status === "review"
              ? `${turns} ${turns === 1 ? "turn" : "turns"}`
              : status === "failed"
                ? displayText(error ?? "").slice(0, 120)
                : null;
        if (body === null) return;
        const heading =
          status === "needs_input" ? "Needs you" : status === "review" ? "Ready for review" : "Failed";
        latest.current.notify({
          title: `${heading}: ${title}`,
          body,
          onClick: () => {
            latest.current.onOpen(id);
            window.focus();
          },
        });
      },
    });
  }, [client]);
}
