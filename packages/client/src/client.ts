import { z } from "zod";
import { CreateTaskInput, DaemonEvent, Health, Task } from "@wto/protocol";
import { httpTransport, type ConnectionStatus, type Transport } from "./transport";

export interface DaemonEventListener {
  onEvent?(event: DaemonEvent): void;
  onStatus?(status: ConnectionStatus): void;
}

/** Typed daemon API. Every response and pushed event is validated against the protocol schemas. */
export function createClient(transport: Transport = httpTransport()) {
  const get = (path: string) => transport.request({ method: "GET", path });

  // One upstream event connection per client, shared by every subscriber (each hook would
  // otherwise open its own socket, and over the relay each socket is a separate peer).
  const listeners = new Set<DaemonEventListener>();
  let closeUpstream: (() => void) | undefined;
  let status: ConnectionStatus = "closed";

  function subscribe(listener: DaemonEventListener): () => void {
    listeners.add(listener);
    if (!closeUpstream) {
      closeUpstream = transport.subscribe({
        onEvent: (raw) => {
          const event = DaemonEvent.safeParse(raw);
          if (event.success) for (const l of listeners) l.onEvent?.(event.data);
        },
        onStatus: (next) => {
          status = next;
          for (const l of listeners) l.onStatus?.(next);
        },
      });
    } else if (status === "open") {
      listener.onStatus?.("open");
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        closeUpstream?.();
        closeUpstream = undefined;
        status = "closed";
      }
    };
  }

  return {
    health: async () => Health.parse(await get("/health")),
    listTasks: async () => z.array(Task).parse(await get("/tasks")),
    getTask: async (id: string) => Task.parse(await get(`/tasks/${encodeURIComponent(id)}`)),
    createTask: async (input: CreateTaskInput) =>
      Task.parse(
        await transport.request({ method: "POST", path: "/tasks", body: CreateTaskInput.parse(input) }),
      ),
    /** Live daemon events and connection status. Frames that don't match the protocol are dropped. */
    subscribe,
  };
}

export type WtoClient = ReturnType<typeof createClient>;
