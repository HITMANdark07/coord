import { useSyncExternalStore } from "react";
import { DaemonError, type Transport } from "@coord/client";
import { forgetDaemonToken } from "./daemon-token";

// Module-level: a page holds one daemon link, and a reload (the only fix) resets it.
let stale = false;
const listeners = new Set<() => void>();

/**
 * The daemon makes a new token on every start, so after a restart every call from this tab
 * answers 401 while /health (no token needed) still says connected. Forget the token and say why.
 */
export function expireTokenOn401(transport: Transport, storage: Storage): Transport {
  return {
    subscribe: (handlers) => transport.subscribe(handlers),
    request: async (req) => {
      try {
        return await transport.request(req);
      } catch (err) {
        if (err instanceof DaemonError && err.status === 401) {
          forgetDaemonToken(storage);
          stale = true;
          for (const l of listeners) l();
        }
        throw err;
      }
    },
  };
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function StaleTokenNotice() {
  const show = useSyncExternalStore(subscribe, () => stale);
  return show ? (
    <p role="alert" style={{ fontFamily: "system-ui, sans-serif", padding: 16 }}>
      The daemon restarted, so this link no longer works. Run <code>pnpm coord web</code> and open the new
      link.
    </p>
  ) : null;
}

/** Pasting the new link into the same tab changes only the fragment, which doesn't reload the page. */
export function reloadOnNewToken(win: Window, reload: () => void): void {
  win.addEventListener("hashchange", () => {
    if (new URLSearchParams(win.location.hash.slice(1)).has("token")) reload();
  });
}
