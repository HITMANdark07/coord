import type { DaemonEvent, DaemonEventPayload } from "@coord/protocol";

type Listener = (event: DaemonEvent) => void;

export interface EventBusOptions {
  /** Last seq already stored, so numbering continues across daemon restarts. */
  startSeq?: number;
  /** Stores each event. Runs before listeners, so no client sees an event that was lost. */
  persist?: (event: DaemonEvent) => void;
}

/** In-process pub/sub for daemon events. Stamps each event with a sequence number and time. */
export class EventBus {
  private seq: number;
  private readonly persist?: (event: DaemonEvent) => void;
  private listeners = new Set<Listener>();

  constructor(options: EventBusOptions = {}) {
    this.seq = options.startSeq ?? 0;
    this.persist = options.persist;
  }

  publish(payload: DaemonEventPayload): DaemonEvent {
    const event: DaemonEvent = { seq: ++this.seq, at: new Date().toISOString(), payload };
    this.persist?.(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
