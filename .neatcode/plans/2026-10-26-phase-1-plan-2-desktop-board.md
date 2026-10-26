# Coord Phase 1, plan 2: desktop board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder task list with the approved board: repo switcher, six columns, cards, a slide-in task panel (Live / Diff / Checks) with inline permission prompts, follow-ups and interrupt, the New task form, repo settings with the bypass opt-in, and desktop notifications. It ships in the Electron app and in the local PWA (`coord web`), which share `@coord/ui-web`.

**Architecture:** Everything is built on the plan 1 daemon API. Data hooks live in `@coord/app-state` (React, no DOM), so the Expo app can reuse them later. Screens live in `@coord/ui-web` (React DOM). Each app injects only its platform features (desktop: a folder picker through a new IPC channel) through an `AppPlatform` prop. Pure logic (column grouping, formatting, branch suggestion, input summaries) is kept in plain functions with unit tests. Components get jsdom tests over `fakeTransport`.

**Tech Stack:**

- React 19.3, `@testing-library/react` with jsdom, Vitest.
- zod 4 schemas in `@coord/protocol`; Fastify routes in `@coord/core`.
- Electron IPC in `apps/desktop`.
- No new runtime dependencies. The diff renders with plain elements.

**Spec:** [docs/superpowers/specs/2026-10-26-phase-1-design.md](../../docs/superpowers/specs/2026-10-26-phase-1-design.md), §4 (what the user sees), §5 (lifecycle and permission modes), §7 (repos and config), §11 (API). Approved mockups: [docs/superpowers/specs/mockups/](../../docs/superpowers/specs/mockups/) (`board-and-panel.html`, `new-task.html`).

**Builds on:** plan 1, branch `phase-1/core-loop` (PR #1). This plan's branch, `phase-1/desktop-board`, is stacked on it.

## Global Constraints

- **AGENTS.md applies in full.**
  - `pnpm check` exits 0 after every task.
  - Lint boundaries are never loosened.
  - No `--no-verify` or `SKIP_SIMPLE_GIT_HOOKS`.
  - Comments explain why.
  - File names are kebab-case.
  - Exports are named.
  - Every commit carries the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Package platforms.**
  - `@coord/app-state` is `platform:react`: no DOM APIs and no Node globals.
  - `@coord/ui-web` is `platform:dom`.
  - `@coord/protocol` is `platform:any`: pure code only.
  - Apps reach the daemon only through `@coord/client`.
- **Protocol changes are additive** (AGENTS.md rule 2). `PROTOCOL_VERSION` stays `0.1.0`. New `Task` fields get `.default(...)`. New enum values are fine because `ReadTaskStatus` already falls back to `"unknown"`.
- **Bypass** is offered only in the desktop app (`surface === "desktop"`), and only for a repo with `bypassAllowed`. It always shows the warning: "Bypass runs every tool call without asking. Only use it for repos you'd let the agent change freely." The CLI, MCP and PWA never offer it. Turning the opt-in on happens only in desktop repo settings.
- **"Always allow"** is shown only when `canRemember` is true. It is labelled exactly "Always allow this session".
- **Agent text and tool input are untrusted.** Render them as React text, never as HTML. Strip control and format characters with `displayText` (Task 1) before showing them.
- **No daemon token in the UI.** Never render it, log it or put it in a URL the UI builds.
- **Tests** sit next to the code. Use `fakeTransport` from `@coord/client/testing` with `createClient()`. Wait on real signals (`findBy*`, `waitFor`), never fixed sleeps.
- **Copy** (verbatim, from the mockups and spec §4):
  - columns `Queued`, `Running`, `Needs you`, `Review`, `PR open`, `Merged`;
  - buttons `+ New task`, `Start task`, `Allow`, `Always allow this session`, `Deny`, `Interrupt`, `Send back with feedback…`, `Discard`;
  - tabs `Live`, `Diff`, `Checks`;
  - the summary format `2 running · 1 needs you · 1 in review`, where a zero count is omitted.

## Review Focus

1. **The event connection drops and reopens while the panel is open** (laptop sleep, daemon restart). The Live tab fetches the events it missed since its last `seq`, shows no duplicates, and loses no events. Tested in Task 2.
2. **A permission prompt is answered somewhere else** (the CLI, another window) while it is on screen. It disappears. Clicking a stale prompt shows "Already answered" inline, never a crash. Tested in Task 5.
3. **A copied `.env` that the repo doesn't ignore** never appears in the Diff tab: not in the file list and not in the patch. Tested in Task 1. This is plan 1's deferred follow-up.
4. **The daemon is unreachable, or an action fails.** The board shows the banner. A failed action shows its error inline next to the button. A render error shows a recoverable error screen, never a blank window. Tested in Task 3.
5. **Notifications on first load.** Opening the app with tasks already in `needs_input` or `review` fires no notification; only transitions seen while the app runs do. Each transition notifies once. Tested in Task 8.

---

### Task 1: Protocol and daemon additions the UI needs

**Files:**

- Create:
  - `packages/protocol/src/branch.ts`
  - `packages/protocol/src/present.ts`
  - `packages/protocol/src/agents.ts`
- Modify:
  - `packages/protocol/src/task.ts` (statuses)
  - `packages/protocol/src/repo.ts`
  - `packages/protocol/src/index.ts`
  - `packages/design-tokens/src/index.ts` (`statusColors` for the new statuses)
  - `packages/worktree-manager/src/slug.ts` (re-export from protocol) and `packages/worktree-manager/src/diff.ts` (`exclude`)
  - `packages/core/src/routes/repos.ts`, `packages/core/src/routes/tasks.ts`, and a new `packages/core/src/routes/agents.ts`
  - `packages/core/src/server.ts`
  - `packages/core/src/runner/task-runner.ts` (expose `agents()` and repo updates)
  - `packages/client/src/client.ts`
  - `apps/cli/src/program.ts` (use the shared `toolInputSummary` and `displayText`)
- Test:
  - `packages/protocol/src/protocol.test.ts`
  - `packages/worktree-manager/src/diff.test.ts`
  - `packages/core/src/routes/routes.test.ts`
  - `packages/client/src/client.test.ts`
  - the existing CLI tests stay green

**Interfaces (Produces):**

- **`TaskStatus`** gains `"checking"`, `"pr_open"`, `"closed"`, an additive change. The daemon doesn't produce them until plan 3. `statusColors` gets an entry for each.
- **`slugify(text: string): string`** moves verbatim from `worktree-manager/src/slug.ts` into `protocol/src/branch.ts`. worktree-manager re-exports it, so its behaviour doesn't change.
  - Also add `branchSuggestion(prompt: string): string`, which returns `` `agent/${slugify(firstLine(prompt))}` ``.
  - `firstLine` is the first non-empty line, the same rule the runner's title uses.
- **`displayText(text: string): string`** removes `\p{Cc}` (except `\n` and `\t`) and `\p{Cf}`. This is the sanitizer from `apps/cli/src/program.ts`, moved.
- **`toolInputSummary(tool: string, input: unknown, max = 120): string`**, moved from the CLI's `inputSummary`, keeps the same rules:
  - Bash `command`;
  - `file_path`/`path`, truncated in the middle;
  - otherwise single-line JSON.

  The CLI imports both from `@coord/protocol`, and its output doesn't change.

- **`AgentInfo`:** `z.object({ id: z.string(), available: z.boolean(), costReporting: z.boolean(), liveMessages: z.boolean() })`. Route: `GET /agents` → `AgentInfo[]`.
  - It lists every `AgentId`.
  - `available` is true when the runner has an adapter for that id.
  - The other two fields come from the adapter's `capabilities` (both false when unavailable).
- **`RepoConfigView`:** `z.object({ baseBranch: z.string(), config: RepoConfig, setup: z.array(z.string()), setupSource: z.enum(["config", "detected"]) })`. Route: `GET /repos/:id/config`.
  - It resolves the effective base the same way the runner does (spec §7: the `config.baseBranch` hop) using `localBaseRef`, which never fetches.
  - Extract the runner's base-resolution rule (default branch, then one hop to `config.baseBranch`, with the config re-read from that ref) into one function that both the runner and this route call. Pass in the ref resolver: the runner uses the fetching `resolveBaseRef`; the route uses `localBaseRef`. Don't copy the logic.
  - It reads `RepoConfig` from that ref.
  - `setup` is the configured list, or `detectSetupCommands` when the config has none.
- **`UpdateRepoInput`:** `z.object({ bypassAllowed: z.boolean() })`. Route: `PATCH /repos/:id` → `Repo`, which publishes `repo.updated`. `POST /repos` also publishes `repo.updated` for the new repo.
- **Client:** `listAgents(): Promise<AgentInfo[]>`, `repoConfig(repoId: string): Promise<RepoConfigView>`, `updateRepo(repoId: string, input: UpdateRepoInput): Promise<Repo>`.
- **`diffAgainstBase({ cwd, baseRef, exclude?: string[] })`:** excluded paths (literal pathspecs) are left out of the intent-to-add step, the file list and the patch. `GET /tasks/:id/diff` passes the task's stored `envFiles`.

- [ ] **Step 1: Write failing tests:**
  - **protocol:**
    - `"branchSuggestion uses the first non-empty line"`: `branchSuggestion("\n\nAdd CSV export to reports\nmore") === "agent/add-csv-export-to-reports"`;
    - `"displayText strips control and format characters but keeps newlines"`;
    - `"toolInputSummary keeps the file name of a long path"`;
    - `"old clients read pr_open"`: `ReadTaskStatus.parse("pr_open") === "pr_open"`.
  - **worktree-manager:** `"diff excludes the given paths"`. In a repo where `.env` is not ignored and an untracked `.env` plus an edited `a.ts` sit in the worktree, `exclude: [".env"]` gives `files` = `[a.ts]` and no `.env` anywhere in `patch`. **[Review Focus 3]**
  - **routes:**
    - `"GET /agents lists claude-code as available and codex as not"`;
    - `"GET /repos/:id/config reads the config from the base branch without fetching"`, using an unreachable origin as in the existing no-fetch test;
    - `"PATCH /repos/:id sets bypassAllowed and publishes repo.updated"`;
    - `"diff route never shows a copied env file"`, end to end with the fake adapter and a config with `envFiles: [".env"]`. **[Review Focus 3]**
  - **client:** each new method's path, method and response validation.
- [ ] **Step 2:** Run `pnpm exec nx run-many -t test -p @coord/protocol @coord/worktree-manager @coord/core @coord/client @coord/cli`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS, with the CLI tests unchanged and green.
- [ ] **Step 5:** Copy the approved mockups (`board-and-panel.html`, `new-task.html`) from `.superpowers/brainstorm/*/content/` into `docs/superpowers/specs/mockups/`. Run `pnpm check`. Commit `feat: agents, repo config and settings routes; shared display helpers; diff excludes env copies`.

### Task 2: Data hooks in `@coord/app-state`

**Files:**

- Create:
  - `packages/app-state/src/use-repos.ts`
  - `packages/app-state/src/use-task.ts`
  - `packages/app-state/src/use-task-events.ts`
  - `packages/app-state/src/use-permissions.ts`
  - `packages/app-state/src/use-agents.ts`
  - `packages/app-state/src/use-repo-config.ts`
  - `packages/app-state/src/use-action.ts`
- Modify: `packages/app-state/src/use-tasks.ts`, `packages/app-state/src/index.ts`
- Test: `packages/app-state/src/hooks.test.tsx` (extend it; same harness)

**Interfaces:**

- **Consumes:** `useLiveQuery` (unchanged) and the client methods from plan 1 and Task 1.
- **Produces** (each loader is memoised on its arguments, as `useLiveQuery` requires):
  - `useTasks(filter?: { repoId?: string; all?: boolean }, intervalMs = 15_000): TasksState`. The existing no-argument call keeps working.
  - `useRepos(): QueryState<Repo[]>`. It refreshes on `repo.updated`.
  - `useTask(taskId: string | null): QueryState<Task> | null`. It returns `null` for a `null` id and refreshes on `task.updated` for that id.
  - `usePermissions(taskId?: string): QueryState<PermissionRequestView[]>`. Without an id it returns every pending permission. It refreshes on `permission.requested`/`permission.resolved` (for that task when an id is given).
  - `useAgents(): QueryState<AgentInfo[]>`.
  - `useRepoConfig(repoId: string | null): QueryState<RepoConfigView> | null`.
  - `useTaskEvents(taskId: string): { status: "loading" | "ok" | "error"; events: DaemonEvent[]; error?: string }`:
    - it loads `taskEvents(taskId)`, then appends pushed events for this task (`agent.event`, `task.updated`, `permission.*`);
    - it keeps events sorted by `seq` with no duplicates;
    - on every `onStatus("open")` after the first, it fetches `taskEvents(taskId, lastSeq)` and merges the result.
  - `useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): { run: (...args: A) => Promise<R | undefined>; pending: boolean; error: string | null }`:
    - `run` sets `pending`;
    - on failure it records the `DaemonError` message in `error` and resolves `undefined` rather than throwing;
    - a later successful `run` clears `error`.

- [ ] **Step 1: Write failing tests:**
  - `"useTaskEvents merges history and live events in seq order without duplicates"`;
  - `"useTaskEvents fetches what it missed after the connection reopens"`. Drive `fakeTransport`'s status closed, then open, while events 5–7 happen. Assert a request for `/tasks/<id>/events?sinceSeq=4`, and that the final list is seqs 1–7 exactly once. **[Review Focus 1]**
  - `"usePermissions without a task id lists all pending and drops a resolved one"`;
  - `"useAction records the daemon error and clears it on the next success"`;
  - `"useTask returns null for a null id and makes no request"`.
- [ ] **Step 2:** Run `pnpm exec nx run-many -t test -p @coord/app-state`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Run `pnpm check`, then commit `feat(app-state): hooks for repos, task events, permissions, agents and actions`.

### Task 3: Board

**Files:**

- Create:
  - `packages/ui-web/src/board/columns.ts`
  - `packages/ui-web/src/board/board.tsx`
  - `packages/ui-web/src/board/task-card.tsx`
  - `packages/ui-web/src/format.ts`
  - `packages/ui-web/src/theme.tsx`
  - `packages/ui-web/src/error-boundary.tsx`
  - `packages/ui-web/src/use-now.ts`
- Modify: `packages/ui-web/src/app.tsx`, `packages/ui-web/src/index.ts`
- Test:
  - `packages/ui-web/src/board/columns.test.ts`
  - `packages/ui-web/src/format.test.ts`
  - `packages/ui-web/src/board/board.test.tsx`
  - `packages/ui-web/src/app.test.tsx`

**Interfaces:**

- **Consumes:** Task 2 hooks; `displayText`; `statusColors` and the tokens.
- **Produces:**
  - **`AppPlatform`:** `{ pickFolder?: () => Promise<string | null>; notify?: (n: { title: string; body: string; onClick: () => void }) => void }`.
  - **`Notify`:** `type Notify = (n: { title: string; body: string; onClick: () => void }) => void`. `AppPlatform.notify` uses this type, and Task 8 uses it too.
  - **`App`:** `App(props: { surface: "desktop" | "web"; platform?: AppPlatform })`. The existing `surface` prop keeps working.
  - **Column ids:** `type ColumnId = "queued" | "running" | "needs_you" | "review" | "pr_open" | "merged" | "closed"`.
  - **`columnFor(task: Task, now: Date): ColumnId`:**

    | Status                                                | Column      |
    | ----------------------------------------------------- | ----------- |
    | `queued`                                              | `queued`    |
    | `setting_up`, `running`, `checking`                   | `running`   |
    | `needs_input`, `failed`, `interrupted`, and `unknown` | `needs_you` |
    | `review`                                              | `review`    |
    | `pr_open`                                             | `pr_open`   |
    | `merged`, with `updatedAt` within 7 days of `now`     | `merged`    |
    | `closed`, `cancelled`, `cleaned_up`, older `merged`   | `closed`    |

    `unknown` goes to `needs_you`: a status from a newer daemon is something the user should look at.

  - **`groupTasks(tasks: Task[], opts: { now: Date; showClosed: boolean }): Record<ColumnId, Task[]>`.** `closed` is empty unless `showClosed`. Each column is sorted newest `updatedAt` first.
  - **`boardSummary(tasks: Task[]): string`.**
    - It counts `running` (the Running column), `needs you` and `in review`, joined with `·`, omitting zeros.
    - With no tasks it returns `"No tasks yet"`.
  - **`formatElapsed(fromIso: string, toIso: string | Date): string`** gives `"45 s"`, `"4 min"`, `"2 h"` or `"3 d"`. A finished task uses `updatedAt`; an active one uses `now`.
  - **`formatUsage(task: Task, costReporting: boolean): string`** gives `"$0.21"` (2 decimals) or `"41k tok"` (input plus output, rounded to the nearest thousand, below 1000 as `"850 tok"`).
  - **`useNow(intervalMs = 30_000): Date`** re-renders the board's elapsed times.
- **Board layout** (mockup `board-and-panel.html`):
  - A header with the repo switcher slot (Task 4), the summary and `+ New task`.
  - The columns in `ColumnId` order, plus a `show closed` toggle under Merged.
  - **Cards:**
    - The title (`displayText`).
    - The agent label: `Claude` or `Codex`, or the raw id for others.
    - Elapsed time.
    - `formatUsage`.
    - A `needs_you` card is highlighted with the status colour border and shows:
      - its first pending permission's `toolInputSummary`, from `usePermissions()` with no id;
      - otherwise its error (`failed`/`interrupted`), or `"interrupted — resume"`.
    - Clicking a card calls `onOpen(task.id)`.
  - **Theme:** `ThemeStyle` writes CSS custom properties from `colors.light` and `colors.dark`, switched with `prefers-color-scheme`. Components use `var(--coord-*)`.
  - **Error boundary:** `ErrorBoundary` wraps the app. On a render error it shows "Something went wrong" and the message, plus a `Reload` button that remounts the children.
  - **Daemon banner:** the existing `DaemonBanner` stays at the top. Its `Daemon unreachable` text stays.

- [ ] **Step 1: Write failing tests:**
  - **columns:** one assertion per row of the table above, including `merged` at 6 and 8 days, and `"unknown status goes to needs you"`.
  - **format:** the elapsed and usage examples above.
  - **board:**
    - `"shows the six columns and the summary 1 running · 1 needs you"`;
    - `"needs-you card shows the pending prompt summary"`;
    - `"show closed reveals cancelled tasks"`;
    - `"a card click opens the task"` (asserts `onOpen` received the id).
  - **app:**
    - `"daemon unreachable shows the banner and the board stays usable"`;
    - `"a render error shows the recoverable error screen"`, using a child that throws. **[Review Focus 4]**
- [ ] **Step 2:** Run `pnpm exec nx run-many -t test -p @coord/ui-web`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Run `pnpm check`, then commit `feat(ui-web): board with columns, cards and summary`.

### Task 4: Repos: switcher, add repo (with the desktop folder picker), settings

**Files:**

- Create:
  - `packages/ui-web/src/repos/repo-switcher.tsx`
  - `packages/ui-web/src/repos/add-repo.tsx`
  - `packages/ui-web/src/repos/repo-settings.tsx`
- Modify:
  - `packages/ui-web/src/app.tsx`
  - `apps/desktop/src/shared/ipc.ts`
  - `apps/desktop/src/preload/index.ts`
  - `apps/desktop/src/main/index.ts`
  - `apps/desktop/src/renderer/src/main.tsx`
- Test:
  - `packages/ui-web/src/repos/repos.test.tsx`
  - `apps/desktop/src/shared/ipc.test.ts`

**Interfaces:**

- **Consumes:** `useRepos`, `useAction`, `client.addRepo`, `client.updateRepo`, `AppPlatform.pickFolder`.
- **Produces:**
  - **The switcher** shows `<repo name> ▾`. The selected repo id is kept in `localStorage` under `"coord.repo"`. Every access is wrapped in try/catch, because a private window can throw. If the stored id is unknown, it falls back to the first repo. The board shows only that repo's tasks (`useTasks({ repoId, all: showClosed })`).
  - **Add repo:**
    - With `platform.pickFolder`, a button opens the picker. Cancelling (`null`) does nothing.
    - Without it (PWA), a path input and an `Add` button.
    - The daemon's error message (for example "not a git repository") is shown inline.
    - The new repo becomes selected.
  - **No repos yet:** an empty state, "Add a repo to start", with the add control.
  - **Repo settings** is a panel from the switcher menu. It shows the name, path, default branch and remote. On `surface === "desktop"` only, it shows a `Allow bypass mode for this repo` checkbox with the Global Constraints warning, which calls `updateRepo(id, { bypassAllowed })`.
  - **Desktop IPC:**
    - `PICK_FOLDER_CHANNEL = "coord:pick-folder"`;
    - `CoordBridge.pickFolder(): Promise<string | null>`;
    - the main handler calls `dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ["openDirectory"] })` and returns the first path or `null`;
    - the renderer passes `platform={{ pickFolder: () => window.coord.pickFolder() }}`.

- [ ] **Step 1: Write failing tests:**
  - `"picks a folder on desktop and adds it"`;
  - `"web adds a repo by path and shows the daemon's error inline"`;
  - `"cancelling the picker adds nothing"`;
  - `"bypass checkbox shows only on desktop and sends updateRepo"`;
  - `"remembers the selected repo, and falls back when storage throws"`;
  - `"no repos shows the empty state"`;
  - desktop: `"PICK_FOLDER_CHANNEL is distinct from the daemon channels"`.
- [ ] **Step 2:** Run `pnpm exec nx run-many -t test -p @coord/ui-web @coord/desktop`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Run `pnpm check`, then commit `feat: repo switcher, add repo with the desktop folder picker, repo settings`.

### Task 5: Task panel and the Live tab

**Files:**

- Create:
  - `packages/ui-web/src/panel/task-panel.tsx`
  - `packages/ui-web/src/panel/live-tab.tsx`
  - `packages/ui-web/src/panel/live-rows.ts`
  - `packages/ui-web/src/panel/permission-prompt.tsx`
  - `packages/ui-web/src/panel/message-box.tsx`
- Modify: `packages/ui-web/src/app.tsx`
- Test:
  - `packages/ui-web/src/panel/live-rows.test.ts`
  - `packages/ui-web/src/panel/task-panel.test.tsx`

**Interfaces:**

- **Consumes:** `useTask`, `useTaskEvents`, `usePermissions(taskId)`, `useAgents`, `useAction`; the client's `sendMessage`, `interrupt`, `resumeTask`, `cancel`, `answerPermission`; `displayText`, `toolInputSummary`.
- **Produces:**
  - **`TaskPanel`:** `TaskPanel(props: { taskId: string; surface: "desktop" | "web"; onClose: () => void })`.
    - It slides in from the right and the board stays visible.
    - `Esc` and a `×` button close it.
    - Tabs: `Live`, `Diff`, `Checks`. Diff and Checks come from Task 6; until then they render placeholders.
  - **Header:** the title, then `<agent> · <model or "default model"> · branch <branch> · <turns> commits`, then the status.
    - **Actions:**
      - `Interrupt` when `running`/`needs_input`;
      - `Resume` when `interrupted`/`failed`;
      - `Cancel` for `queued` and every working status, with an inline "Cancel this task? Work so far is committed to its branch. [Cancel task] [Keep]" confirmation.
    - Each action shows its `useAction` error inline.
  - **`liveRows(events: DaemonEvent[]): LiveRow[]`** turns `agent.event` payloads into rows. `LiveRow = { key: string; depth: 0 | 1; kind: "text" | "tool" | "result" | "turn" | "error" | "status"; text: string; ok?: boolean }`:
    - `text` events become their text;
    - `tool_call` becomes `` `▸ ${name} ${toolInputSummary(name, input)}` ``;
    - `tool_result` failures become `"✗ failed"` attached to their call;
    - `done` becomes `"Turn finished"` plus the summary;
    - `error` becomes its message;
    - `task.updated` becomes a status row only when the status changed;
    - `usage` and `session` are skipped;
    - an event with `parentToolUseId` gets `depth: 1` (sub-agent nesting, spec §10).
  - **Permission prompts** come from `usePermissions(taskId)`, rendered inline at the end of the stream:
    - `"<Agent> wants to run: <toolInputSummary>"` for Bash, otherwise `"<Agent> wants to use <tool>: <summary>"`, plus the title;
    - the buttons `Allow`, `Always allow this session` (only when `canRemember`) and `Deny`, where Deny opens an optional reason field;
    - a `409`/`404` reply shows "Already answered" and the prompt disappears on the next refresh. **[Review Focus 2]**
  - **The message box** is a textarea plus `Send` (⌘↵ / Ctrl↵):
    - while the task is `running` or `needs_input`, it shows the hint "Delivered when the current turn ends" under it;
    - it is disabled for `cancelled`, `cleaned_up` and `closed`.
  - **Scrolling:** the stream auto-scrolls to the bottom unless the user has scrolled up.

- [ ] **Step 1: Write failing tests:**
  - **live-rows:** each mapping above, including sub-agent depth and the skipped kinds.
  - **panel:**
    - `"shows the live stream and the header"`;
    - `"answering Allow sends the decision"`;
    - `"Always allow appears only when canRemember"`;
    - `"a prompt answered elsewhere disappears, and a stale click shows Already answered"`. Emit `permission.resolved`, and have the fake reply 409 to the click. **[Review Focus 2]**
    - `"send while running shows the turn-end hint and posts the message"`;
    - `"Interrupt is offered while running and calls interrupt"`;
    - `"cancel asks for confirmation first"`;
    - `"Esc closes the panel"`.
- [ ] **Step 2:** Run `pnpm exec nx run-many -t test -p @coord/ui-web`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Run `pnpm check`, then commit `feat(ui-web): task panel with the live stream, inline permissions and follow-ups`.

### Task 6: Diff and Checks tabs

**Files:**

- Create:
  - `packages/ui-web/src/panel/diff-tab.tsx`
  - `packages/ui-web/src/panel/split-patch.ts`
  - `packages/ui-web/src/panel/checks-tab.tsx`
- Modify: `packages/ui-web/src/panel/task-panel.tsx`
- Test:
  - `packages/ui-web/src/panel/split-patch.test.ts`
  - `packages/ui-web/src/panel/diff-tab.test.tsx`
  - `packages/ui-web/src/panel/checks-tab.test.tsx`

**Interfaces:**

- **Consumes:** `client.taskDiff`, `client.sendMessage`, `client.discard`, `useAction`.
- **Produces:**
  - **`splitPatch(patch: string): Array<{ path: string; lines: string[]; binary: boolean }>`** splits on `diff --git a/… b/…` headers. `binary` is true when the section has `Binary files … differ`.
  - **Diff tab:**
    - The summary line is `<n> files · +A −D · base <baseRef>`.
    - Each file shows `path` with status, +/− counts, and its lines (`+` lines green, `-` lines red, `@@` muted, monospace).
    - Binary files show "Binary file changed".
    - `truncated` shows "Diff truncated — open the worktree to see everything" with the worktree path.
    - Empty shows "No changes yet".
    - A `409` (no worktree) shows the daemon's message.
    - The tab loads on open and on `task.updated` for the task.
    - "Up to date with base" comes in plan 3.
  - **Checks tab:**
    - It shows "Checks run here once they're set up (coming next)" until plan 3 adds `CheckResult`.
    - **Review actions** (for `review`, `failed` and `interrupted`):
      - `Send back with feedback…` opens a textarea and `Send`, which calls `sendMessage`;
      - `Discard` asks "Discard this task? The worktree is removed; its branch is kept for 14 days." with `[Discard]` and `[Keep]`, then calls `discard`.
    - `Open PR` is not shown until plan 3.

- [ ] **Step 1: Write failing tests:**
  - **split-patch:** two files, a binary file, a rename.
  - **diff-tab:**
    - `"shows files, counts and colored lines"`;
    - `"truncated diff shows the notice"`;
    - `"409 shows the daemon message"`.
  - **checks-tab:**
    - `"send back posts the feedback"`;
    - `"discard asks first, then calls discard"`;
    - `"no review actions while running"`.
- [ ] **Step 2:** Run `pnpm exec nx run-many -t test -p @coord/ui-web`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Run `pnpm check`, then commit `feat(ui-web): diff and checks tabs with review actions`.

### Task 7: New task form

**Files:**

- Create: `packages/ui-web/src/new-task/new-task-form.tsx`
- Modify: `packages/ui-web/src/app.tsx`
- Test: `packages/ui-web/src/new-task/new-task-form.test.tsx`

**Interfaces:**

- **Consumes:** `useRepos`, `useRepoConfig`, `useAgents`, `useAction`, `client.createTask`, `branchSuggestion`.
- **Produces:** `NewTaskForm(props: { repoId: string | null; surface: "desktop" | "web"; onCreated: (taskId: string) => void; onClose: () => void })`, opened by `+ New task`. Its fields follow mockup `new-task.html`:
  - **Repo:** a select of the registered repos, preselected to the board's repo. Under it, `path · base <baseBranch>` from `useRepoConfig`.
  - **What should the agent do?:** a required textarea.
  - **Agent:**
    - radio buttons from `useAgents()`, with `Claude Code` the default;
    - an unavailable agent is disabled and labelled "(not installed)";
    - `codex` reads `Codex`.
  - **Model:** an optional text input, placeholder "Default (the agent's own setting)". It is sent only when non-empty.
  - **Branch:**
    - it is prefilled with `branchSuggestion(prompt)` and follows the prompt until the user edits it;
    - it is validated against the `CreateTaskInput` branch regex before submit, with an inline message;
    - it is sent only when it differs from the suggestion, so the daemon's `uniqueBranch` still de-duplicates the default.
  - **Advanced** (collapsed by default, labelled `▸ Advanced: permission mode · base branch · setup script`):
    - **Permission mode:** `Ask (default)` or `Auto-accept edits`, plus `Bypass` only when `surface === "desktop"` and the repo has `bypassAllowed`, shown with the warning.
    - **Base branch:** a text input with the default from `RepoConfigView.baseBranch`. It is sent only when changed.
    - **Setup script:** a read-only list of `RepoConfigView.setup`, labelled "from `.coord/config.json`" or "detected", plus the note "Change it in `.coord/config.json` on the base branch." Per-task setup overrides are not in Phase 1.
  - **Submit:** `Start task`, also on ⌘↵ / Ctrl↵.
    - It is disabled while pending or while the prompt is empty.
    - The daemon's error is shown inline, for example a repo not registered or bypass forbidden.
    - On success it calls `onCreated(task.id)`, which opens that task's panel.

- [ ] **Step 1: Write failing tests:**
  - `"branch follows the prompt until edited"`;
  - `"sends only the fields the user set"`: assert the POST body has no `model`, `branch` or `baseBranch` by default;
  - `"codex shows as not installed when unavailable"`;
  - `"bypass is offered only on desktop for an opted-in repo"`;
  - `"invalid branch shows an inline error and sends nothing"`;
  - `"Cmd+Enter submits and opens the new task"`;
  - `"daemon error is shown inline"`.
- [ ] **Step 2:** Run `pnpm exec nx run-many -t test -p @coord/ui-web`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Run `pnpm check`, then commit `feat(ui-web): new task form`.

### Task 8: Desktop notifications

**Files:**

- Create: `packages/ui-web/src/notifications/use-task-notifications.ts`, `packages/ui-web/src/notifications/notifier.ts`
- Modify: `packages/ui-web/src/app.tsx`
- Test: `packages/ui-web/src/notifications/use-task-notifications.test.tsx`

**Interfaces:**

- **Consumes:** `client.subscribe`, `AppPlatform.notify`.
- **Produces:**
  - **`useTaskNotifications(notify: Notify, onOpen: (taskId: string) => void): void`** subscribes to `task.updated` and remembers the last status seen per task id.
    - The first event for a task only records its status. Opening the app with tasks already waiting is silent. **[Review Focus 5]**
    - A change into `needs_input` notifies `"Needs you: <title>"`. The body is "Waiting for your answer".
    - A change into `review` notifies `"Ready for review: <title>"`. The body is the turn count.
    - A change into `failed` notifies `"Failed: <title>"`. The body is the error, through `displayText`, cut to 120 characters.
    - Repeats of the same status don't notify again.
    - The click handler calls `onOpen(taskId)` and `window.focus()`.
  - **`browserNotifier(): Notify | null`** wraps the Web `Notification` API (Electron's renderer and browsers both have it). It returns `null` when `Notification` is missing.
    - On `surface === "web"` with permission `"default"`, the header shows an `Enable notifications` button. It calls `Notification.requestPermission()` from a click, because browsers require a user gesture.
    - Electron grants permission without asking.
  - **App wiring:** `App` uses `platform.notify ?? browserNotifier()`.

- [ ] **Step 1: Write failing tests**, with a fake `notify` and `fakeTransport` events:
  - `"no notification for statuses seen on first load"`;
  - `"notifies once on entering needs_input, review and failed"`;
  - `"clicking a notification opens the task"`;
  - `"a repeated status does not notify again"`.
- [ ] **Step 2:** Run `pnpm exec nx run-many -t test -p @coord/ui-web`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Run `pnpm check`, then commit `feat(ui-web): desktop notifications for needs-you, review and failed`.

### Task 9: Acceptance run of the board (manual, recorded)

**Files:**

- Create: `.neatcode/plans/2026-10-26-phase-1-plan-2-acceptance.md` (a log of the run)
- Modify: `README.md` (the quick start gains "open the board: `pnpm desktop`, or `pnpm coord web`")

- [ ] **Step 1: Set up.**
  1. Use a temp `COORD_HOME`, `COORD_PORT=4649`, and a scratch repo with a local bare origin, as in the plan 1 acceptance runs.
  2. Start the daemon.
  3. Start the PWA dev server (`pnpm web`) with the same `COORD_PORT`.
  4. Open the `pnpm coord web` link in a browser driven by Playwright.
- [ ] **Step 2: Repo.** Add the repo by path in the PWA, and confirm that the bypass checkbox is absent on web.
- [ ] **Step 3: First task.** From `+ New task`, start a small Claude Code task in `Ask` mode. Then:
  1. Watch it in the Live tab.
  2. Answer one prompt inline with `Allow`.
  3. Send one follow-up while it is running, and confirm the hint shows and a `(turn 2)` commit appears.
  4. Open the Diff tab.
  5. `Discard` it.
- [ ] **Step 4: Second task.** Start another task, `Interrupt` it, and check that it lands in `Review`. Kill the daemon and restart it, then check that the board reconnects and the Live tab doesn't duplicate events.
- [ ] **Step 5: Desktop.** Launch `pnpm desktop` against the same daemon (same `COORD_PORT` and `COORD_HOME`). Check:
  1. the board loads with the same tasks;
  2. the folder picker opens (`Add repo`);
  3. repo settings shows the bypass checkbox;
  4. a desktop notification fires when a task enters review.

  Electron can't be driven by Playwright here, so record these checks by hand from screenshots or the DevTools console, and say which.

- [ ] **Step 6: Record and commit.** Record each step's commands, the outcome (PASS / FAIL) and any defect in the acceptance log. File defects as follow-ups. Commit `docs: plan 2 acceptance run`.
