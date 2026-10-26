import { z } from "zod";
import { Task } from "./task";

/** Agent-neutral events every adapter emits, see PRD §7.3. */
export const AgentEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"), sessionId: z.string() }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool_call"), toolUseId: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool_result"), toolUseId: z.string(), ok: z.boolean() }),
  z.object({
    type: z.literal("permission_request"),
    requestId: z.string(),
    toolUseId: z.string(),
    tool: z.string(),
    input: z.unknown(),
    title: z.string().optional(),
    canRemember: z.boolean(),
  }),
  z.object({
    type: z.literal("usage"),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number().optional(),
  }),
  /** The current turn finished; the session may continue with more messages. */
  z.object({ type: z.literal("done"), summary: z.string().optional() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

/** What the daemon pushes to subscribers (desktop, PWA, phone). */
export const DaemonEventPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task.updated"), task: Task }),
  z.object({ kind: z.literal("agent.event"), taskId: z.string(), event: AgentEvent }),
]);
export type DaemonEventPayload = z.infer<typeof DaemonEventPayload>;

/**
 * Envelope for every pushed event. `seq` increases by one per event, so a client that
 * reconnects (e.g. through the relay) can ask for everything after the last seq it saw.
 */
export const DaemonEvent = z.object({
  seq: z.number().int().nonnegative(),
  at: z.string(),
  payload: DaemonEventPayload,
});
export type DaemonEvent = z.infer<typeof DaemonEvent>;

/** A user's answer to a permission request, sent from desktop or phone (PRD FR-4, FR-34). */
export const PermissionDecision = z.discriminatedUnion("allow", [
  z.object({
    allow: z.literal(true),
    /** Changed tool input, e.g. the user's answers to an agent question. */
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    /** "Always allow": apply the agent's suggested permission rules for the rest of the session. */
    remember: z.boolean().optional(),
  }),
  z.object({ allow: z.literal(false), reason: z.string().optional() }),
]);
export type PermissionDecision = z.infer<typeof PermissionDecision>;
