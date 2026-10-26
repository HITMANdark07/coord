const STORAGE_KEY = "coord.daemonToken";

/**
 * The daemon token arrives in the URL fragment of the link `pnpm coord web` prints
 * (`…/#token=…`). Fragments are never sent to a server. It is kept for this browser tab only,
 * and removed from the address bar so it doesn't end up in history or screenshots.
 */
export function takeDaemonToken(location: Location, history: History, storage: Storage): string | undefined {
  const fromLink = new URLSearchParams(location.hash.slice(1)).get("token");
  if (fromLink) {
    storage.setItem(STORAGE_KEY, fromLink);
    history.replaceState(null, "", location.pathname + location.search);
    return fromLink;
  }
  return storage.getItem(STORAGE_KEY) ?? undefined;
}

/** After a daemon restart the stored token is stale; the next link brings a new one. */
export function forgetDaemonToken(storage: Storage): void {
  storage.removeItem(STORAGE_KEY);
}
