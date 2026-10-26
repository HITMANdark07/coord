# Coord Phase 1 design: the local loop

**Date:** 2026-10-26 · **Status:** Ready for approval · **Builds on:** [PRD v0.5](../../PRD.md), [AGENTS.md](../../../AGENTS.md)

In this document, **(decided)** marks the owner's choices from the design conversation and **(my call)** marks defaults chosen while writing it up, which the owner can override.

## 1. Intent

Coord is an open, agent-neutral command center for coding agents:

- **Agent choice:** pick Claude Code or Codex per task.
- **Isolation:** every task runs in its own git worktree on your machine.
- **Your rules:** nothing reaches your main branch without passing the repo's own rules.

It is open source and local-first, and there is no account.

**Why this angle (decided).** Claude Code now runs parallel worktree sessions with phone control itself. Conductor and Superset shipped similar features this month. Coord differs by being fully open source, agent-neutral from v1 (Claude Code **and** Codex), checking repo conventions before code leaves the worktree, and (Phase 4) using an end-to-end encrypted, self-hostable relay.

**Phase 1 delivers the core loop on one machine:** create a task, watch it run, review the diff, open a GitHub pull request. The phone (relay) comes later.

## 2. Goals, non-goals, anti-goals

**Goals (decided)**

1. **Create a task** from the desktop app, the CLI or the MCP server (Claude Code spawning tasks), choosing **Claude Code or Codex**.
2. **Watch it run live:**
   - see what the agent does;
   - answer its permission prompts (allow / always allow for this session / deny);
   - message it or interrupt it.
3. **Review** the full diff and check results.
4. **Open a GitHub pull request.** Coord never merges anything itself.
5. **Track the PR** until it is merged or closed on GitHub, then clean up.

**Definition of done (decided).** Phase 1 is done when the owner can use the whole loop daily **from this repo** (`pnpm desktop`, `pnpm coord`, `claude mcp add` pointing at `apps/mcp-server`), for **both** Claude Code and Codex. The acceptance run, on a real project:

1. Create two tasks in parallel, one per agent, from the desktop app.
2. Answer at least one permission prompt from the board.
3. Send feedback once.
4. Review the diffs and check results.
5. Open both PRs.
6. Merge one and close the other on GitHub, and see Coord clean both up.
7. Restart the daemon mid-task once and resume.

`pnpm check` and CI stay green throughout.

**Next phase, not this one (decided): packaging.** That means a packaged Electron app with a bundled daemon and native SQLite, the `coord` CLI published to npm, and a one-command MCP setup. It is its own short phase after Phase 1, before the phone and relay work.

**Non-goals (Phase 1)**

- The phone and relay (Phase 4).
- The Expo app (after the PWA).
- Conflict warnings between tasks.
- AI task splitting.
- Containers.
- "Attach mode" for sessions started by hand.
- Agents other than Claude Code and Codex.
- Windows.

The PWA gets the same UI for free (shared `ui-web`), but only locally via `coord web`.

**Anti-goals (decided: these would make Phase 1 a failure even if it "works")**

- **Losing work.**
- **Merging broken code.**

§6 and §8 exist to prevent both.

## 3. Constraints

- **Repo rules.** Everything follows [AGENTS.md](../../../AGENTS.md). New packages come from the Nx generator with the right `type:`/`platform:` tags; apps never import the daemon, adapters or services; all wire shapes are zod schemas in `@coord/protocol`; `pnpm check` must stay green.
- **Protocol changes stay additive.** They need no version bump, and old clients map unknown statuses to "unknown".
- **Security defaults stay as built:** token auth, origin allowlist, `127.0.0.1` binding, Electron sandbox and IPC checks.
- **Credentials.** Agents use the user's own logins (Claude Code login; ChatGPT login or API key for Codex). Coord stores no agent credentials. GitHub access goes through the user's `gh` login.
- **Platforms:** macOS and Linux, Node 24 (pinned).

## 4. What the user sees (decided, from the mockups)

**Board (home screen).** One board per repo (repo switcher at the top), with a header summary ("2 running · 1 needs you · 1 in review") and **+ New task**. Columns:

| Column    | Task statuses shown there                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queued    | `queued`                                                                                                                                           |
| Running   | `setting_up`, `running`, `checking`                                                                                                                |
| Needs you | `needs_input`, plus `failed` and `interrupted` (both need the user to act)                                                                         |
| Review    | `review`                                                                                                                                           |
| PR open   | `pr_open`                                                                                                                                          |
| Merged    | `merged`, last 7 days (my call); older ones in a History view. `closed`, `cancelled` and discarded tasks are hidden behind "show closed" (my call) |

**Cards** show the title and agent, plus cost (Claude, in $) or tokens (Codex, which reports no $), plus elapsed time.

- "Needs you" cards are highlighted.
- PR cards show `#number` and link to GitHub.

**Task panel.** Clicking a card slides a panel in from the right; the board stays visible. It has three tabs:

- **Live.** A stream of the agent's actions (messages, files read and edited, commands run, to-do list).
  - Permission prompts appear inline with **Allow / Always allow this session / Deny**. "Always allow" is offered only when the agent permits a permanent rule.
  - A message box sends a follow-up into the same session, and there is an **Interrupt** button.
- **Diff.** The full diff of the task branch against its base, file by file, with +/− counts and whether the branch is up to date with the base.
- **Checks.** Each check's pass/fail and output.
  - Review actions: **Open PR**, **Send back with feedback…** (a follow-up message), **Discard**.

**New task form:**

- **Repo**, showing its path and base branch.
- **What should the agent do?** (free text).
- **Agent:** Claude Code (default) or Codex.
- **Model:** default = the agent's own setting.
- **Branch:** suggested `agent/<slug-from-prompt>`, editable.
- **Advanced (collapsed):** permission mode, base branch, setup script.
- **Start task** (⌘↵).

**Permission prompts.** "Always allow" means **this session only** (decided by the approved mockup).

- For Claude Code, Coord sends the SDK's suggested rules with the destination forced to `session`, so a click never writes `.claude/settings*.json` into the worktree (which auto-commit would commit) or into the user's global settings.
- For Codex it's `acceptForSession`.
- A per-repo allowlist (PRD FR-4) is later work.

**Desktop notifications** when a task needs input, finishes a turn (enters review) or fails (my call: these were P1 in the PRD, but "watch it run" depends on them).

## 5. Task lifecycle

```
queued → setting_up → running ⇄ needs_input
                         │
                         ├─(turn done)→ checking → review ─(Open PR)→ pr_open → merged | closed
                         │                           │  ▲
                         │                           └──┘ (Send back with feedback → running)
                         ├─(error)→ failed ─(retry/resume)→ running
                         └─(daemon restart)→ interrupted ─(resume)→ running
any active state ─(Cancel)→ cancelled ;  review/failed/interrupted ─(Discard)→ cancelled
```

- **New statuses** (additive to the protocol): `checking`, `pr_open`, `merged`, `closed`. `interrupted` and `cancelled` already exist.
- **Concurrency (my call).** At most **3** tasks have an agent actively working (`setting_up`, `running`, `needs_input`, `checking`); the rest stay `queued`. The number is configurable.
- **Turn end vs task end (my call).** When a turn ends (`done` event), Coord:
  1. auto-commits (§6);
  2. ends the agent session (`AgentRun.end()`), so no idle agent processes are kept;
  3. moves the task to `checking` → `review`.

  Feedback ("Send back", or a message after the PR is open) **resumes** the session by its stored session id. Only working tasks hold processes or count toward the cap.

- **Interrupt (my call).** The user's Interrupt ends the current turn like a normal turn end (commit → checks → review), not as a failure. The adapter reports a user interrupt as `done` (with an "interrupted" summary), never as `error`. Continue with a message.
- **Follow-ups after the PR is open (my call).** `pr_open` → (message) → `running` → `checking` → `review`. **Nothing is pushed automatically:**
  - the user clicks **Push to PR**;
  - if checks fail, the push converts the PR to a **draft**, with the failures noted in a PR comment.

  PR tracking (§8) continues meanwhile. A PR merged or closed on GitHub while the task is mid-follow-up is shown on the card, and cleanup waits until the task is idle.

- **Permission modes (my call, from PRD §8 Safety).**

  | Mode                  | Claude Code         | Codex                                            |
  | --------------------- | ------------------- | ------------------------------------------------ |
  | **Ask** (default)     | `default`           | approval `untrusted`, sandbox `workspace-write`  |
  | **Auto-accept edits** | `acceptEdits`       | approval `on-request`, sandbox `workspace-write` |
  | **Bypass**            | `bypassPermissions` | approval `never`, sandbox `danger-full-access`   |

  Bypass is available only for repos where the user has opted in, in the desktop app's repo settings, and shows a warning. It can never be chosen from the CLI, MCP or (later) the phone: the daemon rejects it with `forbidden`.

## 6. Git and worktrees: never lose work

- **Location (my call):** `~/.coord/worktrees/<repo-name>-<repo-id>/<task-slug>` (under `COORD_HOME`), outside the user's repo.
- **Branch:** `agent/<slug>` from the chosen base branch (default: the repo's default branch, refreshed with `git fetch` first).
  - Coord only ever creates, commits to, pushes or deletes branches with the `agent/` prefix that it created itself.
  - It never force-pushes and never touches the user's own checkout.
- **Auto-commit after every turn (decided).** When a turn ends, Coord commits all changes in the worktree to the task branch, so no work lives only as uncommitted files. My calls for the commit:
  - **Message:** `<task title> (turn N)`, with a `Coord-Task: <task-id>` trailer and a `Co-Authored-By` trailer naming the agent.
  - **Empty turns** produce no commit. Files the repo's `.gitignore` excludes stay excluded.
  - **Author identity** is the user's own git identity.
  - **Signing** follows the user's git config (`commit.gpgsign`).
  - **Commit hooks are skipped** (`--no-verify`): these are checkpoint snapshots. The repo's real checks run in the check step (§8), and configured checks can call the repo's hook commands.
  - **If a commit fails** (e.g. signing needs a passphrase), the task goes to "Needs you" with the error. The worktree is left exactly as it is, so nothing is lost, and Open PR stays disabled until the work is committed.
- **Setup script.** After creating the worktree, Coord copies the files listed in `envFiles` (e.g. `.env`) from the main checkout, then runs `setup` commands (see §7) in the worktree. A setup failure → `failed`, with the output kept.
- **Per-task ports (PRD FR-14).** Each task gets a block of 10 ports from a configured range, exposed as `COORD_PORT_BASE` in the agent's environment (my call).
- **Cleanup.** A worktree is removed only when its PR is `merged` or `closed` **and** every local commit exists on the remote branch.
  - The remote branch is left to GitHub's own setting.
  - If a check before removal fails, the worktree is kept and the task is flagged.
- **Discard.** It asks for confirmation, removes the worktree, keeps the local branch for **14 days** (my call), then deletes it. Pushed branches are never deleted by Coord.
- **Restarts.** Everything needed to continue is in SQLite (§9) plus the worktree on disk. On daemon start, tasks that were `running`/`needs_input`/`setting_up`/`checking` become `interrupted`; resuming uses the stored agent session id.

## 7. Repos and `.coord/config.json`

**Registering a repo:**

- In the desktop app, "Add repo" opens a folder picker.
- From the CLI, `coord repo add [path]`.
- Coord stores the path, name, default branch and GitHub remote in SQLite.
- The path must be a git repo whose working tree it never modifies.

**Config (optional; committed in the user's repo so a team shares it).** Proposed shape (my call):

```jsonc
{
  "baseBranch": "main", // default: the remote's default branch
  "envFiles": [".env", ".env.local"], // copied from the main checkout
  "setup": ["pnpm install --frozen-lockfile"], // default: detect the package manager and install
  "checks": {
    // default: package.json scripts that exist among test, lint, typecheck
    "test": "pnpm test",
    "lint": "pnpm lint",
  },
  "neatcode": true, // default: true when .neatcode/skills.yaml exists
  "ports": { "start": 41000, "blockSize": 10 },
}
```

Its zod schema lives in `@coord/protocol` (`RepoConfig`).

**Which copy is trusted (my call).** `setup` and `checks` are commands Coord runs automatically, so they're read from `.coord/config.json` **on the base branch** (after `git fetch`), never from the task branch. An agent therefore can't edit its own checks into passing. If a task's diff changes `.coord/config.json`, the Review tab shows a warning, and the change takes effect only after it's merged into the base.

## 8. Checks and pull requests: never merge broken code

**Checks** run when a turn ends (status `checking`):

- Each configured check runs in the worktree after the auto-commit, so results describe a committed state.
- No new agent turn starts while checks run; a message sent meanwhile is queued until they finish.
- **neatcode** runs as `neatcode sync` + `neatcode validate --json` in the worktree (same handling as `tools/neatcode-check.mjs`: ignore violations in deleted files).
- Results (pass/fail, duration, truncated output) are stored and shown in the Checks tab and on the card.

**Open PR (decided: merge = GitHub PR):**

1. **Preconditions:**
   - the repo has a GitHub remote;
   - `gh` is installed and logged in;
   - the branch has at least one commit beyond the base.

   The UI says plainly which is missing.

2. **Staleness.** `git fetch`; if the base has moved, show "behind base by N commits" and offer **Update branch**, which merges the base into the task branch in the worktree. On conflict it stops and tells the user; resolving conflicts with the agent is Phase 2+.
3. **Push and create.** Push `agent/<slug>` (no force), then `gh pr create` against the base.
   - **Title:** the task title.
   - **Body (my call):** the prompt, the agent's final summary, a checks table, and the agent and model.
4. **Failing checks.** **Open anyway** creates the PR as a **draft**, with the failing checks listed at the top of the body.
5. **Coord never merges.** Merging happens on GitHub.

**Tracking.**

- While a task is `pr_open`, the daemon polls the PR state with `gh pr view` every 3 minutes (my call), and on desktop focus.
- `MERGED` → `merged` → cleanup; `CLOSED` → `closed` → cleanup.
- Follow-ups after a PR is open (e.g. "address review comments") resume the session in the kept worktree and push new commits to the same branch.

## 9. Persistence

- **Engine.** SQLite through `better-sqlite3` (already approved in `onlyBuiltDependencies`), one file at `<COORD_HOME>/coord.db`, WAL mode.
- **What it stores:** repos; tasks (status, agent, model, branch, worktree path, session id, base, PR number/url, cost/tokens, timestamps); an append-only event log (`seq`, task id, time, payload); permission requests (pending/answered); check runs.
- **Event sequence.** The event bus's `seq` continues from the stored maximum after a restart, so clients can later ask for events since a `seq` (Phase 4 relay replay).
- **Lifecycle.** Schema migrations are versioned and run on daemon start. The exact table layout and event retention are left to the builder.
- **One daemon per `COORD_HOME` (my call).** On start, the daemon takes a lock file (`<COORD_HOME>/daemon.lock`, holding its PID and port). A second daemon on the same home refuses to start with a clear message. Running a second instance (e.g. developing Coord with Coord) means setting both `COORD_PORT` and `COORD_HOME`; AGENTS.md will say so.

## 10. Agents

The adapter interface (`AgentAdapter`/`AgentRun` in `@coord/protocol`) keeps its behavior. It may gain **additive** fields, my call. Additions:

- `TaskSpec` gets a permission mode and extra environment (`COORD_PORT_BASE`);
- `resume()` gets the same options;
- the adapter maps a user interrupt to `done`.

Also in Phase 1, both deferred from the skeleton review (PRD §13):

- **Claude cost** from the SDK's `modelUsage`, which includes subagents and cache tokens, instead of main-loop `usage`;
- **subagent events** carry an optional `parentToolUseId`, so the Live tab nests them under the tool call that started them.

**Claude Code:** `@coord/adapter-claude-code`, already built and tested (Agent SDK, `settingSources` always loaded, permission bridge, streaming input for `send`, `interrupt`, `end`).

**Codex (decided: via `codex app-server`, full parity):** a new package `@coord/adapter-codex` (type `adapter`, platform `node`).

| Our interface               | Codex app-server (JSON-RPC over stdio)                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| start / resume              | `thread/start` / `thread/resume`, then `turn/start`                                                                                                                                   |
| `send` (mid-turn)           | `turn/steer`                                                                                                                                                                          |
| `interrupt`                 | `turn/interrupt`                                                                                                                                                                      |
| permission prompt           | server requests `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` (and `item/tool/requestUserInput` for agent questions) |
| allow / always allow / deny | `accept` / `acceptForSession` / `decline` (`cancel` on interrupt)                                                                                                                     |
| events                      | item and turn notifications → `AgentEvent` (text, tool_call/tool_result for commands and file changes, usage, done, error)                                                            |
| cost                        | tokens only → `capabilities.costReporting = false`; the UI shows tokens                                                                                                               |

- **Process model.** One `codex app-server` process per task (my call: isolation and simple cleanup).
- **Pinning.** The `@openai/codex` version is pinned exactly in the adapter package. TypeScript types come from the protocol schema OpenAI publishes for that version: vendored, or generated in a script. Parts of the protocol are marked experimental, so the adapter uses only what it needs, and contract tests (§13) catch drift on upgrade.
- **Repo setup.** Codex reads `AGENTS.md` natively. Giving Codex the neatcode MCP server is the separate `neatcode codex install` work (in the neatcode repo, after this design).

**Choosing the agent and model.** Per task. Model default = the agent's own configuration; the form lists a model only when the user picks one.

## 11. Daemon API and protocol additions

All additive, following AGENTS.md rule 2. Every route keeps token auth and the protocol header.

| Area        | Additions                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repos       | list, add (path), get, update config cache                                                                                                                                                                         |
| Tasks       | create (repo, prompt, agent, model?, branch?, base?, permission mode?), list (by repo, include closed?), get, message (follow-up), interrupt, cancel, discard, resume, run checks, update branch, open PR (draft?) |
| Permissions | answer (allow / always / deny, optional reason or updated input)                                                                                                                                                   |
| Events      | `task.updated` (exists), `agent.event` (exists; now persisted), `permission.requested` / `permission.resolved`, `checks.updated`                                                                                   |
| Schemas     | `Repo`, `RepoConfig`, `CheckResult`, `PermissionRequestView`, extended `Task` (base, prNumber, prUrl, tokens, checks summary)                                                                                      |

The **CLI** gets `coord repo add|ls`, `coord new --agent codex|claude-code [--model] [--branch]`, `coord ls`, `coord show <id>`, `coord pr <id>`. The **MCP server**'s `create_task` gains `agent` and `model`.

## 12. Package layout

All new packages are created with the generator (§AGENTS):

| Package                   | Type / platform | Responsibility                                                                                                                              |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `@coord/task-store`       | service / node  | SQLite: repos, tasks, events, permissions, checks; migrations                                                                               |
| `@coord/worktree-manager` | service / node  | git: fetch, worktree create/remove, branch, auto-commit, push, ahead/behind, merge-base update; env-file copy and setup runner; port blocks |
| `@coord/github`           | service / node  | `gh` wrapper: availability/auth check, PR create (incl. draft), PR status                                                                   |
| `@coord/checks`           | service / node  | runs configured checks and neatcode in a worktree; results                                                                                  |
| `@coord/adapter-codex`    | adapter / node  | Codex app-server adapter                                                                                                                    |
| `@coord/core` (existing)  | daemon          | composition root, the task runner (state machine, queue, concurrency), routes, event persistence                                            |

New boundaries need no rule changes: services are `type:service`, so apps can't import them.

## 13. Testing

Each package's tests run in `pnpm check` and CI:

- **worktree-manager and checks:** against real git repos in temp directories, including a temp bare "origin" for push and fetch.
- **task-store:** against a temp SQLite file, including a migration test.
- **github:** behind a small command-runner interface with a fake `gh`.
- **The runner in core:** the full loop with a **fake adapter** (scripted events, a permission request, a turn end) plus real git and SQLite, through create → running → needs_input → review → pr_open → merged → cleanup. Also restart recovery (`interrupted` → resume) and "never lose work" cases (a cleanup refused when unpushed commits exist, discard keeping the branch).
- **Adapter contract tests:** run against the real `claude` and `codex` binaries when credentials are present. CI has none, so they're skipped there and run locally before upgrading either agent.
- **Desktop:** UI components tested with jsdom like `ui-web` today, plus the existing manual smoke runbook (launch Electron, read the DOM through DevTools).

## 14. Suggested order (left to the plan)

1. task-store + worktree-manager + runner with the Claude adapter, driven from the CLI end to end (auto-commit, restart recovery).
2. Board, panel and New task form in `ui-web` (desktop + local PWA), and notifications.
3. Checks + GitHub PR flow + PR tracking + cleanup.
4. Codex adapter on app-server.

## 15. Left to the builder

- **Storage:** the exact SQL schema and indexes, and event retention and size limits.
- **UI:** styling details within the mockups, the diff rendering library, and the slug algorithm.
- **Git and commands:** the exact git commands, and output truncation limits.
- **Codex:** how the Codex schema types are obtained, as long as they're pinned to the Codex version.
