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
