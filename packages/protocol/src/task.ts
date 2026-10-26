import { z } from "zod";

export const AgentId = z.enum(["claude-code", "codex", "gemini", "aider"]);
export type AgentId = z.infer<typeof AgentId>;

/** Task lifecycle, see PRD §5. `interrupted` = daemon restarted mid-run (PRD §8); `cancelled` = user stopped it. */
export const TaskStatus = z.enum([
  "queued",
  "setting_up",
  "running",
  "needs_input",
  "review",
  "merged",
  "failed",
  "interrupted",
  "cancelled",
  "cleaned_up",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * Statuses as clients read them. A status added in a newer daemon parses as "unknown"
 * instead of failing the whole response, so older phones keep working (PRD §8).
 */
export const ReadTaskStatus = z.union([TaskStatus, z.literal("unknown")]).catch("unknown");
export type ReadTaskStatus = z.infer<typeof ReadTaskStatus>;

/** POSIX absolute path or Windows drive path. Relative paths would resolve against the daemon's cwd. */
export const AbsolutePath = z
  .string()
  .refine((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p), { message: "must be an absolute path" });

export const Task = z.object({
  id: z.string(),
  repoPath: z.string(),
  title: z.string(),
  prompt: z.string(),
  agent: AgentId.or(z.string()),
  status: ReadTaskStatus,
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  sessionId: z.string().nullable(),
  costUsd: z.number(),
  createdAt: z.string(),
});
export type Task = z.infer<typeof Task>;

export const CreateTaskInput = z.object({
  repoPath: AbsolutePath,
  prompt: z.string().min(1),
  title: z.string().optional(),
  agent: AgentId.default("claude-code"),
});
export type CreateTaskInput = z.input<typeof CreateTaskInput>;
