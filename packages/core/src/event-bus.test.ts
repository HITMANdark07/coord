import { describe, expect, it } from "vitest";
import type { DaemonEvent, DaemonEventPayload } from "@coord/protocol";
import { EventBus } from "./event-bus.js";

const payload: DaemonEventPayload = {
  kind: "permission.resolved",
  requestId: "r1",
  taskId: "t1",
  outcome: "allowed",
};

describe("EventBus", () => {
  it("starts at seq 1 with no options", () => {
    expect(new EventBus().publish(payload).seq).toBe(1);
  });

  it("bus continues seq after restart", () => {
    expect(new EventBus({ startSeq: 41 }).publish(payload).seq).toBe(42);
  });

  it("bus persists before notifying", () => {
    const persisted: DaemonEvent[] = [];
    const bus = new EventBus({ persist: (e) => persisted.push(e) });
    let seenPersisted = false;
    bus.subscribe((e) => {
      seenPersisted = persisted.includes(e);
    });
    bus.publish(payload);
    expect(seenPersisted).toBe(true);
  });
});
