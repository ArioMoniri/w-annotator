# Decisions

A running record of decisions made about W Annotator: by the user, in a `grill-me` session, by the council, or by an agent that had to choose in order to continue.

How to use it:

- Add one row per decision, newest at the bottom. Use the date the decision was made (YYYY-MM-DD).
- Write the decision as a plain statement someone can act on. Give the reason in one line.
- Never edit or delete an earlier row. To change a decision, add a new row that says which one it supersedes.
- Check here before asking a question. If it is answered, do not ask again.

| Date | Question | Decision | Why |
| --- | --- | --- | --- |
| 2026-11-19 | Should the app have a light theme, and what happens to the image? | Three appearance modes: Light, Dark and System (default, follows the OS live). Viewports, the gaps between them and everything drawn over the image stay dark in both themes. | Requested in issue #1. A black surround is how images are read; a bright frame or bright overlays would change perceived contrast. |
| 2026-11-19 | Which light palette? | The optional light palette in `DESIGN.md` section 3, with `--text-3`, `--accent`, `--ok`, `--warn`, `--danger` darkened and `--border-control` added. | As drafted, several pairs fell below 4.5:1 for text or 3:1 for control borders. Measured values are in `DESIGN.md` 3.2. |
| 2026-11-19 | How do reports from inside the app reach GitHub? | The app composes the report and opens GitHub's pre-filled new-issue form in the browser; the user submits it as themselves. New dependency: the official Tauri opener plugin, allowed to open only URLs under `https://github.com/ArioMoniri/w-annotator/`. | A GitHub token in the app could be extracted from the binary. The app itself sends nothing, so the no-telemetry rule holds. |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
| 2026-11-19 | What do subtract and intersect mean between two segments? | The app offers only "Add" under Combine. `combine()` still takes all three. | A labelmap holds one segment per voxel, so two segments never overlap: subtract would never change anything and intersect would always empty the segment. |
| 2026-11-19 | Do grow, shrink and smooth count the edge of the volume as the edge of the segment? | No. Shrink and the opening half of smooth never wear a segment away from the edge of the scan; the closing half of smooth treats space past the edge as empty. | A segment cut off by the field of view continues outside it, and closing must not pull a segment towards the edge. |
| 2026-11-19 | What is a hole for "Fill holes"? | Space with no path to the edge of the volume through voxels that are not the segment. Only empty voxels in it are filled. | A pocket closed off by two segments together is not a hole in either, and another segment inside a cavity must be kept. |
| 2026-11-19 | When does a volume switch from mL to mm³? | Under 0.5 mL it is shown in mm³, otherwise in mL with one decimal. | Small lesions keep three significant figures; "0.8 mL" still reads as millilitres. |
| 2026-11-19 | What does "Paint over: Empty only" cover? | Any stroke that would change a voxel from one segment to another puts that voxel back. Erasing is not affected. | The setting is about painting; an eraser that silently skipped segments would surprise. |
