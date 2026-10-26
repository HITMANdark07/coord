import { z } from "zod";
import { AbsolutePath } from "./task";

export const Repo = z.object({
  id: z.string(),
  name: z.string(),
  path: AbsolutePath,
  defaultBranch: z.string(),
  remoteUrl: z.string().nullable(),
  bypassAllowed: z.boolean().default(false),
  createdAt: z.string(),
});
export type Repo = z.infer<typeof Repo>;

export const AddRepoInput = z.object({ path: AbsolutePath });
export type AddRepoInput = z.infer<typeof AddRepoInput>;

/** The repo's `.coord/config.json`. Every field is optional so an empty file is valid. */
export const RepoConfig = z.object({
  baseBranch: z.string().optional(),
  envFiles: z.array(z.string()).default([]),
  /** Undefined means detect the package manager. */
  setup: z.array(z.string()).optional(),
  checks: z.record(z.string(), z.string()).optional(),
  neatcode: z.boolean().optional(),
  ports: z
    .object({ start: z.number().int().default(41000), blockSize: z.number().int().default(10) })
    .default({
      start: 41000,
      blockSize: 10,
    }),
});
export type RepoConfig = z.infer<typeof RepoConfig>;
