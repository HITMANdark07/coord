import type { DaemonEvent, Repo } from "@coord/protocol";
import { useClient } from "./client-context";
import { useLiveQuery, type QueryState } from "./use-live-query";

const isRepoEvent = (event: DaemonEvent) => event.payload.kind === "repo.updated";

export function useRepos(intervalMs = 15_000): QueryState<Repo[]> {
  return useLiveQuery(useClient().listRepos, { intervalMs, refreshOn: isRepoEvent });
}
