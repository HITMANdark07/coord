import type { DaemonEvent, DaemonEventPayload } from "@coord/protocol";

type Listener = (event: DaemonEvent) => void;

/** In-process pub/sub for daemon events. Stamps each event with a sequence number and time. */
export class EventBus {
  private seq = 0;
  private listeners = new Set<Listener>();

  publish(payload: DaemonEventPayload): DaemonEvent {
    const event: DaemonEvent = { seq: ++this.seq, at: new Date().toISOString(), payload };
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
