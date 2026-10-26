import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClientProvider } from "@wto/app-state";
import { createClient, type Transport } from "@wto/client";
import { App } from "@wto/ui-web";
import { fromIpcReply, type WtoBridge } from "../../shared/ipc";

declare global {
  interface Window {
    wto: WtoBridge;
  }
}

// The renderer has no Node access; daemon calls and events go through the preload bridge.
const ipcTransport: Transport = {
  request: async (req) => fromIpcReply(await window.wto.request(req)),
  subscribe: ({ onEvent, onStatus }) =>
    window.wto.onPush((push) => ("event" in push ? onEvent(push.event) : onStatus?.(push.status))),
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClientProvider client={createClient(ipcTransport)}>
      <App surface="desktop" />
    </ClientProvider>
  </StrictMode>,
);
