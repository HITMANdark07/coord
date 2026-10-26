---
name: filing-knowledge
description: "Use after answering a non-trivial structural question, after shipping placeholder/stub code during autonomous work, or after making a load-bearing decision not specified in the prompt. Proposes filing the answer as a memory note so the next session doesn't re-derive it."
---

# Filing Knowledge

## Overview

Every session that derives a non-trivial structural answer should leave behind a note. The next session — yours, a teammate's, a fresh agent in two months — should look up the answer in `.neatcode/memory/` instead of re-running the same five graph queries.

This skill writes Markdown files to `.neatcode/memory/<slug>.md`. It does not call any neatcode MCP tool — it consumes the result of prior tool calls (typically from `exploring-codebase`) and persists it.

## Trigger

Activate when, in the current turn, ANY of the following is true:

1. **The answer required more than two graph queries.** If you called `query_graph`, `trace_flow`, or `find_node` three or more times to compose the answer, the next session shouldn't repeat that work.
2. **The answer involved interpretation across multiple files.** Reading three files and synthesizing the relationship between them is exactly the kind of thing that compounds — write it down.
3. **The answer surfaced tribal knowledge.** Anything along the lines of "ah, the reason this is shaped this way is..." that wasn't already documented in `REPO_OVERVIEW.md`, `decisions/`, or `memory/`.
4. **You shipped a placeholder, stub, or simplification during autonomous work.** Examples: `// TODO: real auth wired here`, `dev-user assumes all scopes`, `caching disabled until X is decided`, `magic constant 100 — pick the real number once telemetry exists`. The next session needs to know what's pretending to work and what's load-bearing — file the placeholder, not just leave it in code.
5. **You made a load-bearing architectural choice not specified in the prompt.** "I picked X over Y because Z" — write it down before the reasoning evaporates. This is most common during autonomous, multi-task runs where the agent makes 5-10 small judgment calls per phase that compound.

If none of these apply, skip. Trivial one-shot answers don't need notes.

The first three triggers cover *answering a question*. The last two cover *autonomous work* — file under the same skill since the destination (`.neatcode/memory/`) is the same. The agent doesn't need permission from the user to surface a filing proposal in autonomous flows; just propose, then continue.

## Procedure

### Step 1: Propose a slug and a body

Pick a slug that names the topic, not the question. Topics last; questions are session-bound.

Good slugs:
- `auth-flow.md`
- `payment-state-machine.md`
- `request-lifecycle.md`
- `feature-flag-evaluation.md`

Bad slugs:
- `how-does-auth-work.md` (question, not topic)
- `today.md` (no topic)
- `notes-2026-05-06.md` (date, no topic)

Build a default body by condensing the answer you just gave. The body should be self-contained: someone who didn't read the original conversation should still understand it. Aim for 5-30 lines of prose with `file:line` citations.

### Step 2: Surface the proposal to the user

> That answer took some digging. I'd like to file it so we don't re-derive it next session.
>
> - Slug: `auth-flow.md`
> - Body (preview):
>
>   ```
>   <condensed answer here>
>   ```
>
> Save to `.neatcode/memory/auth-flow.md`?

Wait for the user's response.

### Step 3: Handle the response

**Confirm:** Write the body to `.neatcode/memory/<slug>.md`. If a file with that slug already exists, ask whether to append, replace, or pick a new slug. Do not silently overwrite. Acknowledge in one line: "Filed to `.neatcode/memory/<slug>.md`."

**Edit:** Walk the user through the change (slug rename, body trim, additional details). After each edit, re-present and re-ask.

**Reject:** Do nothing. Move on.

## What goes in the body

The body is free-form Markdown. A useful body usually includes:

- A one-line summary at the top
- Key files with `file:line` citations
- The relationship or pattern, in prose
- Any caveats or "the surprising thing was..." notes

Avoid:
- Verbatim transcripts of the conversation
- The graph output itself (the next session can re-query if it wants the raw data)
- Code snippets longer than ~10 lines (link to the file at line number instead)
- Speculation; if you're not sure, say so explicitly

## Why this matters

Memory notes compound. Every non-trivial structural question that ends in a filing makes the next non-trivial question cheaper. Within a few months of dogfooding, `.neatcode/memory/` becomes a directory the agent reads first when starting work on an unfamiliar area — the team's accumulated wiki, written by the agent in the language the agent will read it in.

This is the "compounding knowledge" pattern that wikis enable for human teams: each interaction adds to the persistent record, instead of being lost when the session ends. The agent doesn't have a memory of last week's conversation, but it can have a memory file on disk that it reads at the start of this week's conversation.

## What this skill does NOT do

- Does not write to `.neatcode/skills.yaml`. Rules are captured by `capturing-conventions`. Memory notes are free-form context, not enforceable rules.
- Does not write to `.neatcode/decisions/`. Decisions are append-only records of rule supersession, written by `validating-diff` on supersede.
- Does not commit the file. The user commits when they're ready (or the file lives in their working tree until they discard it).
- Does not auto-trigger after every answer. The trigger thresholds above are deliberate — over-filing creates noise.
- Does not call any MCP tool. Pure file write.

## Edge cases

**Slug collision.** A file with that slug already exists. Options: append a section to the existing file with a date heading; pick a more specific slug (e.g., `auth-flow-oauth.md` instead of `auth-flow.md`); replace the existing file (only if it's stale). Ask the user which.

**Body is too long.** If the condensed answer pushes past ~50 lines, split into two notes with cross-references, or trim ruthlessly. The point is durability and quick reading later, not completeness.

**The user says "file it" without prompting.** Honor the request immediately — same procedure, just skip the "do you want to file this?" confirmation since they already said yes.

**Session ended an hour ago and now the user asks "file what we found earlier."** The relevant tool calls aren't in this turn. Re-derive briefly with `query_graph` (or use the prior conversation if available), then propose. Don't write a memory note from a vague recollection — go back and reconfirm the file:line citations.
