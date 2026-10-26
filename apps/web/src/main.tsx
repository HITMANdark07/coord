import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClientProvider } from "@wto/app-state";
import { createClient, httpTransport } from "@wto/client";
import { App } from "@wto/ui-web";
import { takeDaemonToken } from "./daemon-token";

const token = takeDaemonToken(window.location, window.history, window.sessionStorage);

// Absolute URL so the event WebSocket (ws://…/api/events) can be derived from it.
const client = createClient(httpTransport({ baseUrl: new URL("/api", window.location.href).href, token }));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClientProvider client={client}>
      {token ? null : (
        <p style={{ fontFamily: "system-ui, sans-serif", padding: 16 }}>
          Not connected to a daemon. Open the link printed by <code>pnpm wto web</code>.
        </p>
      )}
      <App surface="web" />
    </ClientProvider>
  </StrictMode>,
);
