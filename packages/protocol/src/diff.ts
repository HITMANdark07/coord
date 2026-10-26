import { z } from "zod";

export const DiffView = z.object({
  baseRef: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.enum(["added", "modified", "deleted", "renamed"]),
      additions: z.number(),
      deletions: z.number(),
    }),
  ),
  patch: z.string(),
  /** True when the patch was cut to keep the response small. */
  truncated: z.boolean(),
});
export type DiffView = z.infer<typeof DiffView>;
