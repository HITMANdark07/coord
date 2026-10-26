import type { DaemonEvent, Task } from "@wto/protocol";
import { useClient } from "./client-context";
import { useLiveQuery, type QueryState } from "./use-live-query";

export type TasksState = QueryState<Task[]>;

const isTaskEvent = (event: DaemonEvent) => event.payload.kind === "task.updated";

/** All tasks, refreshed on every task event; polls every `intervalMs` as a fallback. */
export function useTasks(intervalMs = 15_000): TasksState {
  return useLiveQuery(useClient().listTasks, { intervalMs, refreshOn: isTaskEvent });
}
