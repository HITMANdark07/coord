import { useCallback } from "react";
import type { DaemonEvent, Task } from "@coord/protocol";
import { useClient } from "./client-context";
import { idleLoad, useLiveQuery, type QueryState } from "./use-live-query";

/** One task, or null (and no request) while no task is selected. */
export function useTask(taskId: string | null, intervalMs = 15_000): QueryState<Task> | null {
  const client = useClient();
  const load = useCallback(() => (taskId === null ? idleLoad() : client.getTask(taskId)), [client, taskId]);
  const refreshOn = useCallback(
    (event: DaemonEvent) => event.payload.kind === "task.updated" && event.payload.task.id === taskId,
    [taskId],
  );
  const state = useLiveQuery(load, { intervalMs, refreshOn });
  return taskId === null ? null : state;
}
