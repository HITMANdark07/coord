# Phase 1 plan 2: acceptance run of the board with real Claude Code

Date: 2026-10-27. Branch `phase-1/desktop-board`, HEAD `418e3b2`. Manual run of Task 9. No source file was modified.

## Environment

- Claude Code (real) via the daemon, git, Node 20.20.2 system / pnpm-pinned Node 24.22.1 for the daemon.
- Isolated state, exported for every command: `COORD_HOME=<scratchpad>/acceptance-p2/home`, `COORD_PORT=4649`. The real `~/.coord` and port 4545 were not used.
- Scratch repo `acceptance-p2/scratch` cloned from the local bare `acceptance-p2/remote.git`; `init` (ca196a6) on `main`.
- Daemon, `pnpm web` (port 5173 was free beforehand) and `pnpm desktop` ran in the background with output in log files. The daemon token was never written to the log or to screenshot names; the `coord web` link lived in a scratchpad file and was loaded by script.
- Browser: the Playwright MCP browser was locked by another session's profile, so the PWA was driven with the same Playwright library (Chromium headless shell 1248, own profile, CDP port 9333) through small node scripts. Screenshots are in `acceptance-p2/shots/` (`01-` to `26-`).
- Electron was launched as `pnpm desktop -- --remote-debugging-port=9229` and driven over CDP (`connectOverCDP`). Its renderer used vite port 5174 (5173 was held by `pnpm web`). The first attempt with `--remoteDebuggingPort` (electron-vite's camel-case flag) was passed to the app as a plain argument and opened no debug port; the Chromium switch form works.
- Tasks used `Ask` mode only; nothing was bypassed. claude-mem reported "usage allowance exhausted" in the agent text again (noise, as in plan 1 D5).

## Step 1: set up — PASS

Daemon up on 4649, `pnpm web` up on 5173, `pnpm coord web` printed `http://localhost:5173/#token=<redacted>`. Opening it showed "Daemon connected · v0.1.0 · protocol 0.1.0" and "Add a repo to start" (shot 01). The fragment was stripped from the URL after load.

## Step 2: repo — PASS

Typed the scratch path into "Repo path" and pressed Add. The board appeared with the repo `scratch ▾`, "No tasks yet", `+ New task` and the columns Queued, Running, Needs you, Review, PR open, Merged (shot 02). Repo settings showed Path, Default branch `main`, Remote; there is no bypass checkbox on web (shot 04). The new task form (shots 05, 06) offers only "Ask (default)" and "Auto-accept edits" as permission modes; Codex is disabled ("not installed").

## Step 3: first task — PASS (hint note D2)

Task `5fa5680e`, "Create hello.ts exporting a function hello()...", Ask mode, Start task.

- Live tab showed `Status: queued, setting_up, running`, then `▸ Write <path>/hello.ts`, `needs_input`, and "Claude wants to use Write: ..." with `Allow`, `Always allow this session` and `Deny` (shot 08). `Allow` returned it to running (shot 09).
- Typed a follow-up while it was running ("Also add a goodbye() function...") and pressed Send. The panel always shows "Delivered when the current turn ends". The turn finished, a second turn started (one Edit permission, answered with Allow) and the task reached `review` with 2 commits: `c9f3de6 ... (turn 2)` on `34b7f03 ... (turn 1)` (shots 10-12).
- Diff tab: "1 file · +7 −0 · base origin/main", `hello.ts` with `hello` and `goodbye` (shot 13). Checks tab shows the placeholder "Checks run here once they're set up (coming next)" (shot 14).
- Discard: the first click turned the button row into `Discard` + `Keep` (inline confirm, shot 15); the second click cancelled the task. The card left the board, `coord ls --all` shows `cancelled`, the worktree directory was removed, branch `agent/create-hello-ts-...` remained in scratch, `main` was untouched, nothing was pushed (shot 16).

## Step 4: second task, interrupt, restart — PARTIAL

- Task (`one.ts` to `four.ts`, one at a time, Ask): answered the first Write with `Always allow this session`, then `Interrupt`. Live showed `Turn finished — Interrupted by user`, `Status: review`, 1 commit (shots 17, 18). PASS.
- Daemon killed with SIGINT to its pid (from `daemon.lock`); it exited. The open board showed "Daemon unreachable: GET /health failed (502)" and "Could not load tasks ... (502)" (shot 19). Restarted with `pnpm daemon` (`recovered 0 tasks`).
- Without a reload the board then showed "Daemon connected" together with "Could not load repos: GET /repos: missing or wrong daemon token" and never recovered (shot 20). The daemon token is per start by design (PRD: random per-start token), so the old page's token is dead. See D1.
- After opening a fresh `pnpm coord web` link, the board loaded, the task was still in Review, and its Live tab showed the same 9 events as before the restart: no duplicates (shot 21). A same-URL navigation that differs only in the fragment does not reload the page, so the new link has to be opened as a real navigation.

## Step 5: desktop — PASS (driven over CDP, not by hand)

- Board loaded in Electron with the same tasks (the interrupted task in Review) and "Daemon connected" (shot 22). Via CDP, `Notification.permission` in the renderer is `granted`.
- Repo settings shows the checkbox "Allow bypass mode for this repo" with its warning text (shot 23). It was not toggled. The repo menu has an `Add repo` button.
- Folder picker: clicking `Add repo` opened a native macOS open-panel sheet attached to the Coord window ("Open" / "Cancel", shot 26, a full-screen capture). It was not clicked; it closed when Electron was stopped.
- Notifications: a `Notification` wrapper installed in the renderer recorded two constructions for a new task: "Needs you: Create a.ts ..." (body "Waiting for your answer") and "Ready for review: Create a.ts ..." (body "1 turn"). So the app fires them. That the OS actually displayed the banner was not observed (macOS notification display was not checked).

## Defects / follow-ups

- **D1 (medium, web):** after a daemon restart the open PWA shows "Daemon connected" but every data call fails with "missing or wrong daemon token", with no recovery or hint. Repro: open the board, SIGINT the daemon, start it again. Expected: a clear "reconnect: run `pnpm coord web` for a new link" message (or re-reading the token), and no "connected" banner while requests are rejected with 401. The old health-only banner is misleading. Shot 20.
- **D2 (low, web UX):** "Delivered when the current turn ends" is shown at all times, including when the task is idle or in Review, and the follow-up message does not appear in the Live feed after Send. Hard to tell that the message was accepted. Shots 10, 12.
- **D3 (low, observation):** after Discard the detail panel stays open on the cancelled task (and its Live/Diff/Checks tabs); the card is gone from the board. Probably fine, but a close or "Discarded" notice would be tidier. Shot 16.
- **D4 (not verified):** the web header `Enable notifications` button was not seen. The headless browser reports `Notification.permission` as `denied`, where the button is expected to be hidden. A manual check in a normal browser (permission `default`) is needed.
- **D5 (note):** `pnpm desktop -- --remote-debugging-port=9229` is the way to expose the renderer; worth a line in AGENTS.md if automation is wanted.
- Environment: the Playwright MCP browser profile was in use by another session; the run used the Playwright library directly.

## Summary

| Step | Description                                           | Result  |
| ---- | ----------------------------------------------------- | ------- |
| 1    | daemon, `pnpm web`, `coord web` link                  | PASS    |
| 2    | add repo, no bypass on web                            | PASS    |
| 3    | task, Live, Allow, follow-up (turn 2), Diff, Discard  | PASS    |
| 4    | interrupt to Review; daemon restart and reconnect     | PARTIAL |
| 5    | desktop: board, settings bypass, picker, notification | PASS    |
| 6    | log, README quick start, commit                       | PASS    |
