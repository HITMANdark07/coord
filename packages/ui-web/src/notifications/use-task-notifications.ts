import { useEffect, useRef } from "react";
import { useClient } from "@coord/app-state";
import { displayText } from "@coord/protocol";
import type { Notify } from "../app";

/**
 * Notify when a task enters needs_input, review or failed (PRD: the user shouldn't watch the board).
 * The first event for a task only records its status, so opening the app with tasks already
 * waiting is silent. The map survives reconnects for the same reason.
 */
export function useTaskNotifications(notify: Notify, onOpen: (taskId: string) => void): void {
  const client = useClient();
  // Refs keep the subscription (and the seen map) alive when the callbacks change identity.
  const latest = useRef({ notify, onOpen });
  latest.current = { notify, onOpen };
  useEffect(() => {
    const seen = new Map<string, string>();
    return client.subscribe({
      onEvent: ({ payload }) => {
        if (payload.kind !== "task.updated") return;
        const { id, status, turns, error } = payload.task;
        const before = seen.get(id);
        seen.set(id, status);
        if (before === undefined || before === status) return;
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
