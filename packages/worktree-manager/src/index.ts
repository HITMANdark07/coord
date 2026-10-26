// Public API of @coord/worktree-manager. Export only what other packages need.
export { GitError } from "./git";
export { ConfigError, detectSetupCommands, readRepoConfig, readRepoInfo, resolveBaseRef } from "./repo";
export { slugify } from "./slug";
export {
  copyEnvFiles,
  createWorktree,
  deleteBranch,
  removeWorktree,
  runCommands,
  uniqueBranch,
} from "./worktree";
export type { RunResult } from "./worktree";
export { CommitError, commitTurn, hasChanges } from "./commit";
export { diffAgainstBase } from "./diff";
