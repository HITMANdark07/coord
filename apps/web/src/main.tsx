import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClientProvider } from "@coord/app-state";
import { createClient, httpTransport } from "@coord/client";
import { App } from "@coord/ui-web";
import { takeDaemonToken } from "./daemon-token";
import { expireTokenOn401, reloadOnNewToken, StaleTokenNotice } from "./stale-token";

const token = takeDaemonToken(window.location, window.history, window.sessionStorage);
reloadOnNewToken(window, () => window.location.reload());

// Absolute URL so the event WebSocket (ws://…/api/events) can be derived from it.
const client = createClient(
  expireTokenOn401(
    httpTransport({ baseUrl: new URL("/api", window.location.href).href, token }),
    window.sessionStorage,
  ),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClientProvider client={client}>
      {token ? null : (
        <p style={{ fontFamily: "system-ui, sans-serif", padding: 16 }}>
          Not connected to a daemon. Open the link printed by <code>pnpm coord web</code>.
        </p>
      )}
      <StaleTokenNotice />
      <App surface="web" />
    </ClientProvider>
  </StrictMode>,
);
