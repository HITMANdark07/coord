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
