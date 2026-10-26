import type { Health } from "@coord/protocol";
import { useClient } from "./client-context";
import { useLiveQuery, type QueryState } from "./use-live-query";

export type DaemonStatus = QueryState<Health>;

export function useDaemonStatus(intervalMs = 3000): DaemonStatus {
  return useLiveQuery(useClient().health, { intervalMs });
}
