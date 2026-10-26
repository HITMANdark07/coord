# Coord Phase 1: plan index

**Spec:** [docs/superpowers/specs/2026-10-26-phase-1-design.md](../../docs/superpowers/specs/2026-10-26-phase-1-design.md) (approved 2026-10-26)

Phase 1 is split into four plans, executed in order. Each produces working, tested software. A plan is written only once the previous one has landed, so it can name the real interfaces instead of guessing them.

| #   | Plan                                                        | Delivers                                                                                                                                                                                                 | Status       |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1   | [Core loop](2026-10-26-phase-1-plan-1-core-loop.md)         | SQLite store, worktrees, task runner with Claude Code, daemon API, CLI end to end (create, watch, permissions, follow-ups, diff, discard, restart recovery)                                              | In PR #1     |
| 2   | [Desktop board](2026-10-26-phase-1-plan-2-desktop-board.md) | Board + Merged column, task panel (Live / Diff / Checks), New task form, notifications, repo settings (bypass opt-in) in `ui-web` (desktop + local PWA)                                                  | Written      |
| 3   | Checks and pull requests                                    | `checks` and `github` services, `checking` / `pr_open` / `merged` / `closed` statuses, staleness and update branch, PR create (draft on failure), PR tracking, cleanup with the "never lose work" guards | After plan 2 |
| 4   | Codex adapter                                               | `adapter-codex` on `codex app-server`, permission-mode mapping, contract tests                                                                                                                           | After plan 3 |

After plan 4: the acceptance run from the spec's definition of done, then the packaging phase.
