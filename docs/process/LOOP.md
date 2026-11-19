# Iteration loop

The loop that moves the current goal (`GOAL.md`) to done. Run one pass with `/iterate`. The full multi-agent picture is in `.claude/workflows/build-review-loop.md`.

## Current state

| Field | Value |
| --- | --- |
| Goal | W Annotator v1 (see `GOAL.md`) |
| Iteration | 0 of 5 |
| Step | plan |
| Last watchdog result | none yet |
| Blocked on | nothing |

The orchestrator keeps this table current.

## Entry criteria

Start an iteration only when:

- `GOAL.md` has an active goal with checkable acceptance criteria,
- no blocking open question is unanswered (otherwise run the `grill-me` skill),
- the working tree is green: lint, typecheck, unit and e2e pass, or their failures are this iteration's first work,
- the iteration count is below the maximum.

## Steps

| # | Step | Role | Result |
| --- | --- | --- | --- |
| 1 | Pick a small slice: watchdog failures first, then required changes from the last review, then the next unmet criterion | Main session | One to three items, each tied to an acceptance criterion |
| 2 | Plan | orchestrator | Tasks with owner and first failing test |
| 3 | Specify UI, if any | designer, motion-designer | `docs/design/DESIGN.md` updated |
| 4 | Implement test first | Main session | Code and tests (`TDD.md`) |
| 5 | Verify | Main session | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e`, `cargo test` all green |
| 6 | Review, in parallel | `council` skill (radiologist, annotator-user, ux-reviewer) and tester-user | Required changes and bugs |
| 7 | Fix required changes and critical or high bugs, test first; verify again | Main session | Green again |
| 8 | Gate | watchdog | PASS or FAIL |
| 9 | Record | orchestrator | `GOAL.md` statuses, this file, `DECISIONS.md` |

Steps 6 and 7 may be skipped when nothing user-facing changed; note that in the log. Steps 5 and 8 are never skipped.

## Exit criteria

**One iteration ends** when the watchdog has returned PASS, or has returned FAIL twice in that iteration. Either way, record it in the log.

**The loop ends as done** when all of these hold:

- every acceptance criterion in `GOAL.md` is met, with evidence,
- every line of `DOD.md` holds,
- the watchdog returned PASS in the final iteration,
- the last council verdict was APPROVE, or its required changes are all closed.

**The loop stops early** and goes back to the user when:

- the maximum number of iterations is reached,
- two iterations in a row make no progress (no criterion newly met, no fewer blocking findings),
- the same test or watchdog finding fails two iterations running,
- a question only the user can answer blocks the work,
- the goal cannot be met without changing scope or breaking a product rule.

## Limits

- Maximum iterations per goal: **5**. Raising it is the user's call; record it in `DECISIONS.md`.
- Maximum watchdog runs per iteration: **2**.
- Slice size per iteration: **1 to 3** acceptance criteria or required changes.

## Loop log

Append one row per iteration. Do not edit or delete earlier rows.

| Iter | Date | Slice (criteria / changes) | Checks (lint, types, unit, e2e, cargo) | Council | Tester (bugs: crit/high/med/low) | Watchdog | Carried over | Next |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |  |
