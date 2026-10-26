---
name: verifying
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always
---

<!-- Adapted from superpowers (https://github.com/obra/superpowers) - see superpowers source skill: verification-before-completion -->

# Verification Before Completion

## Overview

Claiming work is complete without verification is dishonesty, not efficiency.

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

This skill calls the `validate_diff` MCP tool as part of the completion gate. Tests passing is necessary but not sufficient — the change must also clear the repo's captured rules.

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE FROM BOTH GATES
```

If you haven't run BOTH (a) the test command AND (b) `validate_diff` in this message, you cannot claim the change is done.

## The Two Gates

A change is complete only when both of the following return clean in this turn:

**Gate (a): Tests pass**
- Run the project's test command for the affected files (or the whole suite if scope is unclear)
- Confirm exit code 0, zero failing assertions, no warnings beyond the project baseline

**Gate (b): `validate_diff` returns clean**
- Call the `validate_diff` MCP tool with `changes: [{file, new_content}, ...]` for every file you intend to claim is done
- Confirm `violations` is the empty array
- If violations come back, DO NOT claim done. Hand off to the `validating-diff` skill to resolve them via the four-option UX (`exception_once`, `exception_until`, `supersede`, `abort`).

Both gates run on the SAME change set in the SAME turn. Tests passing yesterday plus a clean `validate_diff` from earlier today is not sufficient — the world may have moved.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves gate (a)? What changes are passed to gate (b)?
2. RUN GATE (a): Execute the FULL test command (fresh, complete)
3. RUN GATE (b): Call validate_diff with the change set
4. READ: Full output of both, check exit code, count test failures, inspect violations array
5. VERIFY: Do both outputs confirm the claim?
   - If EITHER fails: state actual status with evidence; do not claim done
   - If BOTH pass: state claim WITH evidence (test summary + "validate_diff: clean")
6. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes AND `validate_diff` clean | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Change ready to commit | Tests pass AND `validate_diff` returns `violations: []` | Tests passing only |
| Requirements met | Line-by-line checklist | Tests passing |

## Red Flags — STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- **Claiming done with tests green but no `validate_diff` call this turn**
- **Claiming done with `validate_diff` clean but tests not re-run this turn**
- Thinking "just this once"
- Tired and wanting work over
- ANY wording implying success without having run BOTH gates

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | RUN both gates |
| "I'm confident" | Confidence is not evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter is not a test or a rule check |
| "Agent said success" | Verify independently |
| "Tests pass, that's enough" | `validate_diff` catches rule violations the test suite doesn't know about |
| "validate_diff was clean earlier" | Re-run on the final change set |
| "I'm tired" | Exhaustion is not an excuse |
| "Different words so rule doesn't apply" | Spirit over letter |

## Key Patterns

**Tests:**
```
[Run test command] [See: 34/34 pass] -> claim "tests pass"
"Should pass now" / "Looks correct" -> not allowed
```

**validate_diff:**
```
[Call validate_diff with full change set] [See: violations: []] -> claim "validate_diff clean"
"Last call was clean" / "Probably still clean" -> not allowed
```

**Combined completion claim:**
```
Both gates ran this turn, both returned clean -> "Change is complete: 34/34 tests pass, validate_diff: 0 violations"
Either gate skipped -> not allowed to claim done
```

**Regression tests (TDD red-green):**
```
Write -> Run (pass) -> Revert fix -> Run (MUST FAIL) -> Restore -> Run (pass) -> validate_diff
```

**Build:**
```
[Run build] [See: exit 0] -> "Build passes"
"Linter passed" -> not sufficient (linter doesn't check compilation)
```

**Agent delegation:**
```
Agent reports success -> Check VCS diff -> Run both gates yourself -> Report actual state
Trust agent report -> not allowed
```

## Why This Matters

- Trust broken when claims aren't backed by evidence
- Undefined functions shipped
- Missing requirements shipped
- Time wasted on false completion -> redirect -> rework
- Rule violations land in main and erode the captured ruleset
- Honesty is non-negotiable

## When To Apply

**ALWAYS before:**
- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**
- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion or correctness

## The Bottom Line

**No shortcuts for verification.**

Run the test command. Call `validate_diff`. Read both outputs. THEN claim the result.

Both gates, every claim. Non-negotiable.
