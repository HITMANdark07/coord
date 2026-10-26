---
name: code-review
description: "Use after completing a task or before merging — runs a structured review pass against captured rules, planned changes, and recent commits. Output is categorized (Critical / Important / Minor / Strengths) and ALWAYS persisted to .neatcode/reviews/<date>-<slug>.md so the report survives the session."
---

# Code Review

## Overview

Catch issues before they cascade. A review pass has three jobs:

1. **Confirm the captured rules pass.** Run `validate_diff` against the changes; rule violations are non-negotiable Critical issues.
2. **Read the diff with fresh eyes.** Look for dead code, missing tests, half-finished implementations, error-handling gaps, security smells, and assumptions that aren't justified by the change.
3. **Verify intent matches outcome.** The diff should accomplish exactly what the task or PR description claims — no more, no less.

Output is a structured report the user can act on.

## When to call

**Mandatory:**
- After finishing a task in a multi-task plan, before moving to the next task.
- Before telling the user a feature is done.
- Before commit / before merge to main.

**Optional but valuable:**
- When stuck — fresh perspective on the diff often surfaces the issue.
- After fixing a complex bug, before claiming it's fixed.
- Before a refactor — baseline check on what currently works.

**Skip when:**
- Single-character typo fix.
- The user is the one reviewing in real time and explicitly didn't ask.

## Procedure

### Step 1: Define the scope

Identify exactly what's being reviewed:

```bash
# For uncommitted changes:
git status
git diff --stat

# For a branch:
BASE=$(git merge-base origin/main HEAD)
git diff --stat $BASE..HEAD

# For a single commit:
git show --stat <sha>
```

Capture: list of changed files, total lines added/removed, the task description or PR title.

### Step 2: Run rule validation

Call `validate_diff` with the changed files and their final contents. Any violation here is a **Critical** issue — the change is conceptually wrong by the team's own captured rules.

```
validate_diff({
  changes: [
    { path: "<repo-relative>", content: "<full final content>" },
    ...
  ]
})
```

If the diff is committed already, run `validate_diff` with the on-disk content (still works — the engine treats it as a virtual graph).

### Step 3: Read the diff for non-rule issues

Walk the diff. Look for:

**Critical** (block):
- Logic errors that misimplement the requirement.
- Resource leaks (unclosed handles, unfreed memory, leaked subscriptions).
- Security smells (hardcoded credentials, unsanitized input flowing to a sink, broken auth checks).
- Concurrency bugs (race conditions, missing locks, incorrect ordering).
- Breaking changes to public API not flagged as breaking.

**Important** (fix before merge):
- Missing tests for new behavior.
- Error paths that swallow exceptions or return defaults silently.
- Half-finished implementations (TODO comments hiding incomplete work).
- Dead code: imports/functions/branches the diff introduced but doesn't use.
- Hidden assumptions: input that the code expects but doesn't validate at the boundary.
- Performance footguns introduced by the change (N+1 queries, unbounded loops).

**Minor** (note for later):
- Magic numbers without a named constant.
- Inconsistent naming with surrounding code.
- Comments that explain WHAT instead of WHY.
- Redundant abstractions for a single call site.

**Strengths** (note positively):
- Test coverage on the trickiest path.
- Clean separation that wasn't in the original code.
- Edge cases handled that the requirements didn't list.

### Step 4: Cross-reference active rules

Before declaring the review done, call `get_rules` and check whether any active rule applies to the changed code. If a rule applies and the change conforms, note it as a Strength. If a rule applies and the change *almost* violates it (corner case), note it as Minor.

### Step 5: Use the graph for unfamiliar symbols

If the diff modifies a function or class you don't have full context on, call `find_node` or `query_graph` to fetch its callers, decorators, and edges. Don't review what you don't understand — fetch the context.

### Step 6: Verify intent matches outcome

Re-read the task description or PR title. Cross-check against the diff:
- Does the diff accomplish what was asked?
- Does it accomplish *only* what was asked, or did scope creep in?
- Are there changes not justified by the task that should be split into a separate PR?

Scope creep is **Important** in most cases — tell the user, don't just remove the changes.

## Report format

Produce one report. Use exactly this structure:

```
# Code review

**Scope:** <files changed / commit range / task name>

## Strengths
- <bullet>

## Critical (block)
- <bullet>

## Important (fix before merge)
- <bullet>

## Minor (note for later)
- <bullet>

## Assessment
<one sentence: ready to merge / ready after Important issues fixed / not ready, see Critical>
```

If a section is empty, omit it. Don't pad with hedging language.

## Step 7: Persist the report to disk

**This is non-negotiable.** A code review that lives only in the chat transcript is worth a fraction of one that lives in the repo. Every review must be saved to:

```
.neatcode/reviews/<YYYY-MM-DD>-<short-slug>.md
```

Where:
- `<YYYY-MM-DD>` is the UTC date when you ran the review.
- `<short-slug>` is a kebab-case identifier — the task name, PR title, or feature being reviewed. Examples: `phase-3-usage-tracking`, `fix-token-overflow`, `auth-rotation`.

The file body is the full report — Strengths, Critical, Important, Minor, Assessment — exactly as it appears in the chat. Add a one-line `**Reviewer:** <agent name or "claude-code-session">` and a `**Date:** <iso-date>` header at the top so future readers know provenance.

If `.neatcode/reviews/` doesn't exist, create it (it's tracked alongside `plans/` and `specs/`).

If a file with the same slug already exists for today, append a `## Re-review (HH:MM UTC)` section rather than overwriting — multiple reviews of the same scope on the same day is a real signal worth preserving.

After the file is written, output a single line in the chat:

> Review saved to `.neatcode/reviews/2026-05-07-phase-3-usage-tracking.md`.

That's it. The full report does not need to be re-pasted in the chat after the file is written; the path alone is fine.

## Anti-patterns

- **Doing the fix mid-review.** A reviewer surfaces issues; the implementer fixes them. Mixing the two roles loses the fresh-eyes effect.
- **Reviewing your own thought process instead of the diff.** The reviewer evaluates the *output*, not how it was reached.
- **Treating Minor as decorative.** Minor issues are real — track them, don't skip them — they just don't block.
- **Ignoring `validate_diff` output.** A rule violation IS a real issue. If the rule is wrong, propose a `supersede` (one of the four options the validator surfaces). Don't quietly bypass.
- **Reporting only in chat.** A review that isn't saved to `.neatcode/reviews/` is a review that didn't happen. The persistence step is the deliverable, not the chat output.
