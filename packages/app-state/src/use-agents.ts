import type { AgentInfo } from "@coord/protocol";
import { useClient } from "./client-context";
import { useLiveQuery, type QueryState } from "./use-live-query";

/** Installed agents rarely change, so this polls slowly and listens for no events. */
export function useAgents(intervalMs = 60_000): QueryState<AgentInfo[]> {
  return useLiveQuery(useClient().listAgents, { intervalMs });
}
