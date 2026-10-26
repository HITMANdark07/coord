import { useCallback, useState } from "react";

// A zod error's message is the JSON issue list; this package has no zod, so match by shape.
function readable(err: unknown): string {
  const issues = err instanceof Error && "issues" in err ? err.issues : undefined;
  const first: unknown = Array.isArray(issues) ? issues[0] : undefined;
  if (first && typeof first === "object" && "message" in first && typeof first.message === "string") {
    // A bare "Required" says nothing without the field it belongs to.
    const path = "path" in first && Array.isArray(first.path) ? first.path.map(String).join(".") : "";
    return path ? `${path}: ${first.message}` : first.message;
  }
  return err instanceof Error ? err.message : String(err);
}

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
        setError(readable(err));
        return undefined;
      } finally {
        setRunning((n) => n - 1);
      }
    },
    [fn],
  );
  return { run, pending: running > 0, error };
}
