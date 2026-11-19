# Decisions

A running record of decisions made about W Annotator: by the user, in a `grill-me` session, by the council, or by an agent that had to choose in order to continue.

How to use it:

- Add one row per decision, newest at the bottom. Use the date the decision was made (YYYY-MM-DD).
- Write the decision as a plain statement someone can act on. Give the reason in one line.
- Never edit or delete an earlier row. To change a decision, add a new row that says which one it supersedes.
- Check here before asking a question. If it is answered, do not ask again.

| Date | Question | Decision | Why |
| --- | --- | --- | --- |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
| 2026-11-19 | How is the real desktop app tested in CI? | Linux and Windows: WebDriver through `tauri-driver`, in `e2e-desktop/`. macOS: the Playwright suite in WebKit plus a self-test the built app runs on itself. | There is no WebDriver for WKWebView. |
| 2026-11-19 | How do tests get past the native save dialog? | `W_E2E_SAVE_DIR`, read at launch, makes `pick_save_path` return a path in that folder without a dialog. `W_SELFTEST` makes the app test itself and quit. Both are in every build and do nothing unless set. | A native dialog cannot be driven; a separate test build would not be the app that ships. |
| 2026-11-19 | Which address does the host of a room hosted by the app use? | The host connects over `127.0.0.1`; the invite link carries the network address, or `127.0.0.1` with a note when there is none. | The host's own connection must not depend on a firewall or on the network being up. |
| 2026-11-19 | May CI use real scans? | One LUNA16 chest CT with its lung mask (CC BY 4.0, public and de-identified), range-fetched from Zenodo and cached, in its own job. Nothing from it enters the repository. | The licence allows it, a single case is 31 MB, and it keeps real-data regressions visible. |
