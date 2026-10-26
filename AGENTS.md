# Coord — agent instructions

An app that runs coding agents (Claude Code first) in parallel git worktrees, controlled from a desktop app, a mobile app and an installable web app. Product spec: [docs/PRD.md](docs/PRD.md). Read the relevant PRD section before building a feature.

## Commands

Run all commands from the repo root. pnpm runs scripts with the Node version pinned in `.npmrc` (24 LTS), whatever your system Node is.

| Task                                        | Command                                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Install (also after `git worktree add`)     | `pnpm install`                                                                                                                            |
| **Definition of done**                      | `pnpm check`: lint, typecheck, test and build for every project, a format check, and the neatcode rules (`pnpm conventions`)              |
| One project                                 | `pnpm exec nx run-many -t lint typecheck test build -p @coord/<name>`                                                                     |
| Format                                      | `pnpm format`                                                                                                                             |
| New library package                         | `pnpm exec nx g @coord/workspace-plugin:library <name> --type=<lib\|state\|ui\|adapter\|service> --platform=<any\|node\|react\|dom>`      |
| Project graph                               | `pnpm graph`                                                                                                                              |
| Run daemon / desktop / web / mobile / relay | `pnpm daemon`, `pnpm desktop`, `pnpm web`, `pnpm mobile`, `pnpm relay`                                                                    |
| Daemon and desktop with watch mode          | `pnpm dev`                                                                                                                                |
| CLI                                         | `pnpm coord status`, `pnpm coord ls`, `pnpm coord new "<prompt>"`, `pnpm coord web` (link that opens the web app connected to the daemon) |

A task is not done until `pnpm check` passes. Don't skip, weaken or delete a check to make it pass.

**Never bypass the git hooks.** Don't use `git commit --no-verify`, `git push --no-verify` or `SKIP_SIMPLE_GIT_HOOKS`. If a hook fails because a worktree has no `node_modules`, run `pnpm install` there. Every git worktree of this repo needs its own `pnpm install`.

**Running more than one daemon** (e.g. one per worktree): set `COORD_PORT`. The daemon, CLI, MCP server, desktop app and web dev proxy all read it; the default is 4545. `COORD_HOME` (default `~/.coord`) is where the daemon writes its token file, `daemon-<port>.json`.

## Layout

`apps/` holds runnable programs (`type:app`) and `packages/` holds libraries. The invariants test enforces this.

```
apps/desktop        Electron shell. Main starts the daemon and bridges IPC; renderer mounts @coord/ui-web
apps/web            Installable PWA (Vite + vite-plugin-pwa); mounts @coord/ui-web
apps/mobile         Expo React Native app (see apps/mobile/AGENTS.md for Expo rules)
apps/relay          WebSocket relay between the daemon and remote clients
apps/cli            the `coord` command
apps/mcp-server     MCP server so Claude Code can drive the orchestrator
packages/protocol   zod schemas and types: the contract between every part
packages/client     typed daemon client over a pluggable Transport (request + subscribe)
packages/local-daemon   Node: find the local daemon and its auth token (token file, localTransport)
packages/app-state  React hooks shared by every UI (no DOM, no React Native APIs)
packages/ui-web     React DOM screens shared by desktop and web
packages/design-tokens  colors, spacing, type: shared by every UI
packages/core       the daemon (Fastify on 127.0.0.1): HTTP API, /events WebSocket, tasks
packages/adapter-claude-code  Claude Agent SDK adapter
packages/tsconfig   shared tsconfig presets: base, node, react, dom
tools/workspace-plugin  Nx generators, plus the repo-wide invariants test
tools/neatcode-check.mjs  runs the neatcode rules as part of `pnpm check`
.neatcode/          neatcode: repo graph, conventions (skills.yaml), decisions, notes
```

## neatcode: repo knowledge and conventions

[neatcode](https://www.npmjs.com/package/@neatcodeai/cli) indexes this repo into a graph and holds its conventions in `.neatcode/skills.yaml`. Its MCP server (`neatcode-mcp`) gives you structural tools. Nx and ESLint enforce package boundaries at lint time; neatcode lets you check a plan against the repo's rules _before_ you write it.

- **Start of a session:** call `get_repo_overview`.
- **Exploring code:** use `query_graph`, `find_node`, `trace_flow` and `get_source` instead of grepping the repo.
- **Before writing or editing files:** call `validate_diff` with the planned files. If it reports a violation, change the plan. Record an exception (`neatcode exception add`) or supersede a rule only when the user explicitly agrees.
- **When the user states a rule** ("never…", "always…", "must…"): call `propose_rule_from_prompt`, show the user the result, and accept it only with their confirmation.
- **Facts the user shares** about the project: save them with `add_note`.
- **Changing an architecture rule:** the boundary rules exist in three places that must agree:
  - the `depConstraints` in `eslint.config.mjs`;
  - the tables in this file;
  - the `import-forbidden` rules in `.neatcode/skills.yaml`.

  Each neatcode boundary is a pair: `-by-path` matches imports neatcode resolved to a file, and `-by-name` matches unresolved package names.

- **Mined conventions:** `pnpm exec neatcode skills derive` proposes conventions from the code. Accept only real conventions (`skills accept`). Reject candidates that come from a few incidental files (`skills reject --reason`).

Generated and local state is git-ignored: `graph.db`, `skills.candidates.yaml`, `skills.local.yaml` and `mcp.log`. `skills.yaml`, `skills.rejected.yaml`, `decisions.yaml`, `REPO_OVERVIEW.md` and `memory/` are committed and code-reviewed. Run neatcode through pnpm (`pnpm exec neatcode …`), because its native SQLite module is built for the Node version this repo pins.

## Rules enforced by lint and tests (they fail `pnpm check`)

Every project's `package.json` has `nx.tags` with exactly one `type:` and one `platform:` tag. `@nx/enforce-module-boundaries` in `eslint.config.mjs` decides what may import what:

| A project tagged…                                                  | may import projects tagged…                                     |
| ------------------------------------------------------------------ | --------------------------------------------------------------- |
| `type:contract` (protocol)                                         | nothing internal                                                |
| `type:lib` (client, local-daemon, design-tokens)                   | contract, lib                                                   |
| `type:state` (app-state)                                           | contract, lib                                                   |
| `type:ui` (ui-web)                                                 | contract, lib, state, ui                                        |
| `type:adapter` (adapter-claude-code)                               | contract                                                        |
| `type:service` (daemon internals: worktree manager, SQLite store…) | contract, lib, service                                          |
| `type:daemon` (core)                                               | contract, lib, adapter, service                                 |
| `type:app` (everything in apps/)                                   | contract, lib, state, ui. **Never daemon, adapter or service.** |
| `type:tooling`, `type:config`                                      | nothing internal                                                |

| `platform:`    | may import                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `any`          | any                                                                                                             |
| `node`         | node, any                                                                                                       |
| `react`        | react, any                                                                                                      |
| `dom`          | dom, react, any                                                                                                 |
| `react-native` | react-native, react, any                                                                                        |
| `electron`     | node, dom, react, any. The renderer and preload files may not import Node built-ins or `platform:node` packages |

**Cross-platform packages.** Every `platform:any` and `platform:react` package must run in Node, browsers and React Native. In their `src/`, lint bans:

- browser-only globals (`window`, `document`, `localStorage`…);
- Node globals (`process`, `Buffer`…, including `globalThis.process`);
- Node imports, static or dynamic (`node:*`).

The list of packages comes from the tags, so new packages are covered automatically.

If lint blocks an import, the design is wrong. Move the code to the right package, or go through `@coord/client`. Don't loosen the rules or add `eslint-disable` to get past them.

## Architecture rules

1. **Everything goes through `protocol`.**
   - Apps reach the daemon only through `@coord/client`.
   - Request, response, event and error shapes are zod schemas in `packages/protocol`, and `client` validates every response and pushed event.
   - Every request carries `PROTOCOL_VERSION` (header `x-coord-protocol`; `?protocol=` on the WebSocket). The daemon accepts the same major version with the current or previous minor, and answers 426 otherwise.
2. **Change the protocol without breaking phones,** which update days after the desktop.
   - **Additive changes need no version bump.** New optional fields, new event kinds, new statuses, new routes.
   - **Old clients must tolerate additions.** Unknown enum values parse to a fallback, e.g. `ReadTaskStatus` turns an unknown status into `"unknown"`. Unknown events are dropped.
   - **Breaking changes bump the minor version.** Renames, removals, changed meaning. The daemon must keep serving the previous minor's shapes until that minor is retired.
3. **Errors use one shape.** The daemon always replies with `ErrorBody { code, message }`. Clients get a `DaemonError` with `status` and `code` over every transport, including Electron IPC.
4. **Pushed events.**
   - The daemon publishes `DaemonEvent { seq, at, payload }` on its event bus and serves it at `/events`.
   - A client opens one event connection, shared by every subscriber.
   - UIs use `useLiveQuery` / `useTasks`: at most one load in flight, a reload on matching events and on reconnect, and polling only as a fallback.
5. **The daemon is a separate process.**
   - Apps never import `@coord/core`. Desktop spawns the daemon (an Nx `implicitDependencies` entry records this), and closing the window must not stop it.
   - Only `packages/core/src/main.ts` wires adapters and services together.
6. **Share screens only between React DOM apps.**
   - Desktop and web share `ui-web`. Mobile has its own screens but reuses `app-state`, `client`, `protocol` and `design-tokens`.
   - Each app chooses a Transport (HTTP, IPC, relay) and wraps its UI in `<ClientProvider>`.
7. **Claude Code is the top-priority integration.**
   - The adapter's `buildOptions` puts caller options first, then always sets the worktree `cwd`, `settingSources: ["user", "project", "local"]` (the repo's `CLAUDE.md`, hooks, MCP servers, skills) and the permission bridge.
   - A run is an `AgentRun`: events plus `send`, `interrupt` and `end`.
   - A `done` event ends a turn, not the session. Call `end()` when the task is over, or the Claude Code process keeps running.
   - `events` never throws: aborts and crashes arrive as an `error` event.
   - Permission prompts carry the `toolUseId`, `title` and `canRemember`. Answers can edit the tool input (`updatedInput`) or apply "always allow" (`remember`).
   - Never cut a Claude Code feature to fit a weaker agent; other agents declare what they can't do in `capabilities`.
   - A CLI fallback for Claude Code (PRD FR-10) belongs inside `adapter-claude-code`, which reuses `toAgentEvents`.
8. **Security defaults.**
   - **Daemon.** It listens on `127.0.0.1` and rejects a non-local Host (DNS rebinding) and any browser Origin not in its allowlist (`DEFAULT_ALLOWED_ORIGINS`, or `COORD_ALLOWED_ORIGINS`).
   - **Token.** Every route except `/health` needs the daemon's token. It's random per start and stored in `<COORD_HOME>/daemon-<port>.json`, mode 0600.
     - Node clients use `localTransport()` from `@coord/local-daemon`.
     - The web dev proxy only forwards; it never adds the token. Otherwise any local process could use the proxy.
     - Browsers get the token from the link `pnpm coord web` prints. It arrives in the URL fragment, is kept in `sessionStorage` for that tab, and is sent as a bearer header, or as a subprotocol on the WebSocket.
   - **Electron.** The renderer has no Node access (`sandbox`, `contextIsolation`). Its only channel is the IPC bridge, and the main process checks every request with `isDaemonRequest`.
   - **Relay.** It binds to localhost unless `RELAY_HOST` is set, and caps payload size, peers per room and total connections. Remote clients go through it, encrypted end to end (Phase 4).

## Conventions

- **Packages ship TypeScript source.** `exports` points to `./src/index.ts`, with no build step. The apps' bundlers (Vite, electron-vite, Metro) and `tsx` compile them. Vite and electron-vite config files can't import workspace TypeScript packages.
- **New library packages come from the generator,** never by copying a folder. New apps are rare: copy the nearest app and keep its scripts and tags.
- **Tests sit next to the code** as `*.test.ts(x)`.
  - Vitest everywhere, except `apps/mobile`, which uses `jest-expo` and React Native Testing Library.
  - Use `fakeTransport` from `@coord/client/testing` with `createClient()` instead of hand-written fake clients.
  - Each change adds or updates tests; a bug fix adds a test that fails without the fix. Check that a new test fails when you break the code it guards.
  - Wait on real signals (connection `onStatus`, `waitFor`), not fixed sleeps.
- **Validate untrusted input:** HTTP bodies, IPC messages and relay frames with zod schemas. The IPC request shape uses the stricter `isDaemonRequest` check.
- **File names are kebab-case.** Use named exports, except where a framework requires a default export (Expo `App`, Nx generators).
- **Comments say why, not what.** Reference the PRD (e.g. `PRD FR-30`) when code exists because of a requirement.
- **Versions.**
  - Runtime and tool dependencies are pinned exactly or with `~` (Expo's own pins). `^` is used only for `@types/node`.
  - There is one `react`/`react-dom`/`react-native` version across the repo; the invariants test checks this.
  - Ask before upgrading major versions.
  - In `apps/mobile`, add packages with `pnpm exec expo install <pkg>`.
  - Native modules (e.g. `better-sqlite3`) must be listed in `onlyBuiltDependencies` in `pnpm-workspace.yaml`, or pnpm skips their build.
- **Declare build-time environment variables** (e.g. `VITE_*`, `EXPO_PUBLIC_*`) in that project's Nx `inputs` (`{ "env": "NAME" }`), or Nx may serve a stale cached build.
- **Never edit by hand:** `pnpm-lock.yaml`, `apps/mobile/ios`, `apps/mobile/android`, build output (`dist`, `out`).
- **Never commit secrets.** `.env` files are git-ignored. Never log or print the daemon token. The `coord web` link is the one deliberate exception.
