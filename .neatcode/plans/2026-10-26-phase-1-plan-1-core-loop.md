# Coord Phase 1, Plan 1: Core Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task created from the CLI runs Claude Code in its own git worktree. You can watch it, answer its permission prompts, send follow-ups, interrupt it and diff it. Every turn is auto-committed, and the task survives a daemon restart. Everything is persisted in SQLite.

**Architecture:**

- Two new daemon-internal service packages:
  - `@coord/task-store` (SQLite);
  - `@coord/worktree-manager` (git and setup commands).
- `packages/core` gains:
  - a `TaskRunner` (state machine, queue, concurrency) and a `PermissionBroker`;
  - a persisted event bus and a daemon lock;
  - routes for repos, tasks and permissions.
- The client and CLI get the matching commands.
- The Claude Code adapter gains run options (model, permission mode, env), user-interrupt-as-turn-end, session-scoped "always allow", `modelUsage` cost, and subagent nesting.

**Tech Stack:** TypeScript 6, Node 24, Fastify 5, zod 4, better-sqlite3 11.10.0, git CLI via `node:child_process`, Vitest 5, commander 15, `@anthropic-ai/claude-agent-sdk` 0.3.310.

**Spec:** [docs/superpowers/specs/2026-10-26-phase-1-design.md](../../docs/superpowers/specs/2026-10-26-phase-1-design.md). Read §5, §6, §7, §9 and §10 before starting. AGENTS.md rules apply to every task.

## Global Constraints

- **Definition of done per task:** `pnpm check` is green (lint, typecheck, test, build, format, neatcode). Commit after each task with a `Co-Authored-By` trailer as configured.
- **New packages come only from the generator.** For example: `pnpm exec nx g @coord/workspace-plugin:library task-store --type=service --platform=node`. Do the same for `worktree-manager`.
- **Dependency pins:** `better-sqlite3` **11.10.0** (exact, shared with neatcode's copy) and `@types/better-sqlite3` **9.6.0** (exact).
- **Protocol changes are additive** (AGENTS.md rule 2). `PROTOCOL_VERSION` stays `0.1.0`. New fields on `Task` get `.default(...)`, so a client reading an older daemon still parses.
- **Paths:**
  - database: `<COORD_HOME>/coord.db` (WAL mode);
  - lock: `<COORD_HOME>/daemon.lock`;
  - worktrees: `<COORD_HOME>/worktrees/<repo-name>-<repo-id>/<task-slug>`.

  `COORD_HOME` defaults to `~/.coord` (`coordHome()` in `@coord/local-daemon`).

- **Branches:** `agent/<slug>`. Coord only creates, commits to or deletes branches with the `agent/` prefix that it created. It never force-pushes, and never runs a command with the user's main checkout as its working directory, other than `git worktree add/remove` and read-only queries.
- **Auto-commit, per turn:**
  - message `<task title> (turn <N>)`;
  - trailers `Coord-Task: <task id>` and either `Co-Authored-By: Claude Code <noreply@anthropic.com>` or `Co-Authored-By: Codex <noreply@openai.com>`;
  - `git commit --no-verify`, with the user's own identity and signing config;
  - no commit when there are no changes.
- **Concurrency:** at most **3** tasks in `setting_up`/`running`/`needs_input` (env `COORD_MAX_CONCURRENT`).
- **Ports:** each task gets a block of **10** ports starting at **41000**, unless `.coord/config.json` sets `ports`. The block's first port goes to the agent as env `COORD_PORT_BASE`, along with `COORD_TASK_ID`.
- **Discarded task branches** are kept **14 days**, then deleted.
- **Permission modes:** `ask` (default), `accept_edits`, `bypass`. `bypass` is accepted only for repos with `bypassAllowed = true`. Plan 1 has no way to set that flag; the desktop setting comes in plan 2. The CLI and MCP never offer `bypass`.

## Review Focus

1. **Dirty main checkout.** The user's own checkout has uncommitted changes when a task starts. The worktree is created from the base ref, and the user's checkout is unchanged before and after the task (Task 4, Task 7).
2. **Repo without a remote.** Fetching is skipped, the base ref is the local branch, and the task runs normally (Task 4).
3. **Same prompt twice.** Two tasks with the same title get different branches and worktrees (`agent/x`, `agent/x-2`) (Task 4, Task 7).
4. **Daemon killed mid-turn with uncommitted edits.** On restart the task is `interrupted`, its edits are still in the worktree, and resuming then ending the turn commits them (Task 8).
5. **Resume with no session id** (the agent crashed before reporting one). Resume starts a fresh session with the original prompt plus the follow-up text instead of failing (Task 8).

---

### Task 1: Protocol additions

**Files:**

- Modify: `packages/protocol/src/task.ts`, `packages/protocol/src/events.ts`, `packages/protocol/src/adapter.ts`, `packages/protocol/src/errors.ts`
- Create: `packages/protocol/src/repo.ts`, `packages/protocol/src/diff.ts`
- Modify: `packages/protocol/src/index.ts` (export the new modules)
- Test: `packages/protocol/src/protocol.test.ts`

**Interfaces (Produces):**

- `PermissionMode = z.enum(["ask", "accept_edits", "bypass"])`
- `Repo = z.object({ id: string, name: string, path: AbsolutePath, defaultBranch: string, remoteUrl: string | null, bypassAllowed: boolean (default false), createdAt: string })`, and `AddRepoInput = z.object({ path: AbsolutePath })`.
- `RepoConfig`, with every field optional on input:

  ```ts
  {
    baseBranch?: string;
    envFiles: string[];            // default []
    setup?: string[];              // undefined = detect the package manager
    checks?: Record<string, string>;
    neatcode?: boolean;
    ports: { start: number; blockSize: number }; // defaults 41000, 10
  }
  ```

- `Task` gains these fields, each with a default:
  - `repoId: string` (`""`), `baseBranch: string | null`, `model: string | null`, `permissionMode` (`"ask"`, with `.catch("ask")`);
  - `inputTokens: number`, `outputTokens: number`, `turns: number` (all `0`);
  - `error: string | null`, `updatedAt: string`.

  Keep every existing field.

- `CreateTaskInput`:

  ```ts
  {
    repoId?: string;
    repoPath?: AbsolutePath;
    prompt: string;
    title?: string;
    agent: AgentId;                 // default "claude-code"
    model?: string;
    branch?: string;                // must match /^agent\/[a-z0-9][a-z0-9._\/-]*$/
    baseBranch?: string;
    permissionMode: PermissionMode; // default "ask"
  }
  ```

  A `.refine` requires `repoId` or `repoPath`.

- `MessageInput = z.object({ text: z.string().min(1) })`
- `PermissionRequestView = z.object({ id, taskId, toolUseId, tool, input: unknown, title?: string, canRemember: boolean, createdAt })`
- `DaemonEventPayload` gains:
  - `{ kind: "permission.requested", request: PermissionRequestView }`;
  - `{ kind: "permission.resolved", requestId: string, taskId: string, outcome: "allowed" | "always" | "denied" | "withdrawn" }`;
  - `{ kind: "repo.updated", repo: Repo }`.
- `AgentEvent`:
  - the `text` and `tool_call` variants gain `parentToolUseId?: string`;
  - the doc comment on `usage` states the token and cost numbers are **running totals for the session**.
- `DiffView = z.object({ baseRef: string, files: z.array(z.object({ path, status: z.enum(["added", "modified", "deleted", "renamed"]), additions: number, deletions: number })), patch: string, truncated: boolean })`
- `ErrorCode` gains `"conflict"` (an action that isn't allowed in the task's current status; HTTP 409).
- In `adapter.ts`:
  - `RunOptions = { model?: string; permissionMode?: PermissionMode; env?: Record<string, string> }`;
  - `TaskSpec extends RunOptions` (keeps `taskId` and `prompt`);
  - the signature becomes `resume(sessionId: string, message: string, ctx: RunContext, options?: RunOptions): AgentRun`.

- [ ] **Step 1: Write failing tests** in `protocol.test.ts`:
  - `"CreateTaskInput requires repoId or repoPath"`: parsing `{ prompt: "x" }` throws, while `{ repoId: "r1", prompt: "x" }` parses with `agent: "claude-code"` and `permissionMode: "ask"`.
  - `"rejects branch names outside agent/"`: `branch: "main"` throws, and `"agent/fix-login"` parses.
  - `"RepoConfig fills defaults"`: `RepoConfig.parse({})` deep-equals `{ envFiles: [], ports: { start: 41000, blockSize: 10 } }`.
  - `"Task from an older daemon still parses"`: the existing fixture task (without the new fields) parses, with `turns === 0` and `permissionMode === "ask"`.
  - `"permission events round-trip"`: a `permission.requested` envelope parses through `DaemonEvent`.
- [ ] **Step 2:** Run `pnpm exec nx test @coord/protocol`. Expected: the 5 new tests FAIL.
- [ ] **Step 3:** Implement the schemas and types above. Update the `AgentAdapter` docs so `resume` mentions `options`.
- [ ] **Step 4:** Run `pnpm exec nx run-many -t typecheck test -p @coord/protocol @coord/client @coord/ui-web @coord/app-state`. Expected: PASS. Existing fixtures parse thanks to the defaults.
- [ ] **Step 5:** Commit `feat(protocol): repos, run options, permission events, diff view`.

### Task 2: Claude Code adapter: run options, interrupts, session-scoped "always allow", accurate cost, subagent nesting

**Files:**

- Modify: `packages/adapter-claude-code/src/adapter.ts`, `packages/adapter-claude-code/src/events.ts`
- Test: `packages/adapter-claude-code/src/adapter.test.ts`

**Interfaces:**

- Consumes: `RunOptions`, `PermissionMode` (Task 1).
- Produces:
  - `buildOptions(extra: RunOptions & { resume?: string }, ctx: RunContext, abortController: AbortController): Options` maps:
    - `permissionMode`: `ask→"default"`, `accept_edits→"acceptEdits"`, `bypass→"bypassPermissions"`;
    - `env`: `{ ...process.env, ...extra.env }`.

    `cwd`, `settingSources`, `canUseTool` and `abortController` must still win over anything in `extra`.

  - `toAgentEvents(msg: SDKMessage, state: { interrupted: boolean }): AgentEvent[]`:
    - `usage` comes from the result's `modelUsage`, summed across models: `inputTokens + cacheReadInputTokens + cacheCreationInputTokens`, `outputTokens`, `costUSD`;
    - when `state.interrupted` is set, a non-success result maps to `{ type: "done", summary: "Interrupted by user" }` instead of `error`;
    - assistant messages with a `parent_tool_use_id` set `parentToolUseId` on their `text`/`tool_call` events.
  - `permissionBridge`: on "remember", sends the suggestions with **every `destination` replaced by `"session"`**.

- [ ] **Step 1: Write failing tests:**
  - `"maps permission modes"`: `buildOptions({ permissionMode: "accept_edits" }, …)` has `permissionMode === "acceptEdits"`.
  - `"passes task env through"`: `buildOptions({ env: { COORD_PORT_BASE: "41000" } }, …).env.COORD_PORT_BASE === "41000"`.
  - `"a user interrupt ends the turn instead of failing it"`: call `run.interrupt()`, then the fake yields an `error_during_execution` result, and the last event is `{ type: "done", summary: "Interrupted by user" }`.
  - `"remember stays in the session"`: given suggestions with `destination: "projectSettings"`, the bridge result has `updatedPermissions[0].destination === "session"`.
  - `"cost comes from modelUsage including cache tokens"`: a result with `modelUsage: { a: { inputTokens: 10, cacheReadInputTokens: 5, cacheCreationInputTokens: 1, outputTokens: 3, costUSD: 0.5 }, b: { inputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 1, costUSD: 0.25 } }` gives `{ type: "usage", inputTokens: 17, outputTokens: 4, costUsd: 0.75 }`.
  - `"subagent output is nested"`: an assistant message with `parent_tool_use_id: "tu-1"` gives a text event with `parentToolUseId: "tu-1"`.
- [ ] **Step 2:** Run `pnpm exec nx test @coord/adapter-claude-code`. Expected: the 6 new tests FAIL.
- [ ] **Step 3:** Implement. `run()` keeps `const state = { interrupted: false }`; `interrupt()` sets it before calling `session.interrupt()`. `resume(sessionId, message, ctx, options)` passes `options` together with `resume: sessionId`.
- [ ] **Step 4:** Run the adapter tests. Expected: PASS, including all 13 existing tests.
- [ ] **Step 5:** Commit `feat(adapter-claude-code): run options, interrupt as turn end, session-scoped allow, modelUsage cost`.

### Task 3: `@coord/task-store` (SQLite)

**Files:**

- Generate: `packages/task-store` (type `service`, platform `node`), then add `better-sqlite3@11.10.0`, `@types/better-sqlite3@9.6.0` (dev) and `@coord/protocol`.
- Create: `src/store.ts` (Store class), `src/migrations.ts`, `src/index.ts`
- Test: `src/store.test.ts`

**Interfaces (Produces):**

- `openStore(file: string): Store` creates parent directories, enables WAL and `foreign_keys`, and runs the migrations. `":memory:"` is allowed in tests.
- `type NewRepo = Omit<Repo, "id" | "createdAt" | "bypassAllowed">`
- `type TaskRecord = Task & { portBase: number | null; pendingMessage: string | null; discardedAt: string | null }`
- `Store` methods:
  - **Repos:** `addRepo(r: NewRepo): Repo` (throws `StoreConflictError` if the path is already registered), `getRepo(id)`, `findRepoByPath(path)`, `listRepos()`, `setRepoBypass(id, allowed: boolean): Repo`.
  - **Tasks:** `insertTask(t: Omit<TaskRecord, "id" | "createdAt" | "updatedAt">): TaskRecord`, `getTask(id): TaskRecord | undefined`, `listTasks(filter?: { repoId?: string; statuses?: TaskStatus[] }): TaskRecord[]` (newest first), `updateTask(id, patch: Partial<TaskRecord>): TaskRecord` (sets `updatedAt`).
  - **Events:** `saveEvent(e: DaemonEvent): void`, `maxSeq(): number`, `listEvents(opts: { taskId?: string; sinceSeq?: number; limit?: number }): DaemonEvent[]`. An event's `taskId` comes from `payload.taskId` or `payload.task.id` and is stored in its own column for filtering.
  - **Permissions:** `savePermission(p: PermissionRequestView): void`, `resolvePermission(id, outcome): boolean` (false if it was already resolved), `listPendingPermissions(taskId?)`.
  - **Ports:** `allocatePortBase(taskId, start: number, blockSize: number): number` returns the lowest block start not held by a task whose status is outside `cancelled`/`cleaned_up`/`merged`/`closed`.
  - **Misc:** `close()`.
- `StoreConflictError extends Error`.

- [ ] **Step 1: Write failing tests** (temp file per test, from `mkdtemp`):
  - `"persists across reopen"`: add a repo and a task, close, reopen, and both are still there.
  - `"migrations are versioned"`: reopening an up-to-date file runs no migration (`user_version` is unchanged).
  - `"rejects a repo path registered twice"`: throws `StoreConflictError`.
  - `"updateTask bumps updatedAt and keeps other fields"`.
  - `"events filter by task and seq"`: save 3 events for two tasks; `listEvents({ taskId: "a", sinceSeq: 1 })` returns only `a`'s later events, ordered by `seq`; `maxSeq() === 3`.
  - `"pending permissions resolve once"`: `resolvePermission` returns true then false.
  - `"port blocks don't overlap live tasks and are reused after cancel"`: two live tasks get 41000 and 41010; after the first is cancelled, a new task gets 41000.
- [ ] **Step 2:** Run `pnpm exec nx test @coord/task-store`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement with prepared statements. Store `Task` JSON-free (one column per field), and event payloads as a JSON text column.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then run `pnpm exec nx lint @coord/task-store`, which proves the `type:service` tag and boundaries hold.
- [ ] **Step 5:** Commit `feat(task-store): SQLite persistence for repos, tasks, events, permissions`.

### Task 4: `@coord/worktree-manager` (git, setup, diff)

**Files:**

- Generate: `packages/worktree-manager` (type `service`, platform `node`), then add `@coord/protocol`.
- Create: `src/git.ts` (exec helper + `GitError`), `src/repo.ts`, `src/worktree.ts`, `src/commit.ts`, `src/diff.ts`, `src/commands.ts`, `src/slug.ts`, `src/index.ts`
- Test: `src/worktree.test.ts`, `src/commit.test.ts`, `src/diff.test.ts`, `src/slug.test.ts`. A test helper `src/testing.ts` creates a temp repo with a commit on `main` and an optional bare `origin`. Export it as `"./testing"` in `package.json`, like `@coord/client/testing`, for core's runner tests:
  - `makeTempRepo(opts?: { withOrigin?: boolean }): Promise<{ path: string; origin?: string; env: Record<string, string> }>`, where `env` carries a fixed git identity for test commits.

**Interfaces (Produces):** all functions are async unless marked otherwise, and every git call goes through `execFile("git", args, { cwd })`.

- **Errors:** `class GitError extends Error { command: string; stderr: string; exitCode: number }`.
- **Repo:** `readRepoInfo(path): { name, defaultBranch, remoteUrl: string | null }`. Throws `GitError` if `path` isn't a git repo. `defaultBranch` comes from `origin/HEAD`, else the current branch.
- **Base ref:** `resolveBaseRef(repoPath, base): { ref: string; fetched: boolean }`. If an `origin` remote exists, it runs `git fetch origin <base>` and returns `origin/<base>`. Otherwise it returns `<base>` with `fetched: false`.
- **Config:** `readRepoConfig(repoPath, ref): RepoConfig` reads `git show <ref>:.coord/config.json`. A missing file gives `RepoConfig.parse({})`. Invalid JSON or schema throws `ConfigError` with the reason.
- **Setup detection:** `detectSetupCommands(worktreePath): string[]`:
  - `pnpm-lock.yaml` gives `["pnpm install --frozen-lockfile"]`;
  - `package-lock.json` gives `["npm ci"]`;
  - `yarn.lock` gives `["yarn install --frozen-lockfile"]`;
  - `bun.lock`/`bun.lockb` gives `["bun install"]`;
  - otherwise `[]`.
- **Branch naming:**
  - `slugify(text): string` (sync): lowercase, `[a-z0-9-]`, at most 40 characters, never empty (fallback `"task"`);
  - `uniqueBranch(repoPath, desired): string` returns `desired` or `desired-2`, `-3`, … so that no local or `origin` branch exists with that name.
- **Worktrees:**
  - `createWorktree({ repoPath, worktreePath, branch, baseRef })` runs `git worktree add -b <branch> <worktreePath> <baseRef>`;
  - `copyEnvFiles(repoPath, worktreePath, files: string[]): string[]` returns the files copied and skips missing ones;
  - `runCommands(commands, { cwd, env, signal? }): { ok: true } | { ok: false; command; exitCode; output }` runs each command with `sh -c` and stops at the first failure. Output is capped at 64 KB.
- **Commits:**
  - `hasChanges(cwd): boolean` (working tree or index, untracked files included);
  - `commitTurn({ cwd, message, trailers: string[] }): { committed: false } | { committed: true; sha: string }` runs `git add -A`, then, only if there are changes, `git commit --no-verify -F -`, with the trailers added after a blank line. Throws `CommitError extends GitError` when the commit fails.
- **Diff:** `diffAgainstBase({ cwd, baseRef }): DiffView` diffs the merge-base of `baseRef` and HEAD against the **working tree**, so uncommitted edits show live. `--numstat` gives the counts, `--name-status` the statuses, and the patch is capped at 1 MB (`truncated: true` beyond that).
- **Cleanup:**
  - `removeWorktree(repoPath, worktreePath)` runs `git worktree remove` **without** `--force`, and throws `GitError` if the worktree has changes;
  - `deleteBranch(repoPath, branch)` refuses (throws) unless `branch.startsWith("agent/")`, then runs `git branch -D`.

- [ ] **Step 1: Write failing tests:**
  - `"creates a worktree from origin/main without touching the main checkout"`: make the main checkout dirty (one modified file, one untracked file), create the worktree, and confirm the main checkout's `git status --porcelain` is identical before and after. **[Review Focus 1]**
  - `"works without a remote"`: `resolveBaseRef(repo, "main")` gives `{ ref: "main", fetched: false }`, and `createWorktree` succeeds. **[Review Focus 2]**
  - `"unique branch names"`: with `agent/fix` existing, `uniqueBranch` gives `agent/fix-2`, then `agent/fix-3`. **[Review Focus 3]**
  - `"reads config from the base ref, not the working tree"`: commit `{ "checks": { "t": "true" } }` on `main`, write a different config in the worktree, and `readRepoConfig(repo, "main")` returns the committed one.
  - `"invalid config is a ConfigError"`.
  - `"detects pnpm"`, and `"copies only existing env files"`.
  - `"runCommands stops at the first failure with output"`: `["true", "echo boom; exit 3", "touch never"]` gives `exitCode: 3`, output containing `boom`, and no `never` file.
  - `"commitTurn commits with trailers and skips hooks"`: install a `pre-commit` hook that `exit 1`s; the commit succeeds, and `git log -1 --format=%B` contains `Coord-Task: t1` and `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
  - `"commitTurn is a no-op without changes"`, and `"commit failure raises CommitError"` (e.g. `user.email` unset in an isolated `HOME` and `GIT_CONFIG_GLOBAL`).
  - `"diff includes committed and uncommitted changes against the merge base"`.
  - `"removeWorktree refuses a dirty worktree"`, and `"deleteBranch refuses non-agent branches"`.
  - `"slugify"`: `"Fix the Login redirect!!"` gives `"fix-the-login-redirect"`, and `""` gives `"task"`.
- [ ] **Step 2:** Run `pnpm exec nx test @coord/worktree-manager`. Expected: FAIL.
- [ ] **Step 3:** Implement. Tests set `GIT_AUTHOR_*`/`GIT_COMMITTER_*` through `env`; production uses the user's config.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(worktree-manager): worktrees, setup commands, per-turn commits, diffs`.

### Task 5: Daemon lock and persisted event bus

**Files:**

- Create: `packages/core/src/daemon-lock.ts`
- Modify: `packages/core/src/event-bus.ts`
- Test: `packages/core/src/daemon-lock.test.ts`, `packages/core/src/event-bus.test.ts`
- Add a dependency on `@coord/task-store` to core.

**Interfaces (Produces):**

- `acquireDaemonLock(home: string, info: { pid: number; port: number }): Promise<{ release(): Promise<void> }>`:
  - creates `<home>/daemon.lock` with `wx`;
  - if the file exists and its PID is alive (`process.kill(pid, 0)`), throws `DaemonLockedError` (message includes the PID and port, and says to set a different `COORD_HOME`);
  - if the PID is dead, it replaces the lock.
- `new EventBus({ startSeq?: number; persist?: (e: DaemonEvent) => void })`. `publish` persists **before** notifying listeners.

- [ ] **Step 1: Write failing tests:**
  - `"second lock on the same home fails while the first holder lives"`;
  - `"stale lock from a dead pid is replaced"` (write a lock with PID 999999);
  - `"release removes the lock"`;
  - `"bus continues seq after restart"`: `new EventBus({ startSeq: 41 })` publishes `seq: 42`;
  - `"bus persists before notifying"`: a listener sees the event already passed to `persist`.
- [ ] **Step 2:** Run `pnpm exec nx test @coord/core`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): single-daemon lock and persisted event sequence`.

### Task 6: Permission broker

**Files:**

- Create: `packages/core/src/permission-broker.ts`
- Test: `packages/core/src/permission-broker.test.ts`

**Interfaces:**

- Consumes: `Store` (Task 3), `EventBus` (Task 5), `PermissionRequest`/`PermissionDecision`/`PermissionRequestView` (Task 1).
- Produces: `class PermissionBroker`:
  - `constructor(deps: { store: Store; bus: EventBus; onPendingChange: (taskId: string, pending: number) => void })`
  - `request(taskId: string, req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>`:
    - saves a `PermissionRequestView` (id from `randomUUID`) and publishes `permission.requested`;
    - resolves when `answer` is called;
    - on `signal` abort it withdraws the request: publishes `permission.resolved` with `outcome: "withdrawn"` and resolves `{ allow: false, reason: "withdrawn" }`.
  - `answer(id: string, decision: PermissionDecision): "ok" | "not_found" | "already_resolved"`. The outcome is `allowed`, or `always` if `remember` is set, or `denied`.
  - `pending(taskId?: string): PermissionRequestView[]`
  - `withdrawAll(taskId: string): void`

- [ ] **Step 1: Write failing tests:** `"answer resolves the agent's request and publishes resolved"`, `"remember maps to always"`, `"second answer is already_resolved"`, `"abort withdraws and notifies"`, `"onPendingChange reports counts per task"`.
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): permission broker`.

### Task 7: Task runner: create → setup → run → turn end → review

**Files:**

- Create: `packages/core/src/runner/task-runner.ts`, `packages/core/src/runner/errors.ts`, `packages/core/src/runner/testing.ts` (the `fakeAdapter` used by the tests)
- Modify: `packages/core/package.json`, adding dependencies on `@coord/worktree-manager` and `@coord/adapter-claude-code` (the composition root needs it in Task 10).
- Test: `packages/core/src/runner/task-runner.test.ts` (real git via `makeTempRepo` from `@coord/worktree-manager/testing`, plus `openStore(":memory:")`)

**Interfaces:**

- Consumes: Tasks 1–6.
- Produces:
  - `class RunnerError extends Error { code: ErrorCode; status: number }`;
  - `fakeAdapter(script: FakeStep[]): AgentAdapter & { calls: { start: TaskSpec[]; resume: Array<{ sessionId: string; message: string; options?: RunOptions }> } }`, where `FakeStep` is `{ event: AgentEvent } | { permission: PermissionRequest } | { edit: { file: string; content: string } } | { waitForMessage: true }`. `edit` writes into `ctx.cwd`, and `permission` calls `ctx.requestPermission`.
  - `class TaskRunner`:
    - `constructor(deps: { store: Store; bus: EventBus; broker: PermissionBroker; adapters: Partial<Record<AgentId, AgentAdapter>>; home: string; maxConcurrent: number })`
    - `create(input: CreateTaskInput): Promise<TaskRecord>`:
      - resolves the repo by `repoId` or `repoPath` (`RunnerError not_found` with the hint `coord repo add`);
      - rejects an unknown agent (`invalid_request`) and `bypass` on a repo without the opt-in (`forbidden`);
      - title = `input.title ?? first line of prompt` (at most 60 characters);
      - inserts a `queued` task, publishes `task.updated`, and calls `schedule()`.
    - `idle(): Promise<void>` (for tests): resolves when no task is mid-transition.
  - The private `schedule()` starts queued tasks while fewer than `maxConcurrent` are in `setting_up`/`running`/`needs_input`.
  - The private `setup(task)`:
    1. `resolveBaseRef`, then `readRepoConfig(repoPath, ref)`;
    2. `branch = input.branch ?? await uniqueBranch(repo.path, "agent/" + slugify(title))`;
    3. create the worktree at `<home>/worktrees/<name>-<repoId>/<slug>`;
    4. `copyEnvFiles`, then `allocatePortBase`;
    5. `runCommands(config.setup ?? detectSetupCommands(wt))` with the env `COORD_PORT_BASE`/`COORD_TASK_ID`.

    A failure sets status `failed` and `error` to `"setup: <command> exited <code>"`, keeping the output in an `agent.event` text.

  - The private `drive(task, run: AgentRun)` consumes events:
    - `session` stores `sessionId`;
    - `usage` **sets** `inputTokens`/`outputTokens`/`costUsd`, which are running totals;
    - every event is published as `agent.event`;
    - `done` triggers a turn end: `turns + 1`, `commitTurn` (Global Constraints), `run.end()`, status `review`;
    - `error` triggers `commitTurn` (to keep the work), `run.end()`, status `failed`, and `error` set;
    - a `CommitError` sets status `needs_input` with `error = "commit failed: " + stderr` and leaves the worktree untouched.
  - `RunContext.requestPermission` goes through the broker. `onPendingChange` flips the status `running` ⇄ `needs_input`.

- [ ] **Step 1: Write failing tests:**
  - `"happy path: queued → setting_up → running → review with one commit"`: the fake edits `a.txt` then emits `done`. The final status is `review`, `turns === 1`, the branch has one commit whose message is `"<title> (turn 1)"` with the trailers, and the observed `task.updated` statuses are in that order.
  - `"leaves the user's checkout untouched"`: the main checkout's `git status --porcelain` is unchanged after the run. **[Review Focus 1]**
  - `"two tasks with the same title get different branches"`: `agent/<slug>` and `agent/<slug>-2`, in different worktrees. **[Review Focus 3]**
  - `"respects maxConcurrent"`: with `maxConcurrent: 1` and two tasks, the second stays `queued` until the first reaches `review`.
  - `"permission prompt sets needs_input and continues after allow"`.
  - `"setup failure → failed with the command in error"`: `.coord/config.json` on main has `setup: ["exit 7"]`.
  - `"agent error commits the work, then fails"`: an edit followed by an `error` event leaves the file committed, with status `failed`.
  - `"commit failure → needs_input, worktree untouched"`: an isolated git config with no `user.email`; the file is still present and uncommitted.
  - `"usage keeps the latest running totals"`: two usage events (10/2/0.1, then 30/5/0.4) give `inputTokens 30`, `outputTokens 5`, `costUsd 0.4`.
  - `"rejects bypass without opt-in and unknown repos"`.
  - `"passes model, permission mode and port env to the adapter"`: `calls.start[0]` has `model`, `permissionMode`, and `env.COORD_PORT_BASE === "41000"`.
- [ ] **Step 2:** Run `pnpm exec nx test @coord/core`. Expected: FAIL.
- [ ] **Step 3:** Implement the runner. Keep state transitions in one `transition(taskId, status, patch?)` helper that updates the store and publishes `task.updated`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): task runner with worktree setup, permission flow and per-turn commits`.

### Task 8: Task runner: follow-ups, interrupt, cancel/discard, restart recovery

**Files:**

- Modify: `packages/core/src/runner/task-runner.ts`
- Test: `packages/core/src/runner/task-runner.lifecycle.test.ts`

**Interfaces (Produces):** new methods on `TaskRunner`, each returning `Promise<TaskRecord>` and throwing `RunnerError` (`not_found`; `conflict` when the status doesn't allow the action):

- `message(taskId, text)`:
  - if the task is `running`/`needs_input` and the adapter has `liveMessages`: `run.send(text)`;
  - if it's `review`/`failed`/`interrupted`: store `pendingMessage`, set it `queued`, and on start resume the session with `text` (or, with no `sessionId`, start fresh with `prompt + "\n\nFollow-up: " + text`).
- `interrupt(taskId)`: `run.interrupt()`. The adapter emits `done`, so the normal turn end follows.
- `resume(taskId)`: only from `interrupted`/`failed`. Same as `message` with the text `"Continue where you left off."`.
- `cancel(taskId)`:
  - from active states: withdraw permissions, `run.interrupt()` then `run.end()`, `commitTurn`, then the same as `discard`;
  - from `queued`: straight to `cancelled`.
- `discard(taskId)`: from `review`/`failed`/`interrupted`/`needs_input`:
  1. `commitTurn` (keeps any work on the branch);
  2. `removeWorktree`;
  3. status `cancelled`, `discardedAt = now`, keeping the branch.
- `recoverOnStart(): Promise<number>`: tasks in `setting_up`/`running`/`needs_input` become `interrupted`, their pending permissions are resolved as `withdrawn`, and `queued` tasks are scheduled. Returns the count.
- `sweepDiscardedBranches(now = new Date()): Promise<number>`: deletes `agent/` branches of tasks where `discardedAt` is more than 14 days before `now`, then sets status `cleaned_up`.

- [ ] **Step 1: Write failing tests:**
  - `"message during a running turn is sent live"`;
  - `"message in review resumes the session"`: `calls.resume[0]` is `{ sessionId: "s-1", message: "also add tests" }`, a second commit appears with `"(turn 2)"`, and the status returns to `review`;
  - `"interrupt ends the turn as review, not failed"`;
  - `"restart: running task with uncommitted edits becomes interrupted and keeps them; resume commits them"`: start a runner, let the fake edit then `waitForMessage`, drop the runner without cleanup, build a new runner on the same store and home, and run `recoverOnStart() === 1`. Then the status is `interrupted`, the file is still in the worktree and uncommitted, and after `resume` the turn's commit includes the file. **[Review Focus 4]**
  - `"resume without a session id starts fresh with the original prompt"`: `calls.start[1].prompt` contains the original prompt and `"Follow-up:"`. **[Review Focus 5]**
  - `"discard keeps the work on the branch and removes the worktree"`;
  - `"cancel from running stops the agent and discards"`;
  - `"sweep deletes branches discarded more than 14 days ago only"`;
  - `"actions in the wrong status are conflicts"`, e.g. `resume` on a `review` task throws `RunnerError` with `code: "conflict"`.
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): follow-ups, interrupt, discard and restart recovery`.

### Task 9: Daemon routes and client methods

**Files:**

- Create: `packages/core/src/routes/repos.ts`, `packages/core/src/routes/tasks.ts`, `packages/core/src/routes/permissions.ts`
- Modify: `packages/core/src/server.ts` (register the route plugins and map `RunnerError` to `ErrorBody`), `packages/core/src/index.ts`
- Delete: `packages/core/src/store.ts` (the in-memory store, replaced)
- Modify: `packages/client/src/client.ts`
- Test: `packages/core/src/server.test.ts` (update the existing tests to build a runner over `openStore(":memory:")` with `fakeAdapter`), `packages/core/src/routes/routes.test.ts`, `packages/client/src/client.test.ts`

**Interfaces:**

- `createServer(options: { token: string; allowedOrigins?: string[]; bus: EventBus; store: Store; runner: TaskRunner; broker: PermissionBroker })`. The auth, origin and protocol hooks are unchanged.
- **Routes** (bodies validated with the Task 1 schemas):

  | Method | Path                                                     | Response                                                          |
  | ------ | -------------------------------------------------------- | ----------------------------------------------------------------- |
  | GET    | `/repos`                                                 | `Repo[]`                                                          |
  | POST   | `/repos`                                                 | `{ path }` → reads `readRepoInfo` → 201 `Repo`; 409 if registered |
  | GET    | `/repos/:id`                                             | `Repo`                                                            |
  | GET    | `/tasks?repoId=&all=1`                                   | `Task[]` (without `all`, hides `cancelled`/`cleaned_up`)          |
  | POST   | `/tasks`                                                 | `CreateTaskInput` → 201 `Task`                                    |
  | GET    | `/tasks/:id`                                             | `Task`                                                            |
  | GET    | `/tasks/:id/events?sinceSeq=`                            | `DaemonEvent[]`                                                   |
  | GET    | `/tasks/:id/diff`                                        | `DiffView`                                                        |
  | POST   | `/tasks/:id/messages`                                    | `MessageInput` → `Task`                                           |
  | POST   | `/tasks/:id/interrupt`, `/cancel`, `/discard`, `/resume` | `Task`                                                            |
  | GET    | `/permissions?taskId=`                                   | `PermissionRequestView[]`                                         |
  | POST   | `/permissions/:id`                                       | `PermissionDecision` → 204; 404 unknown; 409 already resolved     |

  Responses never include the `TaskRecord`-only fields.

- **Client:** `listRepos()`, `addRepo(path)`, `listTasks(filter?: { repoId?: string; all?: boolean })`, `createTask(input)`, `getTask(id)`, `taskEvents(id, sinceSeq?)`, `taskDiff(id)`, `sendMessage(id, text)`, `interrupt(id)`, `cancel(id)`, `discard(id)`, `resumeTask(id)`, `listPermissions(taskId?)`, `answerPermission(id, decision)`. Each one validates its response with the Task 1 schema.

- [ ] **Step 1: Write failing tests:**
  - `"repo registration rejects a non-git path with invalid_request"`;
  - `"create → events → permission answer → review over HTTP"`, using `fakeAdapter`, `app.inject` and a real temp repo;
  - `"wrong-status action is 409 conflict"`;
  - `"diff endpoint returns the task's changes"`;
  - client tests via `fakeTransport` asserting each method's path and method, plus response validation.
- [ ] **Step 2:** Run `pnpm exec nx run-many -t test -p @coord/core @coord/client`. Expected: FAIL.
- [ ] **Step 3:** Implement. **Step 4:** Run. Expected: PASS, including the existing auth, origin and WebSocket tests.
- [ ] **Step 5:** Commit `feat: daemon API and client for repos, tasks and permissions`.

### Task 10: Composition, CLI and MCP

**Files:**

- Modify: `packages/core/src/main.ts`, `apps/cli/src/program.ts`, `apps/cli/src/index.ts`, `apps/mcp-server/src/server.ts`, `AGENTS.md`, `README.md`
- Create: `apps/cli/src/resolve-task.ts` (resolves an id prefix)
- Test: `apps/cli/src/program.test.ts`, `apps/mcp-server/src/server.test.ts`

**Interfaces:**

- **`main.ts`** wires everything in this order:
  1. `home = coordHome()` from `@coord/local-daemon`;
  2. `acquireDaemonLock`;
  3. `openStore(join(home, "coord.db"))`;
  4. `EventBus({ startSeq: store.maxSeq(), persist: (e) => store.saveEvent(e) })`;
  5. `PermissionBroker`;
  6. `TaskRunner({ adapters: { "claude-code": createClaudeCodeAdapter() }, maxConcurrent: Number(process.env.COORD_MAX_CONCURRENT ?? 3) })`;
  7. `await runner.recoverOnStart()`;
  8. `sweepDiscardedBranches` at start and then hourly.

  On shutdown, release the lock and close the store.

- **CLI** (task ids accept any unique prefix of at least 4 characters):
  - `coord repo add [path]`, `coord repo ls`;
  - `coord new <prompt> [--repo <path>] [--agent claude-code|codex] [--model <m>] [--branch <b>] [--base <b>] [--permission ask|accept_edits]`;
  - `coord ls [--all]`, `coord show <id>` (status, branch, worktree, tokens/cost, error, last 20 events, pending permissions with their ids);
  - `coord watch <id>` (subscribe and print events until `review`/`failed`/`cancelled`, then exit 0, or 1 on `failed`);
  - `coord allow <permissionId> [--always]`, `coord deny <permissionId> [--reason <text>]`;
  - `coord msg <id> <text>`, `coord interrupt|cancel|discard|resume <id>`, `coord diff <id>` (prints `patch`).
- **MCP:** `create_task` gains `agent` (`claude-code`/`codex`), `model` and `permissionMode` (`ask`/`accept_edits` only). New tools: `send_message`, `get_task_diff`.

- [ ] **Step 1: Write failing tests:**
  - CLI with `fakeTransport`: `"new passes agent, model and permission"`, `"resolves task id prefixes and errors on ambiguity"`, `"allow --always sends remember"`, `"watch exits 0 on review and 1 on failed"`;
  - MCP: `"create_task accepts agent and refuses bypass"` (schema rejects it, and no request is sent).
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement.
- [ ] **Step 4:** Update AGENTS.md:
  - the "Running more than one daemon" paragraph: a second daemon needs both `COORD_PORT` and `COORD_HOME` (lock);
  - the layout table: add `task-store` and `worktree-manager`;
  - the CLI row: the new commands.

  Update the README quick start to: `coord repo add`, then `coord new`, `coord watch`, `coord diff`.

- [ ] **Step 5:** Run `pnpm check`. Expected: exit 0.
- [ ] **Step 6:** Commit `feat: wire runner into the daemon; CLI and MCP task commands`.

### Task 11: Acceptance run with real Claude Code (manual, recorded)

**Files:**

- Create: `.neatcode/plans/2026-10-26-phase-1-plan-1-acceptance.md` (a log of the run)

- [ ] **Step 1:** Make a scratch repo with a remote (a local bare one is fine) and `pnpm daemon`, then run `pnpm coord repo add <scratch>`.
- [ ] **Step 2:** `pnpm coord new "Add a hello() function in hello.ts with a test" --repo <scratch>`, then `pnpm coord watch <id>`. Expected: Claude Code runs in `~/.coord/worktrees/...`, and the task reaches `review`.
- [ ] **Step 3:** Answer one permission prompt with `coord allow <pid>`. Run a second task with `--permission ask` that runs a shell command.
- [ ] **Step 4:** `coord msg <id> "also export it from index.ts"`. Expected: a second commit `(turn 2)`, and `coord diff <id>` shows both.
- [ ] **Step 5:** Start a task, kill the daemon mid-turn (Ctrl-C), restart it, and check `coord show <id>` gives `interrupted`, then `coord resume <id>` reaches `review`.
- [ ] **Step 6:** `coord discard <id>`. Expected: the worktree is gone, the `agent/` branch remains, and the scratch repo's own checkout is untouched (`git status` is clean, as it was).
- [ ] **Step 7:** Record each command, the outcome and any defect in the acceptance log. File defects as follow-up tasks before plan 2. Commit `docs: plan 1 acceptance run`.
