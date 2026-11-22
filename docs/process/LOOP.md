# Iteration loop

The loop that moves the current goal (`GOAL.md`) to done. Run one pass with `/iterate`. The full multi-agent picture is in `.claude/workflows/build-review-loop.md`.

## Current state

| Field | Value |
| --- | --- |
| Goal | W Annotator v1 (see `GOAL.md`) |
| Iteration | 3 of 5 |
| Step | fix (step 7), then gate (step 8) |
| Last watchdog result | FAIL on 0.1.2, 2026-11-22 (`docs/reviews/0.1.2-council.md`): process and claims, not the test suites |
| Blocked on | A second watchdog and council run on 0.1.3, which holds the fixes of all three branches |

The orchestrator keeps this table current.

0.1.0, 0.1.1 and 0.1.2 were released without rows in the log below and without a recorded gate. The rows for them were written on 2026-11-22 from the changelog, the CI history and the reviews in `docs/reviews/`; what could not be recovered says so.

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
| 1 | 2026-11-19 to 2026-11-20 | Release 0.1.1: trackpad, layouts, reference lines, Files section and several masks, Open with, drop overlay (`CHANGELOG.md`). Written up afterwards. | CI green on `main` at the release. Local runs: not recorded | An earlier review is in `docs/reviews/iter1.md`. No council verdict recorded for 0.1.1 | `docs/reviews/iter1-tester.md`; none recorded for 0.1.1 | not run | No acceptance criterion was updated in `GOAL.md` | 0.1.2 |
| 2 | 2026-11-21 | Release 0.1.2: window presets and menu, zoom menu, two kinds of room with encrypted traffic, freehand scissors, erase outside, islands, paint over, fill preview, split, smooth pixels (`CHANGELOG.md`). Written up afterwards. | CI green on `main` at `6a9f410` (run 44939691847, nine jobs). Release workflow passed (run 44922414843) | not run before release | not run before release | not run before release | No gate record; `GOAL.md` still said "not started" for every criterion | Review of what shipped |
| 3 | 2026-11-22 | Review of 0.1.2 (`docs/reviews/0.1.2-council.md`), then its fixes on three branches: `fix/council-0-1-2` (S1, S2, S4, S6, S7, S10 to S15, M3, M4 docs, N1, N12), `fix/polish-0-1-3` (S5 and polish), `fix/rooms-hardening` (M1, M2, S3, S8, S9) | Review, on `main`: typecheck and lint clean; unit 998 passed; cargo passed; e2e 208 passed and 1 failed in a run that ran out of memory (passed 3 of 3 alone); `webkit:check` and desktop e2e not run. On `fix/council-0-1-2` (Linux, 2026-11-22): typecheck and lint clean; unit 1014 passed in 51 files; e2e 226 passed, 0 failed, 0 skipped, in one run in Chromium; `webkit:check` 45 passed in WebKitGTK; cargo not run (no Rust changed); desktop e2e, macOS and Windows not verified. With the three branches together, as 0.1.3 (Linux, 2026-11-22): typecheck and lint clean; unit 1056 passed in 52 files; e2e 242 passed, 0 failed, 0 skipped, in one run in Chromium, and one more test added after it passed alone; `webkit:check` 45 passed; `cargo fmt --check` and clippy clean; `cargo test --workspace` 160 passed, 0 ignored | CHANGES REQUIRED: radiologist, annotator and UX each APPROVE WITH CHANGES. One reviewer took the roles in turn, so they were not independent | 0 / 2 / 6 / 6 | FAIL (scope against `GOAL.md`, one green e2e run not obtained, definition of done, unverified claims, docs) | M1 and M2 (rooms), S5; a second watchdog and council run | Merge the three branches, run the gate again, then decide on 0.1.3 |
