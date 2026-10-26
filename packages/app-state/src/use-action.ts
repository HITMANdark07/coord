import { useCallback, useState } from "react";

/** Wraps a daemon call for a button: tracks `pending`, and keeps a failure as `error` instead of throwing. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [running, setRunning] = useState(0); // a count, so overlapping runs keep `pending` true until all finish
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setRunning((n) => n + 1);
      try {
        const result = await fn(...args);
        setError(null);
        return result;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return undefined;
      } finally {
        setRunning((n) => n - 1);
      }
    },
    [fn],
  );
  return { run, pending: running > 0, error };
}
