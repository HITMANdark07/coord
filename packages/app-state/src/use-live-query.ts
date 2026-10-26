import { useEffect, useState } from "react";
import type { DaemonEvent } from "@coord/protocol";
import { useClient } from "./client-context";

export type QueryState<T> =
  | { status: "loading" }
  | { status: "ok"; data: T }
  // `data` is the last good result of the same load, kept so one failed poll doesn't empty the screen.
  | { status: "error"; error: string; data?: T };

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
  // Keyed by `load`: when it changes, the previous data is never shown, not even for one render.
  const [held, setHeld] = useState<{ load: () => Promise<T>; state: QueryState<T> }>({
    load,
    state: { status: "loading" },
  });
  const state: QueryState<T> = held.load === load ? held.state : { status: "loading" };

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
        if (active) setHeld({ load, state: { status: "ok", data } });
      } catch (err) {
        if (active) {
          const error = err instanceof Error ? err.message : String(err);
          setHeld((h) => {
            const last = h.load === load ? h.state : undefined;
            const data = last?.status === "loading" ? undefined : last?.data;
            return {
              load,
              state: data === undefined ? { status: "error", error } : { status: "error", error, data },
            };
          });
        }
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

/** For hooks whose id may be null: a load that never settles makes no request and never polls. */
export const idleLoad = () => new Promise<never>(() => {});
