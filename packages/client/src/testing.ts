import type { DaemonEvent } from "@coord/protocol";
import type { ConnectionStatus, EventHandlers, Transport, TransportRequest } from "./transport";

/**
 * In-memory Transport for tests in any package: answer requests with `handler`, push events
 * with `emit`, simulate reconnects with `setStatus`. Build the client with `createClient(fake)`.
 */
export function fakeTransport(handler: (req: TransportRequest) => unknown | Promise<unknown>) {
  const subscribers = new Set<EventHandlers>();
  const requests: TransportRequest[] = [];
  let subscribeCalls = 0;
  const transport = {
    requests,
    get subscribeCalls() {
      return subscribeCalls;
    },
    async request(req: TransportRequest) {
      requests.push(req);
      return handler(req);
    },
    subscribe(handlers: EventHandlers) {
      subscribeCalls++;
      subscribers.add(handlers);
      return () => subscribers.delete(handlers);
    },
    emit(event: DaemonEvent) {
      for (const s of subscribers) s.onEvent(event);
    },
    setStatus(status: ConnectionStatus) {
      for (const s of subscribers) s.onStatus?.(status);
    },
  } satisfies Transport & Record<string, unknown>;
  return transport;
}
