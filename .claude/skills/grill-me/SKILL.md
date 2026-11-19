---
name: grill-me
description: Interrogate the user about a spec, plan or design until nothing is ambiguous. Asks one question at a time, walks every branch of the decision tree, offers a recommended answer for each question, and records answers in docs/process/DECISIONS.md. Use when the user says "grill me", before planning a new goal, or whenever a spec has open questions.
---

# Grill me

Question the user about the spec until you both understand it the same way. Be relentless and polite. Do not start building.

## Before the first question

1. Read the thing being grilled (default: `docs/process/GOAL.md`), then `docs/process/DECISIONS.md`, `CLAUDE.md`, and `docs/design/DESIGN.md` if it exists.
2. Explore the codebase for anything that answers a question. If the code or a recorded decision already answers it, do not ask. State the answer you found and move on.
3. Sketch the decision tree for yourself: the top-level choices, and what each choice opens up beneath it.

## Asking

- **One question per message.** Never a list. Wait for the answer.
- Each question has this shape:

  ```
  Q<n> (<branch>): <the question, specific enough to answer in a sentence>
  Why it matters: <what changes in the build depending on the answer>
  Options: A) ... B) ... C) ...
  Recommended: <option> — <one-line reason>
  ```

- Go depth first. Finish a branch, including the questions an answer opens up, before starting the next one.
- Resolve dependencies in order: ask the question that other questions depend on first.
- If an answer is vague ("whatever is best", "the usual"), offer your recommendation as the answer and ask for a yes or no.
- If an answer contradicts an earlier one or a recorded decision, point at both and ask which stands.
- If the user says "you decide", take the recommended answer and record it as decided by Claude.
- If the user does not know, record it as an open question with an owner and carry on with the other branches.
- Do not ask about things that do not change what gets built.

## Branches to cover for this product

Skip any that the spec does not touch.

- **Users and task**: who does this, how often, what they do just before and after.
- **Files**: formats (NIfTI, MetaImage, NRRD, DICOM), sizes, compressed files, multi-file series, 4D, masks whose geometry differs from the image, how saving preserves format and header.
- **Geometry**: orientation convention, oblique and anisotropic volumes, units, what happens on a mismatch.
- **Mask editing**: tools involved, label model (single or multi-label, overlap allowed or not), 2D or 3D behaviour, undo depth and granularity, behaviour at volume edges.
- **Views**: MPR, 3D, layouts, linking, window/level.
- **Rooms**: who can join, conflict handling, offline and reconnect, what is sent over the wire, where the relay runs.
- **Platforms**: macOS, Windows, Linux differences; signing, notarisation, auto-update.
- **Performance**: target volume size, memory limit, acceptable load and stroke latency.
- **UI**: where the control lives, its default, its shortcut, what it replaces, empty and error states, exact copy.
- **Failure**: bad file, out of memory, lost connection, crash with unsaved edits.
- **Privacy**: anything leaving the machine.
- **Testing**: how each acceptance criterion is verified, and with which fixture.
- **Out of scope**: confirm what is deliberately excluded. AI features are always excluded.

## Recording

After each answer, append a row to the table in `docs/process/DECISIONS.md` straight away, so nothing is lost if the session ends:

| Date | Question | Decision | Why |

Use today's date, the question in short form, the decision as a plain statement, and the reason. Replace an empty placeholder row if one is left; otherwise add a row. Never rewrite an earlier decision: add a new row that says it supersedes the old one.

## Stopping

Stop when every branch is walked and you can state, for each acceptance criterion, exactly what will be built and how it will be checked. Then:

1. Summarise the decisions made in this session as a short list.
2. List remaining open questions with owners, or say there are none.
3. Update the spec (GOAL.md by default) so its acceptance criteria, out-of-scope list and open questions match the decisions.
4. Ask the user to confirm the summary before any planning starts.

Stop early if the user says stop. Record what was decided and list what is still open.
