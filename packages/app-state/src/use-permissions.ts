import { useCallback } from "react";
import type { DaemonEvent, PermissionRequestView } from "@coord/protocol";
import { useClient } from "./client-context";
import { useLiveQuery, type QueryState } from "./use-live-query";

/** Pending permission prompts: every task's, or just `taskId`'s. */
export function usePermissions(taskId?: string, intervalMs = 15_000): QueryState<PermissionRequestView[]> {
  const client = useClient();
  const load = useCallback(() => client.listPermissions(taskId), [client, taskId]);
  const refreshOn = useCallback(
    (event: DaemonEvent) => {
      const p = event.payload;
      if (p.kind === "permission.requested") return taskId === undefined || p.request.taskId === taskId;
      if (p.kind === "permission.resolved") return taskId === undefined || p.taskId === taskId;
      return false;
    },
    [taskId],
  );
  return useLiveQuery(load, { intervalMs, refreshOn });
}
