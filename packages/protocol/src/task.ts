import { z } from "zod";

export const AgentId = z.enum(["claude-code", "codex", "gemini", "aider"]);
export type AgentId = z.infer<typeof AgentId>;

/**
 * Task lifecycle, see PRD §5. `interrupted` = daemon restarted mid-run (PRD §8); `cancelled` = user
 * stopped it. `checking`, `pr_open` and `closed` come with checks and pull requests (plan 3).
 */
export const TaskStatus = z.enum([
  "queued",
  "setting_up",
  "running",
  "needs_input",
  "review",
  "checking",
  "pr_open",
  "merged",
  "closed",
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

/** How an agent's tool calls are approved. `bypass` only works for repos with `bypassAllowed`. */
export const PermissionMode = z.enum(["ask", "accept_edits", "bypass"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

// Fields added after 0.1.0 all have defaults so a client reading an older daemon still parses.
export const Task = z.object({
  id: z.string(),
  repoId: z.string().default(""),
  repoPath: z.string(),
  title: z.string(),
  prompt: z.string(),
  agent: AgentId.or(z.string()),
  status: ReadTaskStatus,
  branch: z.string().nullable(),
  baseBranch: z.string().nullable().default(null),
  worktreePath: z.string().nullable(),
  sessionId: z.string().nullable(),
  model: z.string().nullable().default(null),
  permissionMode: PermissionMode.default("ask").catch("ask"),
  costUsd: z.number(),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  turns: z.number().default(0),
  error: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string().default(""),
});
export type Task = z.infer<typeof Task>;

export const CreateTaskInput = z
  .object({
    repoId: z.string().optional(),
    repoPath: AbsolutePath.optional(),
    prompt: z.string().min(1),
    title: z.string().optional(),
    agent: AgentId.default("claude-code"),
    model: z.string().optional(),
    // Coord only touches branches under agent/, so it never rewrites the user's own branches.
    branch: z
      .string()
      .regex(/^agent\/[a-z0-9][a-z0-9._/-]*$/)
      .optional(),
    // A leading "-" would reach git as an option (`--upload-pack=<cmd>` runs a command); the
    // daemon checks the rest with `git check-ref-format --branch`.
    baseBranch: z
      .string()
      .refine((b) => !b.startsWith("-"), { message: "must not start with -" })
      .optional(),
    permissionMode: PermissionMode.default("ask"),
  })
  .refine((v) => v.repoId !== undefined || v.repoPath !== undefined, {
    message: "repoId or repoPath is required",
    path: ["repoId"],
  });
export type CreateTaskInput = z.input<typeof CreateTaskInput>;

export const MessageInput = z.object({ text: z.string().min(1) });
export type MessageInput = z.infer<typeof MessageInput>;
