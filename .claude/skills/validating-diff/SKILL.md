---
name: validating-diff
description: "Use at logical-unit boundaries — finished a feature slice, completed a TDD cycle, before claiming a task done, before committing. NOT before every file write. Validates the planned changes against the repo's captured rules and surfaces violations with resolution options."
---

# Validating Diffs

## Overview

The captured ruleset is enforced at meaningful checkpoints, not after every keystroke. This skill is the gate at those checkpoints.

This skill calls the `validate_diff` MCP tool.

## When to call — the right cadence

The right call frequency is **3–8 times per phase**, not 1 (too coarse) and not 12+ (too noisy). The pattern is "once per testable behavior" — every time a logical unit reaches a state worth gating on.

**Call when:**

- A logical unit is complete: a service + its controller + its spec, written and assembled into something that could be tested.
- A TDD cycle finished — failing test → passing implementation → cleanup. After cleanup is the natural validation point.
- About to commit a batch of changes.
- About to tell the user "the change is in" / "ready" / "done".
- About to hand off to the `verifying` skill (which runs `validate_diff` again as the final gate).

**Do NOT call when:**

- Writing a test fixture, snapshot, or pure data file. Nothing the engine can flag.
- Mid-TDD red phase, where the implementation file is empty or stub. Nothing decorated yet.
- Mid-refactor with files in inconsistent intermediate states. The transient state will produce false positives that disappear once the refactor lands.
- Writing a single line of formatting / imports / comments. Trivial edits don't shift any rule outcome.

**Why not "every file write":**

Three concrete costs. (1) During partial multi-file changes, a controller method calling a not-yet-written service method would spuriously trigger `edge-forbidden` flags that resolve once the second file lands — training the agent to ignore violations in general. (2) TDD-red phases have nothing to validate; calling anyway is theater. (3) Stop-start fragmenting natural reasoning seams reduces flow without catching anything you wouldn't catch at the next checkpoint.

The earlier you call within the right cadence, the cheaper the iteration. But "earlier" means "at the next logical-unit boundary", not "between every two characters typed."

## Procedure

### Step 1: Build the changes payload

Collect every file you intend to write or modify in this turn. For each, capture the final content you intend to write (not a partial draft). For deletions, mark `deleted: true`.

```
{
  changes: [
    { file: "<repo-relative path>", new_content: "<full new file contents>" },
    { file: "<repo-relative path>", deleted: true },
    ...
  ]
}
```

### Step 2: Call `validate_diff`

```
validate_diff({ changes: [...] })
```

Response shape:

```
{
  violations: Violation[],
  options: ['exception_once', 'exception_until', 'supersede', 'abort']
}
```

A `Violation` carries `rule_id`, `primitive`, `qualified_name`, `file`, `line`, `message`, `expected`, `actual`.

### Step 3: Handle the response

**No violations (`violations: []`):** Proceed to save. Done.

**Violations present:** Surface every violation to the user before doing anything else. One block per violation:

> Rule `controller-must-rate-limit` (annotation-required)
> File: `src/controllers/reports.ext:42`
> Symbol: `ReportsController.summary`
> Expected: annotation `RateLimit`
> Actual: annotations `[Get, HttpCode]`

Then present the four-option UX exactly as below, and wait for the user's choice. Do not pick on their behalf.

## The four options

### 1. `exception_once`

Bypass for this one change. The rule is not modified. The change saves. Future changes are still subject to the rule.

Use when: the violation is a deliberate one-off, the user accepts the deviation, and they want the rule to keep applying everywhere else.

Action: save the file, log nothing to `.neatcode/decisions/`. The exception is local to this turn.

### 2. `exception_until`

Bypass and pin a date. The rule grows an `effective_until` field set to the user-supplied date. Until that date, the rule does not apply to anything matching it; after that date, it applies again.

Use when: the rule will be enforceable later but isn't ready yet (e.g., a migration in progress).

Action: ask the user "until what date?" (require ISO date). Update the rule in `.neatcode/skills.yaml` with `effective_until: <date>`. Save the file.

### 3. `supersede`

Replace the rule with a new version. The old rule's `effective_until` is set to today; a new rule is appended. A decision file is written to `.neatcode/decisions/YYYY-MM-DD-<rule-id>-superseded.md` recording the change.

Use when: the rule itself is wrong or out of date.

Action:
1. Ask the user for the new rule shape (often "what should the rule be instead?").
2. Ask the user for a reason — REQUIRED. The reason goes into the decision file.
3. Write the decision file with frontmatter (date, superseded_rule, new_rule_id, effective_from, reason, author).
4. Update `.neatcode/skills.yaml`: add `effective_until` on the old rule, append the new rule.
5. Re-run `validate_diff` with the same changes payload to confirm the change now clears the new rule.
6. If the re-run is clean, save. If not, surface the new violations and repeat.

### 4. `abort`

Don't apply the change. The rule stays. The user reconsiders the change.

Use when: the rule is correct, the change is wrong, the right move is to rewrite the change.

Action: discard the planned change. Ask the user how they want to proceed (rewrite, give up, etc.).

## Default behavior when the user is unsure

If the user expresses doubt — "hmm, not sure" / "what would you do?" / silence — default to `abort`. The rule was captured for a reason; the safest move is to not violate it. Tell the user: "I'll abort this change. We can revisit it after looking at why the rule exists."

## Pairing with `verifying`

This skill and `verifying` both call `validate_diff`. They are not redundant:

- `validating-diff` runs **before** save — the early gate. Catches violations while there's still time to rewrite the change cheaply.
- `verifying` runs **after** save (and after tests pass) — the final gate. Confirms the saved state is clean before claiming the work is done.

A change in flight will pass through `validate_diff` at least once. A change being claimed as done will pass through it twice. That's intentional.

## What this skill does NOT do

- Does not run tests. That's the `tdd` and `verifying` skills.
- Does not capture new rules. That's `capturing-conventions`.
- Does not modify the rule on `exception_once` — single-shot exceptions are not recorded.
- Does not auto-pick options. The user always decides.
- Does not write to `.neatcode/decisions/` for `exception_once` or `exception_until`. Decisions are written only on `supersede`.
- **Does not gate every file write.** Calling per-write produces noise from intermediate states. See cadence guidance above.

## Edge cases

**Multiple violations across multiple files.** Present them all. The user picks one option per rule (not per violation). If they pick `supersede` on a rule, all violations of that rule disappear when the new rule clears.

**The user picks `supersede` and the new rule still produces violations.** Re-run validate_diff after writing the new rule. If the change still violates, the user has two options: rewrite the change, or supersede again with a stricter shape. Don't infinite-loop — if the user supersedes twice in a row, ask "are we sure the rule is what we want it to be?"

**`validate_diff` errors out (graph not built, file unparseable, etc.).** Do NOT swallow the error. Surface it to the user. They may need to run `neatcode sync` first.

**Empty changes payload.** Skip the call. There's nothing to validate.
