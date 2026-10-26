/** Append-only: each entry runs once, in order; `PRAGMA user_version` records how many have run. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE repos (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    default_branch TEXT NOT NULL,
    remote_url TEXT,
    bypass_allowed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    agent TEXT NOT NULL,
    status TEXT NOT NULL,
    branch TEXT,
    base_branch TEXT,
    worktree_path TEXT,
    session_id TEXT,
    model TEXT,
    permission_mode TEXT NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    turns INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    port_base INTEGER,
    pending_message TEXT,
    discarded_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_repo ON tasks (repo_id);
  CREATE INDEX tasks_status ON tasks (status);

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    task_id TEXT,
    payload TEXT NOT NULL
  );
  CREATE INDEX events_task ON events (task_id, seq);

  CREATE TABLE permissions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    tool_use_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    input TEXT NOT NULL,
    title TEXT,
    can_remember INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    outcome TEXT,
    resolved_at TEXT
  );
  CREATE INDEX permissions_task ON permissions (task_id);
  `,
  // discarded_tip: the branch tip at discard, so the sweep never deletes work added after it.
  // env_files: JSON list of the env files copied into the worktree, never committed (spec §6).
  `
  ALTER TABLE tasks ADD COLUMN discarded_tip TEXT;
  ALTER TABLE tasks ADD COLUMN env_files TEXT NOT NULL DEFAULT '[]';
  `,
];
