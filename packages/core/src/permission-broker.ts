import { randomUUID } from "node:crypto";
import type { PermissionDecision, PermissionRequest, PermissionRequestView } from "@coord/protocol";
import type { Store } from "@coord/task-store";
import type { EventBus } from "./event-bus.js";

type Outcome = "allowed" | "always" | "denied" | "withdrawn";

interface Waiter {
  taskId: string;
  resolve: (d: PermissionDecision) => void;
  cleanup: () => void;
}

const WITHDRAWN: PermissionDecision = { allow: false, reason: "withdrawn" };

/** Records agent permission requests, pushes them to clients and resolves the agent's promise on answer. */
export class PermissionBroker {
  private readonly waiters = new Map<string, Waiter>();
  // The store only lists pending rows, so this is how a late second answer is told apart from an unknown id.
  private readonly resolved = new Set<string>();

  constructor(
    private readonly deps: {
      store: Store;
      bus: EventBus;
      onPendingChange: (taskId: string, pending: number) => void;
    },
  ) {}

  request(taskId: string, req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    if (signal.aborted) return Promise.resolve(WITHDRAWN);
    const id = randomUUID();
    const view: PermissionRequestView = { ...req, id, taskId, createdAt: new Date().toISOString() };
    return new Promise<PermissionDecision>((resolve) => {
      const onAbort = () => this.settle(id, "withdrawn", WITHDRAWN);
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(id, { taskId, resolve, cleanup: () => signal.removeEventListener("abort", onAbort) });
      this.deps.store.savePermission(view);
      this.deps.bus.publish({ kind: "permission.requested", request: view });
      this.changed(taskId);
    });
  }

  answer(id: string, decision: PermissionDecision): "ok" | "not_found" | "already_resolved" {
    const outcome: Outcome = decision.allow ? (decision.remember ? "always" : "allowed") : "denied";
    const waiter = this.waiters.get(id);
    if (waiter) return this.settle(id, outcome, decision) ? "ok" : "already_resolved";
    // No waiting promise: either unknown, resolved earlier, or left over from before a restart.
    const stored = this.deps.store.listPendingPermissions().find((p) => p.id === id);
    if (!stored) return this.resolved.has(id) ? "already_resolved" : "not_found";
    if (!this.deps.store.resolvePermission(id, outcome)) return "already_resolved";
    this.resolved.add(id);
    this.deps.bus.publish({ kind: "permission.resolved", requestId: id, taskId: stored.taskId, outcome });
    this.changed(stored.taskId);
    return "ok";
  }

  pending(taskId?: string): PermissionRequestView[] {
    return this.deps.store.listPendingPermissions(taskId);
  }

  withdrawAll(taskId: string): void {
    for (const [id, w] of [...this.waiters]) {
      if (w.taskId === taskId) this.settle(id, "withdrawn", WITHDRAWN);
    }
  }

  private settle(id: string, outcome: Outcome, decision: PermissionDecision): boolean {
    const waiter = this.waiters.get(id);
    if (!waiter) return false;
    this.waiters.delete(id);
    this.resolved.add(id);
    waiter.cleanup();
    try {
      this.deps.store.resolvePermission(id, outcome);
      this.deps.bus.publish({ kind: "permission.resolved", requestId: id, taskId: waiter.taskId, outcome });
      this.changed(waiter.taskId);
    } finally {
      // A throwing subscriber or onPendingChange must not leave the agent waiting forever.
      // The error still propagates to the caller after the promise is settled.
      waiter.resolve(decision);
    }
    return true;
  }

  private changed(taskId: string): void {
    this.deps.onPendingChange(taskId, this.pending(taskId).length);
  }
}
