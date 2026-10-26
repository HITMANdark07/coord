@AGENTS.md

<!-- neatcode:start -->
## neatcode usage (auto-generated)

This repo uses [neatcode](https://github.com/HitmanDark07/neatcodeai) for codebase intelligence and convention enforcement. The MCP server is wired in via `.mcp.json`. Skills are installed under `.claude/skills/`.

**Operating Procedures** — invoke skills (project-level, in `.claude/skills/`) at the right moments:

Before any feature or non-trivial change:
1. `brainstorming` — design first, code second.
2. `exploring-codebase` — find existing patterns via `query_graph` instead of grepping.
3. `writing-plans` — save to `.neatcode/plans/YYYY-MM-DD-<feature>.md`.
4. `tdd` — failing test first.

Before claiming any change is complete:
5. `validating-diff` — call `validate_diff` and confirm clean.
6. `code-review` — structured review pass against rules + diff before merge.
7. `verifying` — tests pass AND `validate_diff` clean.

When the user expresses a rule (must / never / always / going forward / no longer / forbid / require):
8. `capturing-conventions` triggers automatically. Confirm before writing to `.neatcode/skills.yaml`.

On a fresh repo (no rules yet) when the user asks orientation questions ("what should I do?", "what conventions exist here?"):
9. Proactively call `derive_candidates` to mine the graph for candidate rules, walk the user through them, then bulk-persist via `accept_derived_candidates`. Trigger when `get_repo_overview` shows `active_rules: 0` AND the user is in an orientation state — NOT mid-feature-work.

When asked a structural question (who calls X, what extends Y, what guards run on Z):
10. `exploring-codebase` — answer from the graph, not file reads.
11. `filing-knowledge` — after non-trivial answers, propose filing to `.neatcode/memory/`.

**Tool reference:**
- `get_repo_overview` — call once at session start for orientation (file counts, frameworks, layout, active rules).
- `query_graph` — "what handles X?", "what calls Y?", "what depends on Z?".
- `find_node` — exact lookup by name or qualified name.
- `trace_flow` — multi-hop call traversal with decorator annotations per step.
- `validate_diff` — at logical-unit boundaries (NOT every file write), pass the planned content to catch convention violations.
- `propose_rule_from_prompt` — capture one rule from natural-language phrasing.
- `accept_proposed_rule` — persist a confirmed candidate (per-item, interactive).
- `derive_candidates` — mine the graph snapshot for candidate rules; you reason through it and produce candidates inline.
- `accept_derived_candidates` — bulk-persist multiple candidates after user confirmation.

Do NOT invoke the `update-config` skill for repo conventions — that's for `~/.claude/settings.json` only.

To remove this section + skills: `neatcode claude uninstall`.
<!-- neatcode:end -->
