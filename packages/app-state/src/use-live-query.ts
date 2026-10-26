import { useEffect, useState } from "react";
import type { DaemonEvent } from "@coord/protocol";
import { useClient } from "./client-context";

export type QueryState<T> =
  { status: "loading" } | { status: "ok"; data: T } | { status: "error"; error: string };

/**
 * Loads data and keeps it fresh: reloads when a matching daemon event arrives or the event
 * connection reopens, and polls every `intervalMs` as a fallback.
 * - At most one load is in flight. Events during a load mark it dirty, and it reloads once
 *   when the load finishes, so a burst of events costs at most two loads.
 * - `load` and `refreshOn` must be stable (module-level or memoized).
 */
export function useLiveQuery<T>(
  load: () => Promise<T>,
  options: { intervalMs: number; refreshOn?: (event: DaemonEvent) => boolean },
): QueryState<T> {
  const { intervalMs, refreshOn } = options;
  const client = useClient();
  const [state, setState] = useState<QueryState<T>>({ status: "loading" });

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      if (inFlight) {
        dirty = true;
        return;
      }
      inFlight = true;
      clearTimeout(timer);
      try {
        const data = await load();
        if (active) setState({ status: "ok", data });
      } catch (err) {
        if (active) setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      }
      inFlight = false;
      if (!active) return;
      if (dirty) {
        dirty = false;
        void run();
      } else {
        timer = setTimeout(run, intervalMs);
      }
    };

    void run();
    const unsubscribe = refreshOn
      ? client.subscribe({
          onEvent: (event) => {
            if (refreshOn(event)) void run();
          },
          // Events may have been missed while disconnected.
          onStatus: (status) => {
            if (status === "open") void run();
          },
        })
      : undefined;

    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [client, load, intervalMs, refreshOn]);

  return state;
}
