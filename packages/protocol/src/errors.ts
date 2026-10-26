import { z } from "zod";

/** Machine-readable error codes, shared by HTTP responses, IPC replies and relay frames. */
export const ErrorCode = z.enum([
  "invalid_request",
  "not_found",
  "unauthorized",
  "protocol_mismatch",
  "forbidden",
  "unavailable",
  "internal",
  /** The action isn't allowed in the task's current status (HTTP 409). */
  "conflict",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** The body of every error the daemon returns. */
export const ErrorBody = z.object({
  code: ErrorCode,
  message: z.string(),
  issues: z.array(z.unknown()).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;
