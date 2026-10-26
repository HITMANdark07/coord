// Public API of @coord/worktree-manager. Export only what other packages need.
export { GitError } from "./git";
export {
  ConfigError,
  isNotARepoError,
  localBaseRef,
  readRepoConfig,
  readRepoInfo,
  resolveBaseRef,
} from "./repo";
export { slugify } from "./slug";
export {
  branchTip,
  copyEnvFiles,
  createWorktree,
  deleteBranch,
  forgetWorktree,
  removeEnvCopies,
  removeWorktree,
  uniqueBranch,
} from "./worktree";
export { detectSetupCommands, runCommands } from "./commands";
export type { RunResult } from "./commands";
export { CommitError, commitTurn, hasChanges } from "./commit";
export { diffAgainstBase } from "./diff";
