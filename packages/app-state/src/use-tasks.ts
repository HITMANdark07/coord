import { useCallback } from "react";
import type { DaemonEvent, Task } from "@coord/protocol";
import { useClient } from "./client-context";
import { useLiveQuery, type QueryState } from "./use-live-query";

export type TasksState = QueryState<Task[]>;

const isTaskEvent = (event: DaemonEvent) => event.payload.kind === "task.updated";

/** Tasks, refreshed on every task event; polls every `intervalMs` as a fallback. */
export function useTasks(filter: { repoId?: string; all?: boolean } = {}, intervalMs = 15_000): TasksState {
  const client = useClient();
  const { repoId, all } = filter;
  // Memoised on the filter's values: useLiveQuery needs a stable loader.
  const load = useCallback(
    () =>
      client.listTasks({
        ...(repoId === undefined ? {} : { repoId }),
        ...(all === undefined ? {} : { all }),
      }),
    [client, repoId, all],
  );
  return useLiveQuery(load, { intervalMs, refreshOn: isTaskEvent });
}
