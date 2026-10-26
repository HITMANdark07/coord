import { createContext, createElement, useContext, type ReactNode } from "react";
import type { WtoClient } from "@wto/client";

const ClientContext = createContext<WtoClient | null>(null);

/** Each app picks its transport (HTTP, IPC, relay) and provides the client once at the root. */
export function ClientProvider({ client, children }: { client: WtoClient; children: ReactNode }) {
  return createElement(ClientContext.Provider, { value: client }, children);
}

export function useClient(): WtoClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useClient must be used inside <ClientProvider>");
  return client;
}
