# Worktree Orchestrator (`wto`)

Run several coding agents (Claude Code first) in parallel git worktrees on one repo, and steer them from your desktop, your phone, or an installed web app.

- Product spec: [docs/PRD.md](docs/PRD.md)
- Rules for contributors and coding agents: [AGENTS.md](AGENTS.md)

**Status:** Phase 0 skeleton. Every app and package builds, is tested and has enforced boundaries. Product features start in Phase 1.

## Requirements

- pnpm 10 (`corepack enable` picks the pinned version)
- Any Node ≥ 18 to start pnpm. pnpm downloads and uses Node 24.22.1 for this repo (`.npmrc`).
- macOS or Linux

## Quick start

```sh
pnpm install
pnpm check            # lint, typecheck, test, build every project

pnpm daemon           # start the daemon on http://127.0.0.1:4545
pnpm wto status       # in another terminal
pnpm wto new "Add dark mode"
pnpm wto ls

pnpm desktop          # Electron app (starts the daemon if it isn't running)
pnpm web              # PWA dev server on http://localhost:5173 (proxies /api to the daemon)
pnpm wto web          # prints the link that opens the web app with the daemon's token
pnpm mobile           # Expo dev server
```

Use from Claude Code:

```sh
claude mcp add wto -- pnpm --dir "$PWD/apps/mcp-server" --silent start
```

## Workspace

pnpm workspaces plus Nx (package-based). See [AGENTS.md](AGENTS.md) for the layout, the boundary rules and the package generator.

## License

[MIT](LICENSE)
