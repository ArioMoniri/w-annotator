---
description: Run one pass of the improvement loop described in docs/process/LOOP.md.
argument-hint: [optional focus, e.g. "threshold brush" or "AC-7"]
---

Run exactly one iteration of the loop in `docs/process/LOOP.md`. Optional focus for this pass: $ARGUMENTS

## Before starting

Read `docs/process/GOAL.md`, `docs/process/LOOP.md`, `docs/process/DOD.md` and `docs/process/TDD.md`.

Stop without doing anything, and tell the user why, if:

- GOAL.md has no active goal (run `/goal` first),
- every acceptance criterion is already met and the last watchdog result was PASS,
- the iteration count has reached the maximum in LOOP.md,
- a blocking open question is unanswered (run the `grill-me` skill).

## The pass

1. **Pick.** Choose the work for this pass, in this order: unresolved watchdog failures, then required changes from the last council or tester report, then the next unmet acceptance criterion. Take a small slice: one to three items. If a focus was given, stay within it. State what you picked and which acceptance criteria it serves.

2. **Plan.** Launch `orchestrator` to break the slice into tasks, each with its first failing test.

3. **Implement with TDD.** For each task: write the failing test, run it and see it fail for the right reason, write the least code that passes, then tidy up with the tests green. UI work follows `docs/design/DESIGN.md`; if the design is silent, ask `designer` (and `motion-designer` for any transition) before building.

4. **Verify.** Run all of these and keep the output: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e`, and `cargo test` in `src-tauri/` if Rust changed. Fix failures before going on. Never skip or weaken a test to get to green.

5. **Review.** If the UI or user-facing behaviour changed, run the `council` skill on the build and launch `tester-user` at the same time. If only internals changed, skip the council and say so in the log.

6. **Fix.** Fix every required change and every critical or high bug, with a test first where one is possible. Re-run step 4. Anything left over goes in the log as carried over; do not start new work.

7. **Gate.** Launch `watchdog`. If it returns FAIL, fix the blocking items and run it once more. If it still fails, stop and report; the failures are the first work of the next pass.

8. **Record.** Update the status column in GOAL.md for criteria that are now met, with the evidence. Update Current state in LOOP.md and append one row to the Loop log. Add any decisions to DECISIONS.md.

## Report

Tell the user, briefly: what was done, the result of each check with real numbers, the council and watchdog verdicts, what was carried over, and whether the loop should continue or has reached an exit condition. Do not start another pass on your own.
