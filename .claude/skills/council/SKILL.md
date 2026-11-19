---
name: council
description: Run the review council on a spec or a build. Launches the radiologist, annotator-user and ux-reviewer agents in parallel, merges their verdicts and lists the required changes. Use before building a significant spec and after each build in the improvement loop.
---

# Council

Three reviewers look at the same thing independently, then you merge what they say.

| Member | Agent | Looks at |
| --- | --- | --- |
| Radiologist | `radiologist` | Clinical workflow, orientation and laterality, W/L, measurement, editing real cases |
| Annotator | `annotator-user` | Learnability and speed of bulk mask correction |
| UX reviewer | `ux-reviewer` | Hierarchy, density, copy, accessibility against `docs/design/DESIGN.md` |

## 1. Decide what is under review

- **Spec review**: a spec file, by default `docs/process/GOAL.md`. No build needed.
- **Build review**: the current working tree. Reviewers need screenshots.

If the user did not say which, review the build when there are UI changes in the diff, otherwise the spec.

## 2. Prepare evidence (build review only)

Capture screenshots once and share them, so all three judge the same thing:

- Chromium is preinstalled and `require('playwright')` works. Never run `playwright install`.
- Start `pnpm dev` in the background. With a short Node script kept outside the repo, capture at 1440x900: empty state, volume loaded, volume with mask, each edit tool active, MPR, 3D, a room with two participants, one error state.
- Save them in a temporary directory and note the absolute paths. Stop the dev server afterwards.

If the app cannot be started, say so and run a spec review instead. Do not let reviewers guess at the UI from the code.

## 3. Launch all three in one message

Send the three agent calls together so they run in parallel. Give each the same brief:

- what is under review and the goal it serves (path to GOAL.md and the relevant acceptance criteria),
- the screenshot paths, or the spec path,
- what changed since the last council, if there was one,
- "Use your standard output format. Say what you could not verify."

Do not show one reviewer another's findings.

## 4. Merge

Read the three reports and produce one result.

- **Overall verdict** is the strictest of the three: any REJECT gives REJECT; otherwise any APPROVE WITH CHANGES gives CHANGES REQUIRED; otherwise APPROVE.
- **Deduplicate.** If two members raise the same issue, list it once and name both.
- **Required changes** are: every radiologist blocker, every annotator "got stuck" item, every ux-reviewer blocker or major issue, and anything two or more members raised.
- **Conflicts.** When members disagree, do not average. State both positions and recommend one, in this order of priority: correctness and safety of the image, then not losing work, then speed of the core editing task, then visual polish. Record the choice in `docs/process/DECISIONS.md`.
- Drop any request for AI features or for scope outside GOAL.md, and say that you dropped it.
- Keep requests that add UI honest: a new control is a required change only if a member got stuck without it.

## 5. Output

```
COUNCIL: APPROVE | CHANGES REQUIRED | REJECT
Reviewed: <spec path or build + screenshot directory>

Verdicts
- Radiologist: <verdict> — <one line>
- Annotator: <verdict> — <one line>
- UX reviewer: <verdict> — <one line>

Required changes (in priority order)
1. <change> — raised by <who> — done when <observable check>
2. ...

Optional
- <change> — raised by <who>

Conflicts and how they were resolved
- <topic>: <A says, B says> → <decision and why>

Dropped
- <request> — <out of scope | AI feature>

Not verified by anyone
- <area>
```

Then append one row to the Loop log in `docs/process/LOOP.md` if this ran as part of an iteration. Do not start fixing; hand the required changes back to the orchestrator or the user.
