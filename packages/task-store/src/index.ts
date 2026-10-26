// Public API of @coord/task-store. Export only what other packages need.
export { openStore, Store, StoreConflictError } from "./store";
export type { NewRepo, NewTask, PermissionOutcome, TaskRecord } from "./store";
