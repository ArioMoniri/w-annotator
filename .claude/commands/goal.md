---
description: Turn a rough request into a goal with acceptance criteria, write docs/process/GOAL.md, then hand it to the orchestrator.
argument-hint: <what you want built or changed>
---

The request:

$ARGUMENTS

If the request above is empty, ask the user what they want and stop.

Do the following in order.

1. **Enhance.** Launch the `prompt-enhancer` agent with the request exactly as written. It returns a spec with goal, constraints, acceptance criteria, out of scope, open questions and assumptions.

2. **Check the spec.** Reject and redo it if it adds features the user did not ask for, includes any AI feature, or has acceptance criteria that cannot be checked by a test, a number or a screenshot.

3. **Resolve open questions.** If any open question blocks planning, run the `grill-me` skill on the spec and fold the answers in. Questions that do not block planning stay listed as open.

4. **Write `docs/process/GOAL.md`.** Read the existing file first. If it holds an unfinished goal, show the user its title and status and ask whether to replace it. Then write the file using the structure already in it: Goal, Users, Constraints, Acceptance criteria (ID, criterion, how verified, status), Out of scope, Open questions. Set status to "active" and the date to today. Every new criterion starts as "not started".

5. **Reset the loop.** In `docs/process/LOOP.md`, set Current state to iteration 0, step "plan", with the new goal title. Keep the Loop log; do not delete earlier rows.

6. **Hand over.** Launch the `orchestrator` agent and ask it to plan the goal in GOAL.md. If it returns an assignment list rather than running the tasks itself, show the list to the user.

7. **Report** in a few lines: the goal in one sentence, the number of acceptance criteria, any open questions, and the first tasks. Then stop and wait; do not start implementing until the user says go or runs `/iterate`.
