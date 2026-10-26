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

/** Repo settings changed from the desktop app. */
export const UpdateRepoInput = z.object({ bypassAllowed: z.boolean() });
export type UpdateRepoInput = z.infer<typeof UpdateRepoInput>;

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

/** The config a new task in this repo would start with, read from its base branch (spec §7). */
export const RepoConfigView = z.object({
  baseBranch: z.string(),
  config: RepoConfig,
  /** `config.setup`, or the commands detected from the package manager when it has none. */
  setup: z.array(z.string()),
  setupSource: z.enum(["config", "detected"]),
});
export type RepoConfigView = z.infer<typeof RepoConfigView>;
