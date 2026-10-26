---
name: capturing-conventions
description: "Use when the user expresses a rule (must / never / always / going forward / no longer / forbid / require / cannot / shouldn't) — captures one rule at a time. ALSO use proactively on a fresh repo with empty skills.yaml: call `derive_candidates` to mine the existing graph for candidate rules, walk through them with the user, then bulk-persist via `accept_derived_candidates`."
---

# Capturing Conventions

## Overview

Two entry points to the same destination — `.neatcode/skills.yaml`:

1. **Per-utterance capture (the magic moment).** User mid-flow says "every controller method must have @Throttle going forward." The keyword classifier triggers, `propose_rule_from_prompt` structures the rule, the user confirms, the rule lands.
2. **Bulk mining (the orientation moment).** Fresh repo, no captured rules yet. The user wants to know what conventions exist. Call `derive_candidates` to pull a graph snapshot, reason through it yourself, surface candidates conversationally, persist with `accept_derived_candidates`.

This skill calls `propose_rule_from_prompt` for the first path, `derive_candidates` + `accept_derived_candidates` for the second.

## Trigger

Activate when the user's most recent message contains any of these rule-language tokens:

- **must**
- **never**
- **always**
- **going forward**
- **no longer**
- **forbid**
- **require**
- **cannot**
- **shouldn't / should not**
- **don't / do not**

The keyword classifier is deterministic. There is no LLM judgment in the trigger — if the keyword appears, the skill considers the message a candidate.

## Procedure

### Step 1: Call `propose_rule_from_prompt`

Pass the user's exact phrasing as the `text` argument:

```
propose_rule_from_prompt({ text: "<the user's message verbatim>" })
```

The tool returns one of two shapes:

**a) No rule could be extracted:**
```
{ proposed: null, reason: "<short explanation>" }
```
Stop. The keyword classifier had a false positive. Do not interrupt the user. Continue with whatever the user actually asked for.

**b) A structured proposal:**
```
{
  proposed: {
    id: "<slug>",
    primitive: "annotation-required" | "naming-pattern" | "folder-naming-convention",
    when: { kind, parent_has_annotation?, has_annotation_any?, name_suffix?, path_glob? },
    require: "<value>",       // primitive-specific
    scope: "new" | "all",
    source: "prompt"
  }
}
```

### Step 2: Surface the proposal to the user

Present the proposal as a tight summary, NOT as a JSON dump. Use natural language:

> I heard you say a rule. Here's what I'd capture:
>
> - **id:** `controller-must-rate-limit`
> - **primitive:** `annotation-required`
> - **when:** methods on classes annotated with `Controller` that have any of `Get / Post / Put / Delete / Patch`
> - **require:** `RateLimit` annotation
> - **scope:** new code only (existing methods grandfathered)
>
> Confirm to add this rule to `.neatcode/skills.yaml`? You can edit any field first.

### Step 3: Handle the user's response

Three outcomes:

**Confirm:** Append the rule (as returned by the tool) to `.neatcode/skills.yaml` under the `rules:` list. Acknowledge in one line: "Captured. The rule is now active for new code." Continue with whatever the user was working on.

**Edit:** Walk the user through the field they want to change. Common edits:
- "scope to all" — change `scope: new` to `scope: all`
- "include existing files matching X" — same as above plus add a `path_glob`
- "different annotation name" — change `require`
- "limit to a folder" — add `path_glob`
- "different rule id" — change `id`

After each edit, re-present the updated proposal and ask for confirmation again.

**Reject:** Do nothing. The keyword classifier was a false positive. Acknowledge briefly ("OK, ignoring") and continue.

## What this skill does NOT do

- Does not validate existing code against the new rule. That's `validating-diff`'s job, on the next change.
- Does not run an LLM over the user's message. The classifier is regex-based; the proposer extracts noun phrases via simple heuristics; the user is the final arbiter of the structured form.
- Does not call `validate_diff`. New rules apply going forward — `scope: new` is the default.
- Does not write to `.neatcode/decisions/` on initial capture. Decisions are written only on supersession, via `validating-diff`.

## Edge cases

**The user says something that sounds like a rule but isn't.**
Example: "I always feel like the tests take forever." `propose_rule_from_prompt` will return `{ proposed: null }`. Move on.

**The proposal has the wrong primitive.**
Example: user said "every handler must live in `handlers/`" and the tool returned `annotation-required` instead of `folder-naming-convention`. Walk the user through changing the primitive, then re-confirm. If the tool can't express what the user meant with the available primitives, say so plainly: "I can't express that with the rule primitives we have. Want to file it as a free-form note in `.neatcode/memory/` instead?"

**Two rules in one sentence.**
Example: "controllers must be in `controllers/` and must have rate limiters." Capture them as two separate rules, presenting both proposals before writing. Confirm each.

**Conflicting existing rule.**
If a rule with the same `id` already exists in `skills.yaml`, surface the conflict: "There's already a rule with id `controller-must-rate-limit`. Supersede it?" If yes, hand off to the supersede flow (recorded in `.neatcode/decisions/`). If no, ask for a new id.

## Bulk mining flow (the orientation entry point)

Use this branch when:

- The user just ran `neatcode init` and asks "what should I do next?" / "what conventions exist here?" / "help me capture the rules" — AND `.neatcode/skills.yaml` is empty (or has only one or two rules from prior runs).
- You're starting a fresh session, you just called `get_repo_overview`, and the overview shows zero or near-zero active rules. **Proactively** propose mining: "I notice this repo has no captured rules yet. Want me to look at the codebase and propose some?"
- The user explicitly asks: "what would good rules look like for this repo?"

Do NOT use this branch when:

- The user is making a normal code change (use `validating-diff` and per-utterance capture instead).
- `skills.yaml` already has 5+ rules (the user has been curating; don't pile on).
- The user just rejected a candidate (don't immediately re-mine).

### Procedure

**1. Call `derive_candidates`.** It returns:
- `snapshot`: graph stats (decorator histograms, co-occurrence pairs, folder layout, name suffixes, import edges).
- `system_prompt`: the contract for your output — names the six primitives and their JSON shapes.
- `active_rule_ids` + `rejected_rule_ids`: don't re-propose these.
- `max_candidates`: cap your output count.
- `fresh_repo`: whether the repo currently has zero rules.

**2. Reason through the snapshot.** YOU are the LLM here — the tool didn't call one. Look at the snapshot and produce a JSON array of `SkillCandidate` objects. Bias toward high-precision proposals: a bad rule the user has to reject is more expensive than a missed one.

Common patterns to look for:
- Decorators on ≥95% of a class group → `decorator-required`.
- Method-level decorators that always co-occur with a parent class decorator → `decorator-required` with `parent_has_annotation`.
- Class name suffixes that ≥90% of @X classes share → `naming-pattern`.
- Folders where ≥90% of files share a suffix → `folder-naming-convention`.
- Decorators that NEVER co-occur on the anchor group despite existing elsewhere → `annotation-forbidden`.
- Layer/cohesion patterns ("controllers don't directly call repositories") → `edge-forbidden`.

**3. Surface to the user, candidate by candidate.** NOT a JSON dump. Walk through them in plain language:

> Looking at the graph, I see 4 candidate rules worth considering:
>
> 1. `decorator-required:Controller->ApiTags` — every @Controller class also carries @ApiTags. 8/8 controllers in the repo. **High confidence.**
> 2. `naming-pattern:Module->suffix:Module` — all 12 @Module classes end with "Module". **High confidence.**
> 3. `folder-naming:dto->.dto.ts` — 9 of 10 files in `dto/` folders end with `.dto.ts`. **Medium confidence.**
> 4. `annotation-forbidden:Controller>>!Deprecated` — no @Controller class carries @Deprecated, while @Deprecated exists elsewhere. **Low confidence — small sample.**
>
> Which would you like to accept? You can pick all, none, or a subset.

**4. Persist with `accept_derived_candidates`.** When the user confirms a subset, call this in ONE batch:

```
accept_derived_candidates({
  candidates: [<the candidates the user picked>],
  scope: "new",   // grandfather existing offenders
  target: "team", // committed; use "local" if user wants personal-only
})
```

The response tells you which were written, which were already-active (you missed in the dedup), and which were previously rejected.

For one-at-a-time interactive review, use `accept_proposed_rule` per candidate instead — cleaner if the user wants to discuss each individually.

### Anti-patterns

- **Don't pre-build the candidate list before asking.** Reason through the snapshot live so the user sees your reasoning. They learn what kinds of patterns you're spotting.
- **Don't propose `import-forbidden` or `edge-forbidden` from weak evidence.** These rules are powerful; a wrong one is annoying. Require strong layer-boundary signal in the folder layout.
- **Don't auto-accept on the user's behalf** — even if every candidate is "obviously fine." Bulk-accept is `accept_derived_candidates` after the user nods, not before.

## Why this matters

Captured rules accumulate. Every conversation that contains a rule deposits one more line into `skills.yaml`. Six months later, the file is the team's living style guide — extracted from how the team actually talks about the code, not from a doc nobody reads. The "magic moment" is the first time a developer says a rule out loud and watches it appear in the file. The "orientation moment" is the first time a developer drops into a fresh repo and watches the agent surface five real conventions before they've typed a single rule.
