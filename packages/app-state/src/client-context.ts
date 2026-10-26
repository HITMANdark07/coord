import { createContext, createElement, useContext, type ReactNode } from "react";
import type { CoordClient } from "@coord/client";

const ClientContext = createContext<CoordClient | null>(null);

/** Each app picks its transport (HTTP, IPC, relay) and provides the client once at the root. */
export function ClientProvider({ client, children }: { client: CoordClient; children: ReactNode }) {
  return createElement(ClientContext.Provider, { value: client }, children);
}

export function useClient(): CoordClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useClient must be used inside <ClientProvider>");
  return client;
}
