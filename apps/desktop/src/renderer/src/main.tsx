import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClientProvider } from "@coord/app-state";
import { createClient, type Transport } from "@coord/client";
import { App } from "@coord/ui-web";
import { fromIpcReply, type CoordBridge } from "../../shared/ipc";

declare global {
  interface Window {
    coord: CoordBridge;
  }
}

// The renderer has no Node access; daemon calls and events go through the preload bridge.
const ipcTransport: Transport = {
  request: async (req) => fromIpcReply(await window.coord.request(req)),
  subscribe: ({ onEvent, onStatus }) =>
    window.coord.onPush((push) => ("event" in push ? onEvent(push.event) : onStatus?.(push.status))),
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClientProvider client={createClient(ipcTransport)}>
      <App surface="desktop" platform={{ pickFolder: () => window.coord.pickFolder() }} />
    </ClientProvider>
  </StrictMode>,
);
