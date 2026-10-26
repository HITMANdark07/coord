# Phase 1 plan 1: acceptance run with real Claude Code

Date: 2026-10-26. Branch `phase-1/core-loop`, HEAD `dcb6e4d`. Manual run of Task 11.

## Environment

- System node v20.20.2 (the daemon ran under pnpm's pinned Node 24.22.1), git 2.53.0, Claude Code 2.1.310.
- Isolated state: `COORD_HOME=<scratchpad>/acceptance/home`, `COORD_PORT=4646` exported for every daemon and CLI command. The real `~/.coord` and port 4545 were not used.
- Worktrees therefore landed under `$COORD_HOME/worktrees/scratch-<uuid>/<branch-slug>`, not `~/.coord/worktrees`.
- Scratch repo: `acceptance/scratch` cloned from the local bare `acceptance/remote.git`, with `package.json`, `tsconfig.json` and `README.md` pushed as `init` (4637af8) on `main`.
- Daemon run in the background via `pnpm daemon`; the daemon pid came from `daemon.lock`. The token was never printed.
- All tasks used `--permission ask` (default). Permissions were answered with `coord allow`.
- Side note: claude-mem (a user plugin loaded through `settingSources`) reported "five-hour usage allowance exhausted" in the agent's final message each turn. It did not block the runs.

## Step 1: scratch repo, daemon, repo add — PASS

```
pnpm coord status        -> daemon 0.1.0 · protocol 0.1.0
pnpm coord repo add <scratch> -> added scratch (<path>)
pnpm coord repo ls       -> scratch  <path>
```

## Step 2: new task and watch — PASS

`pnpm coord new "Add a hello() function in hello.ts that returns 'hello', plus a small hello.test.ts using node:test. Do not install anything." --repo <scratch>` gave `created a86ac14f (setting_up)`.
Status went queued, setting_up, running, needs_input, running, review. The worktree was under `$COORD_HOME/worktrees/...` on branch `agent/add-a-hello-function-in-hello-ts-that-re`. One commit, `... (turn 1)`. `coord diff` showed `hello.ts` and `hello.test.ts`. Usage 143329 in / 1743 out, $0.3628, 1 turn.

## Step 3: permission prompts — PASS (with defect D1)

- `coord watch` printed `permission fb8bc8b6-...: Write` and `needs_input`. `coord allow fb8bc8b6` (prefix) failed:
  `POST /permissions/fb8bc8b6: permission fb8bc8b6 not found` (rc=1). The full id worked: `allowed fb8bc8b6-...`. See D1.
- A second prompt (Bash) was answered with `coord allow <id> --always` -> `allowed <id> (always)`. The task reached review.
- Second task `25f7fef4`: "Run the shell command 'node --version' and write its output into node-version.txt". One Bash permission, allowed, task reached review. `coord diff` showed `node-version.txt` containing `v24.22.1`.

## Step 4: coord msg — PASS (note D2)

`coord msg a86a "also export it from index.ts"` -> `sent to a86ac14f (running)`. The task went back to running, hit permission prompts (answered) and returned to review. `git log` in the worktree showed `0804736 ... (turn 2)` on top of `d9d64d9 ... (turn 1)`. `coord diff` showed `hello.ts`, `hello.test.ts` (extended) and `index.ts` (`export { hello } from './hello.ts'`).
Turn 2 asked for 5 permissions in total (Write and Bash). Two of the Bash prompts came after the `--always` grant in turn 1; the "always" rule is probably per command pattern, but the CLI does not show the command, so this was not verifiable (D2).

## Step 5: SIGINT mid-turn, restart, resume — PASS

- Task `c90f0dfb` (create goodbye.ts + test) reached `needs_input` (a Write permission pending, so mid-turn). `kill -INT <daemon pid>`. The daemon exited within about 3 s and removed `daemon-4646.json` and the lock. The event log shows `permission ...: withdrawn` then `status: interrupted`.
- Restarted with `pnpm daemon`. The log said `recovered 0 tasks from the previous run` (the task was already marked interrupted at shutdown). `coord show c90f` -> `status: interrupted`.
- `coord resume c90f` -> `c90f0dfb running`. After 3 permission prompts the task reached review. One commit `... (turn 1)` with `goodbye.ts` and `goodbye.test.ts`. The agent's summary noted that its first write attempt was cut off.

## Step 6: discard — PASS

Before: scratch `git status` clean, HEAD 4637af8, on `main`.
`coord discard a86a` -> `a86ac14f cancelled` (rc=0). After:

- the worktree directory was gone and `git worktree list` no longer listed it;
- branch `agent/add-a-hello-function-in-hello-ts-that-re` remained with both commits (`0804736`, `d9d64d9`);
- the scratch checkout was untouched (clean status, still on `main` at 4637af8);
- `coord ls` hides the task, `coord ls --all` shows it as `cancelled`;
- the bare remote has only `main` (nothing was pushed).

## Step 7: log and commit

This file, committed as `docs: plan 1 acceptance run`. The daemon was stopped by SIGINT to its pid (28731), which exited. The pnpm wrapper processes exited with it. Remaining task worktrees live only under the temp `COORD_HOME`.

## Defects / follow-ups

- **D1 (CLI):** permission ids do not accept a prefix, although task ids do. Command: `pnpm coord allow fb8bc8b6` (short id copied from `coord watch`). Output: `POST /permissions/fb8bc8b6: permission fb8bc8b6 not found`. Expected: resolve a unique prefix as `coord show` and task commands do, or print short ids that work. Workaround: use the full uuid.
- **D2 (CLI/UX):** `coord show` and `coord watch` list a pending permission as only `<id>  Bash` or `Write`, with no command, file path or tool input, so a user cannot make an informed allow/deny. It also gives no sign of which prompts `--always` covered. Expected: show the title or input summary and whether "always" is available (`canRemember`).
- **D3 (minor, observation):** `coord watch` prints `tool: Bash` lines before the matching `permission ...` line, and `coord show` for a finished task has a "recent events" list but no per-turn cost. Cosmetic only; no action needed unless the UX is revisited.
- **D4 (observation):** after SIGINT, startup printed `recovered 0 tasks`, because shutdown had already marked the task `interrupted`. This is correct behavior. A hard kill (SIGKILL) path was not exercised; recommend a follow-up run for the `recovered N tasks` path.
- **D5 (environment):** user-level settings and plugins (claude-mem, skills) load into the agent through `settingSources: ["user", ...]`, so the agent turns included unrelated Skill/MCP activity and a claude-mem usage warning in the output. This is by design (Architecture rule 7) but adds cost and noise: $0.36 for a trivial turn.

## Summary

| Step | Description                          | Result |
| ---- | ------------------------------------ | ------ |
| 1    | scratch repo, daemon, repo add       | PASS   |
| 2    | new + watch, reaches review          | PASS   |
| 3    | allow (+ --always), shell task       | PASS   |
| 4    | msg, turn 2 commit, diff             | PASS   |
| 5    | SIGINT, restart, interrupted, resume | PASS   |
| 6    | discard keeps branch, repo clean     | PASS   |
| 7    | log + commit                         | PASS   |

# Run 2 — live messages, interrupt, cancel (post-final-review)

Date: 2026-10-26. Branch `phase-1/core-loop`, HEAD `cd50bda` (includes the final-review fixes). Real Claude Code again; no source file was modified.

## Environment

- Isolated state: `COORD_HOME=<scratchpad>/acceptance2/home`, `COORD_PORT=4647`, exported for every command. `~/.coord` and port 4545 were not used.
- Scratch repo `acceptance2/scratch` cloned from the local bare `acceptance2/remote.git`; `init` (e5bc7ae) on `main`.
- Daemon started in the background with `pnpm daemon`, output in `acceptance2/daemon.log`; pid 11583 came from `daemon.lock`. The token was never printed.
- Task A used `--permission accept_edits` (Bash prompts answered with `coord allow`). Task B used `--permission ask`. Task C used `accept_edits`. Nothing was bypassed.

## A. Live mid-turn message — FAIL

Task `d36aef86`: `coord new "Create files a.ts, b.ts, c.ts each exporting a function ... plus a test.ts using node:test ..." --permission accept_edits`. While `running` (0 turns, no events yet):

```
coord msg d36a "Also add a d.ts exporting a function d that returns its name, and add it to test.ts."
sent to d36aef86 (running)
```

- The agent saw the message inside turn 1: its summary says "and the `d.ts` you added partway through". The worktree has `d.ts`. Only ONE commit was made, `fa8c55d ... (turn 1)`, so the expected `(turn 1)` + `(turn 2)` pair did not appear for this message.
- After the `done` event (about 21:46:50) the status stayed `running` and the last event was `status: running` (after `done`). At 21:52:50 (6 min with no new events) it was still `running`, 1 turn, $0.2305. Verdict FAIL by the 5-minute rule (see D1).
- Extra probe: a second `coord msg d36a "Also add an e.ts ..."` while stuck in `running` started a real turn (one Bash permission, allowed), added `e.ts`, and committed `5571d2c ... (turn 2)` on top of `fa8c55d`. Usage went to 2 turns. The task again stuck in `running` after `done` (checked 21:57:22, 4 min with no new events). Task cancelled afterwards.

## B. Interrupt — PASS

Task `8e604488` (`--permission ask`, create one.ts..four.ts one at a time). A Write prompt was answered with `coord allow 3ba2 --always` (4-char prefix). After more `tool: Write` events, `coord interrupt 8e604488` (rc=0). Within 5 s:

```
status: review
  done: Interrupted by user
  status: review
31fc3d3 Create files one.ts, two.ts, three.ts, four.ts each exportin (turn 1)
```

Worktree status clean; `one.ts`, `two.ts`, `three.ts` committed (the in-progress edits were kept).

## C. Cancel from running — PASS

Task `8a7266a5` (`accept_edits`, p1.ts..p5.ts). After the first `tool: Write` event, `coord cancel 8a72` (rc=0) -> `cancelled`.

- Worktree directory removed; `git worktree list` no longer shows it.
- Branch `agent/create-files-p1-ts-p2-ts-p3-ts-p4-ts-p5` kept, with `db098be ... (turn 1)` containing `p1.ts`, `p2.ts`.
- Re-checked 35 s later: same single commit, tree unchanged (`p1.ts`, `p2.ts`), no new edits, worktree path still absent.
- Process check: no `claude --stream-json` process had a cwd in a coord worktree (`lsof -d cwd`); the only claude processes left belong to claude-mem's own observer sessions. `ps aux | grep -c create-files-p1` gave 0.
- Cancelling `d36aef86` (task A, stuck in `running`) also worked: `cancelled`, worktree removed, branch kept with both turn commits.

## D. Cost accumulation — PASS (turn 2 was only reached by the extra probe)

For task A: after turn 1, `coord show` gave `96839 in / 1908 out tokens · $0.2305 · 1 turns`. After turn 2 (the second message): `168486 in / 2884 out tokens · $0.2807 · 2 turns`. Cumulative, not reset. Caveat: the turn 2 here is the `e.ts` probe message, not the original mid-turn message from item A.

## E. Permission prompt display — PASS

- `coord show` now lists `<id>  Bash  node --test test.ts  [--always available]` and `<id>  Write  <full file path>  [--always available]` (the path is truncated with an ellipsis in the long-path case). The event list shows the same text. `coord allow f392` (4-char prefix) worked (`allowed f3923d9c-...`); `coord allow 3ba2 --always` printed `allowed 3ba2768f-... (always)`; earlier D1 and D2 are fixed.

## Defects

- **D1 (runner, high):** a message sent with `coord msg` while the task is `running` leaves the task stuck in `running` after the turn ends. Command: `coord new ... --permission accept_edits`, then `coord msg d36a "Also add a d.ts ..."` while `running`. Observed: the agent absorbed the message in turn 1, committed once, emitted `done`, and then no further event; status stayed `running` for 6+ minutes (no `review`). Expected: one commit per turn (`turn 1` and `turn 2`) and status `review` once all queued messages are handled. The same stuck state repeated after the second message. A further `coord msg` is processed, so the runner is not dead, but nothing moves the task to `review` by itself. Likely cause: the runner counts the live message as a pending turn that the SDK never reports separately; needs investigation (not fixed here).
- **D2 (runner, medium):** with a live mid-turn message the SDK folds it into the current turn, so the "message runs as its own turn" expectation does not hold (one commit, 1 turn). Needs a product decision together with D1: either accept the folding and finish the turn, or hold the message until `done`.
- **D3 (minor):** pending Write prompt titles with long paths are truncated by the CLI and so show only the start of the temp path, not the file name. Suggest showing the path relative to the worktree.

## Summary

| Item | Description                                                 | Result |
| ---- | ----------------------------------------------------------- | ------ |
| A    | live mid-turn msg: 2 commits, then review                   | FAIL   |
| B    | interrupt -> review, edits committed                        | PASS   |
| C    | cancel from running: worktree gone, branch kept, no orphans | PASS   |
| D    | cost cumulative after turn 2                                | PASS   |
| E    | permission prompt shows command/path/--always               | PASS   |

Cleanup: the daemon was stopped with SIGINT to pid 11583 and exited within 1 s. Task `8e604488` (review) left its worktree under the temp `COORD_HOME`.

# Run 3 — turn-boundary messages (post-residual-fix)

Date: 2026-10-26. Branch `phase-1/core-loop`, HEAD `6da6319`. Real Claude Code; no source file was modified.

## Environment

- Isolated state: `COORD_HOME=<scratchpad>/acceptance3/home`, `COORD_PORT=4648`, exported for every command. `~/.coord` and port 4545 were not used.
- Scratch repo `acceptance3/scratch` cloned from the local bare `acceptance3/remote.git`; `init` (12bdddc) on `main`.
- Daemon started in the background with `pnpm daemon`, output in `acceptance3/daemon.log`; pid 18597 came from `daemon.lock`. The token was never printed.
- All tasks used `--permission accept_edits`; Bash prompts were answered with `coord allow`. Nothing was bypassed.
- Note: `pnpm coord new` ran from a wrapper script resolves the repo from `INIT_CWD`, which `pnpm --filter` overwrote, so the tasks were created with `--repo <scratch>`.

## A1. Single live message — PASS

Task `6a7295bc`: create a.ts, b.ts, c.ts plus test.ts and run the test. While `running`:

```
coord msg 6a72 "Also add a d.ts exporting a function d that returns its name, and add it to test.ts."
sent to 6a7295bc (running)
```

- Turn 1 ended with a `done` event (the summary mentions only a, b, c) and the task stayed `running`; the queued message started turn 2 (a second Bash permission, answered with `coord allow 2c10`). `done` for turn 2 said "I added `d.ts` ... all 4 passed", then `status: review`. No stuck state; the whole run took about 50 s.
- Commits on the task branch: `746e3fe ... (turn 1)` (a.ts, b.ts, c.ts, test.ts) and `beb8a7f ... (turn 2)` (d.ts, test.ts +5 lines).
- Session: the task row keeps one `session_id` (`6b65b77f-...`) and turn 2 knew turn 1's files, so it resumed the same session. The id is not shown by `coord show`; it was read from `coord.db`.

## A2. Two live messages in one turn — PASS

Task `606deebd` (create e1.ts..e3.ts). While `running`: `coord msg` for f.ts, then `coord msg` for g.ts (both `sent ... (running)`).

- Events: `done` (turn 1), `status: running`, one `done` that mentions both `f.ts` and `g.ts`, `status: review`. Usage `2 turns`.
- Commits: `c512ea9 ... (turn 1)` (e1..e3) and ONE `770ef44 ... (turn 2)` (f.ts and g.ts).

## A3. Message then interrupt — PASS

Task `3cef906d` (create h1.ts..h5.ts). While `running`: `coord msg 3cef "Also add z.ts ..."` then `coord interrupt 3cef` (rc=0). Within 3 s:

```
status:   review
usage:    1208 in / 20 out tokens · $0.0001 · 1 turns
error:    Not sent: "Also add z.ts exporting a function z that returns its name."
  done: Interrupted by user
  status: review
```

Still `review`, 1 turn, after another 20 s (no turn 2). The interrupt landed before any file was written, so there was nothing to commit (branch at `init`).

## A4. Cost — PASS

Task `6a7295bc`: after turn 1 (caught in `running` between turns) `231629 in / 1520 out tokens · $0.2491 · 1 turns`; at `review` `339244 in / 2742 out tokens · $0.3113 · 2 turns`. Cumulative. Task `606deebd` at review: `194479 in / 1503 out · $0.2367 · 2 turns`.

## A5. Permission display — PASS

`coord show` with the pending prompt: `67e6c31d-...  Bash  node --test test.ts  [--always available]` followed by the JSON input (command and description). `coord allow 67e6` echoed `allowed 67e6c31d-...: Bash node --test test.ts`. Only Bash prompts appeared (Write is auto-accepted under `accept_edits`), so the Write path/file-name display (D3 of run 2) was not re-checked.

## Defects

None new. Minor observation: between turns the task shows `status: running` with 1 turn and a `done` event already emitted; that is the intended hand-off but a client cannot tell it from a finished turn except by the later events.

## Summary

| Item | Description                                         | Result |
| ---- | --------------------------------------------------- | ------ |
| A1   | one live msg: turn 1 + turn 2 commits, then review  | PASS   |
| A2   | two live msgs: one turn 2 (one commit), then review | PASS   |
| A3   | msg then interrupt: review, `Not sent`, no turn 2   | PASS   |
| A4   | cost cumulative                                     | PASS   |
| A5   | permission display and allow echo (Bash)            | PASS   |

Cleanup: the daemon was stopped with SIGINT to pid 18597 and exited within 3 s.
