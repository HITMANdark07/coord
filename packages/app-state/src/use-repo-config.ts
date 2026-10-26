import { useCallback } from "react";
import type { DaemonEvent, RepoConfigView } from "@coord/protocol";
import { useClient } from "./client-context";
import { idleLoad, useLiveQuery, type QueryState } from "./use-live-query";

/** The config a new task in this repo would use, or null (and no request) while no repo is selected. */
export function useRepoConfig(repoId: string | null, intervalMs = 15_000): QueryState<RepoConfigView> | null {
  const client = useClient();
  const load = useCallback(
    () => (repoId === null ? idleLoad() : client.repoConfig(repoId)),
    [client, repoId],
  );
  const refreshOn = useCallback(
    (event: DaemonEvent) => event.payload.kind === "repo.updated" && event.payload.repo.id === repoId,
    [repoId],
  );
  const state = useLiveQuery(load, { intervalMs, refreshOn });
  return repoId === null ? null : state;
}
