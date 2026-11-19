# Build-review loop

How the agents work together to take a request from a rough sentence to a finished, checked change. This is the reference; `docs/process/LOOP.md` holds the live state and log, `/goal` starts the workflow and `/iterate` runs one pass of steps 3 to 8.

```
request
  │
  1 enhance ── prompt-enhancer ──────────────► spec
  2 grill ──── grill-me skill ───────────────► decisions, GOAL.md
  │
  ┌──────────────── one iteration ────────────────┐
  3 plan ───── orchestrator ─────────────────► tasks, each with a first test
  4 implement  main session, TDD ────────────► code + tests
               (designer / motion-designer for UI)
  5 verify ─── lint, typecheck, unit, e2e, cargo
  6 review ─── council (radiologist + annotator-user + ux-reviewer)
               + tester-user, all in parallel ► required changes, bugs
  7 fix ────── main session, TDD ────────────► back through 5
  8 gate ───── watchdog ─────────────────────► PASS / FAIL
  └────────────────────────────────────────────────┘
  │
  PASS and all criteria met → done      otherwise → next iteration
```

## Steps

| # | Step | Who | Input | Output | Moves on when |
| --- | --- | --- | --- | --- | --- |
| 1 | Enhance | prompt-enhancer | The user's request | Spec: goal, constraints, acceptance criteria, out of scope, open questions | Every criterion is checkable |
| 2 | Grill | grill-me skill, with the user | Spec | Answers in `docs/process/DECISIONS.md`; final `docs/process/GOAL.md` | No blocking open question remains and the user confirms |
| 3 | Plan | orchestrator | GOAL.md, LOOP.md, code | Small tasks, each tied to a criterion, with owner and first failing test | Every task has a named test; nothing is outside the goal |
| 4 | Implement | Main session; designer and motion-designer specify UI first | Tasks | Code and tests, written red → green → refactor (`docs/process/TDD.md`) | Each task's test went red, then green |
| 5 | Verify | Main session | Working tree | Output of `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e`, `cargo test` | All green, nothing skipped |
| 6 | Review | council skill and tester-user, in parallel | Running web build and screenshots | Merged verdict, required changes, bug list with repro steps | Reports are in |
| 7 | Fix | Main session | Required changes; critical and high bugs | Fixes with tests; step 5 run again | Step 5 is green again |
| 8 | Gate | watchdog | Diff, GOAL.md, DOD.md, reports | PASS or FAIL with file and line | PASS |

## Rules

- **One writer.** Review agents (radiologist, annotator-user, ux-reviewer, tester-user, watchdog) never change product code. Only the main session and the designers write, and only in their own areas.
- **Parallel where independent.** The three council members and tester-user start in the same message. Tasks that do not depend on each other may run in parallel; tasks touching the same files do not.
- **Reviewers work blind.** No reviewer sees another's findings before reporting.
- **Evidence over claims.** A step is finished when its output exists: command output, a screenshot, a report. The watchdog re-checks everything itself.
- **Small iterations.** One to three acceptance criteria or required changes per pass.
- **Skip review when nothing user-facing changed.** Steps 6 and 7 can be skipped for internal changes. Steps 5 and 8 are never skipped.
- **Nothing new mid-loop.** Ideas that come up go to the "Out of scope" list or a later goal.
- **Fixed rules of the product.** No AI features. The UI stays simple and calm. The medical image is never altered or animated for effect.

## Stop conditions

Stop and report to the user when any of these is true.

Done:
- Every acceptance criterion in GOAL.md is met with evidence, the Definition of Done holds, and the watchdog returned PASS in this iteration.

Stopped early:
- **Maximum iterations reached** (five per goal, see LOOP.md). Report what is met and what is not.
- **No progress.** Two iterations in a row with no criterion newly met and no fewer blocking findings.
- **Repeated failure.** The same test or the same watchdog finding fails in two consecutive iterations after a fix was attempted.
- **Blocking question.** Something only the user can decide. Run grill-me.
- **Reviewer deadlock.** Council members disagree on a blocker and the priority order in the council skill does not settle it.
- **Scope has to change.** The goal cannot be met without breaking a constraint, adding an AI feature, or going outside GOAL.md.
- **Cannot verify.** A check cannot be run in this environment (for example signing, or a platform that is not available). Mark it "not verified here"; do not claim it.

When stopping early, leave the working tree with tests green, record the state in LOOP.md, and say exactly what the user needs to decide or do.
