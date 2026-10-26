import { describe, expect, it } from "vitest";
import { openStore } from "@coord/task-store";
import type { DaemonEvent, PermissionRequest } from "@coord/protocol";
import { EventBus } from "./event-bus.js";
import { PermissionBroker } from "./permission-broker.js";

const req: PermissionRequest = {
  toolUseId: "tu1",
  tool: "Bash",
  input: { command: "ls" },
  canRemember: true,
};

function setup() {
  const store = openStore(":memory:");
  const bus = new EventBus();
  const events: DaemonEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const changes: Array<[string, number]> = [];
  const broker = new PermissionBroker({ store, bus, onPendingChange: (t, n) => changes.push([t, n]) });
  return { store, broker, events, changes };
}

describe("PermissionBroker", () => {
  it("answer resolves the agent's request and publishes resolved", async () => {
    const { broker, events, store } = setup();
    const p = broker.request("t1", req, new AbortController().signal);
    const [view] = broker.pending("t1");
    expect(view?.tool).toBe("Bash");
    expect(events[0]?.payload.kind).toBe("permission.requested");
    expect(broker.answer(view!.id, { allow: true })).toBe("ok");
    expect(await p).toEqual({ allow: true });
    expect(events[1]?.payload).toEqual({
      kind: "permission.resolved",
      requestId: view!.id,
      taskId: "t1",
      outcome: "allowed",
    });
    expect(store.listPendingPermissions()).toEqual([]);
  });

  it("remember maps to always", async () => {
    const { broker, events } = setup();
    const p = broker.request("t1", req, new AbortController().signal);
    broker.answer(broker.pending()[0]!.id, { allow: true, remember: true });
    await p;
    expect(events.at(-1)?.payload).toMatchObject({ outcome: "always" });
  });

  it("deny maps to denied", async () => {
    const { broker, events } = setup();
    const p = broker.request("t1", req, new AbortController().signal);
    broker.answer(broker.pending()[0]!.id, { allow: false, reason: "no" });
    expect(await p).toEqual({ allow: false, reason: "no" });
    expect(events.at(-1)?.payload).toMatchObject({ outcome: "denied" });
  });

  it("second answer is already_resolved", async () => {
    const { broker } = setup();
    const p = broker.request("t1", req, new AbortController().signal);
    const id = broker.pending()[0]!.id;
    expect(broker.answer(id, { allow: true })).toBe("ok");
    await p;
    expect(broker.answer(id, { allow: false })).toBe("already_resolved");
    expect(broker.answer("nope", { allow: true })).toBe("not_found");
  });

  it("abort withdraws and notifies", async () => {
    const { broker, events, changes } = setup();
    const ac = new AbortController();
    const p = broker.request("t1", req, ac.signal);
    ac.abort();
    expect(await p).toEqual({ allow: false, reason: "withdrawn" });
    expect(events.at(-1)?.payload).toMatchObject({ kind: "permission.resolved", outcome: "withdrawn" });
    expect(changes.at(-1)).toEqual(["t1", 0]);
    expect(broker.pending()).toEqual([]);
  });

  it("already-aborted signal withdraws immediately", async () => {
    const { broker } = setup();
    const ac = new AbortController();
    ac.abort();
    expect(await broker.request("t1", req, ac.signal)).toEqual({ allow: false, reason: "withdrawn" });
    expect(broker.pending()).toEqual([]);
  });

  it("onPendingChange reports counts per task", async () => {
    const { broker, changes } = setup();
    const ac = new AbortController();
    void broker.request("t1", req, ac.signal);
    void broker.request("t1", { ...req, toolUseId: "tu2" }, ac.signal);
    void broker.request("t2", req, ac.signal);
    broker.answer(broker.pending("t1")[0]!.id, { allow: true });
    broker.withdrawAll("t1");
    expect(changes).toEqual([
      ["t1", 1],
      ["t1", 2],
      ["t2", 1],
      ["t1", 1],
      ["t1", 0],
    ]);
    expect(broker.pending().map((v) => v.taskId)).toEqual(["t2"]);
  });

  it("answers a stored pending request with no waiter (after restart)", () => {
    const { store, changes } = setup();
    store.savePermission({
      id: "old",
      taskId: "t9",
      toolUseId: "x",
      tool: "Bash",
      input: {},
      canRemember: false,
      createdAt: new Date().toISOString(),
    });
    const bus = new EventBus();
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const broker = new PermissionBroker({ store, bus, onPendingChange: (t, n) => changes.push([t, n]) });
    expect(broker.answer("old", { allow: true })).toBe("ok");
    expect(store.listPendingPermissions()).toEqual([]);
    expect(events.map((e) => e.payload)).toEqual([
      { kind: "permission.resolved", requestId: "old", taskId: "t9", outcome: "allowed" },
    ]);
    expect(changes.at(-1)).toEqual(["t9", 0]);
  });

  it("still resolves the agent's promise when onPendingChange throws", async () => {
    const store = openStore(":memory:");
    let calls = 0;
    const broker = new PermissionBroker({
      store,
      bus: new EventBus(),
      onPendingChange: () => {
        if (++calls === 2) throw new Error("boom");
      },
    });
    const p = broker.request("t1", req, new AbortController().signal);
    expect(() => broker.answer(broker.pending()[0]!.id, { allow: true })).toThrow("boom");
    expect(await p).toEqual({ allow: true });
  });
});
