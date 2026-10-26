import { useCallback, useState } from "react";

/** Wraps a daemon call for a button: tracks `pending`, and keeps a failure as `error` instead of throwing. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setPending(true);
      try {
        const result = await fn(...args);
        setError(null);
        return result;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );
  return { run, pending, error };
}
