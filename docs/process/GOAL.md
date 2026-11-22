# Goal

| Field | Value |
| --- | --- |
| Title | W Annotator v1 |
| Status | active |
| Set on | 2026-11-19 |
| Statuses last brought up to date | 2026-11-22, after the council and gate review of 0.1.2 (`docs/reviews/0.1.2-council.md`) |

## Goal

Ship W Annotator: a simple, calm desktop app for opening medical volumes, overlaying segmentation masks and correcting those masks quickly, alone or together with others in a realtime room.

## Users

- Research annotators who correct many masks a day and are not technical.
- Radiologists who review and fix masks and must be able to trust orientation and measurements.

## Constraints

- Tauri v2 desktop app for macOS (signed and notarised), Windows and Linux.
- React, TypeScript, Vite, pnpm. Rendering and tools built on Cornerstone3D.
- No AI features of any kind.
- The UI is simple and calm; the image comes first. Design follows `docs/design/DESIGN.md`.
- Rooms need a display name only: no accounts. A shared-copy room sends the image and mask to its members; a view-through-host room sends guests 8-bit pictures of the slices they look at. File names, paths and DICOM tags are never sent (`docs/design/ROOMS.md`).
- No telemetry. The only outbound traffic is the room relay and update checks to GitHub Releases.
- Built test first (`TDD.md`); every change meets `DOD.md`.
- Tests: Vitest for unit, Playwright for e2e against the Vite web build, `cargo test` for Rust.

## Acceptance criteria

Status is one of: not started, in progress, met (with evidence), not verified here.

How to read the evidence column:

- Test files are named so the claim can be checked. "CI" means the nine jobs of `.github/workflows/ci.yml`, which were all green on `main` at the 0.1.2 release commit `6a9f410` (run 44939691847, 2026-11-21): web checks with the Playwright suite in Chromium, Rust, the Tauri build on three systems, desktop e2e on Linux and Windows, the Playwright suite in WebKit on macOS with the app's self-test, and one real LUNA16 case.
- "Met" means the criterion as written is covered by tests that pass. Where only part is covered the status is "in progress" and the gap is named. Nothing here was re-measured by hand unless it says so.
- The numeric targets in AC-6, AC-10 and AC-12 are still proposals (see Open questions).

### Version 1

| ID | Criterion | Verified by | Status and evidence |
| --- | --- | --- | --- |
| AC-1 | Opens NIfTI (`.nii`, `.nii.gz`), MetaImage (`.mha`, `.mhd` + data file), NRRD (`.nrrd`, `.nhdr` + data file) and a DICOM series (folder or files), by file dialog and by drag and drop. Voxel values match the fixture exactly for every supported data type. | unit, e2e | **Met.** `src/io/nifti.test.ts`, `metaimage.test.ts`, `nrrd.test.ts`, `dicom.test.ts`, `compressed.test.ts`, `index.test.ts`; `e2e/files.spec.ts` (dialog, drop, pairs); the CI real-data job opens a LUNA16 `.mhd` + `.raw` scan. MetaImage, NRRD and DICOM were not opened by hand in the 0.1.2 review. |
| AC-2 | A corrupt, truncated or unsupported file gives a plain-language message naming the file and the problem. The app stays usable. No uncaught exceptions. | unit, e2e | **Met.** `src/io/index.test.ts`, the "rejects" cases of each format's unit tests, `src/sample.test.ts`; `e2e/files.spec.ts`, `e2e/report.spec.ts` (an unexpected error offers a report). |
| AC-3 | Orientation is correct for all four formats: an asymmetric phantom saved in each format renders identically, axial in radiological convention, with L/R/A/P/S/I markers on every 2D viewport. Oblique and anisotropic volumes keep true proportions. | unit, e2e screenshot | **In progress.** Geometry and round trips: `src/viewer/geometry.test.ts`, `src/io/write.test.ts` (flipped axis, same-grid checks), `src/viewer/layout.test.ts`; markers and laterality on the sample were checked by the radiologist role in the 0.1.2 review, with no finding. Missing: one e2e test that renders the same asymmetric phantom from all four formats and compares; oblique and anisotropic volumes on screen were not verified in the review. |
| AC-4 | A mask in any supported format overlays the volume voxel for voxel, with per-label colour, a global opacity control and per-label show/hide. A mask whose geometry does not match the volume is reported clearly and never drawn misaligned. | unit, e2e | **Met.** `src/io/write.test.ts` (grid match, flipped and shifted masks refused), `src/io/labels.test.ts`; `e2e/annotate.spec.ts`, `e2e/files.spec.ts`; real-data job ("opens the image with its mask on the same grid"). |
| AC-5 | Mask tools work as specified and each is unit-tested at the voxel level: brush, eraser, threshold brush, scissors, fill, and interpolation between slices. Each has a toolbar button and a single-key shortcut. | unit, e2e | **Met.** `src/mask/brush.test.ts`, `scissors.test.ts`, `interpolate.test.ts`, `preview.test.ts`, `paintOver.test.ts`, `islands.test.ts`, `ops.test.ts`; `e2e/annotate.spec.ts`, `e2e/mask-tools.spec.ts`, `e2e/editing.spec.ts`; keys in `src/state/shortcuts.test.ts`. The rectangle and circle on one slice, the sphere and the threshold brush use Cornerstone's own tools and are covered by e2e, not by voxel-level unit tests of ours. |
| AC-6 | Undo and redo cover every mask edit, at least 50 steps deep, one stroke per step, and restore the mask exactly. | unit, e2e | **Met.** `src/mask/history.test.ts` (one stroke per step, limit of 100 steps), `src/mask/patch.test.ts`; `e2e/annotate.spec.ts`, `e2e/operations.spec.ts`, `e2e/mask-tools.spec.ts`, `e2e/council.spec.ts` (toast Undo, undo during a preview). |
| AC-7 | Saving writes the mask in its original format with geometry and label values unchanged (read, write, read is identical). Unsaved changes are indicated, and closing with unsaved changes asks first. | unit, e2e | **Met.** `src/io/write.test.ts`, `src/io/dicomseg.test.ts`; `e2e/annotate.spec.ts` (NIfTI and DICOM SEG reopen identical), `e2e/files.spec.ts` (closing asks), `e2e/ux.spec.ts` (unsaved state in the status bar); desktop e2e saves through the native dialog (`e2e-desktop/app.test.mjs`). |
| AC-8 | MPR shows axial, coronal and sagittal views with linked crosshairs. A 3D view shows the volume with the mask. Switching layout keeps all edits. | e2e | **Met.** `e2e/annotate.spec.ts` (crosshair), `e2e/layout.spec.ts` (layouts keep slice, zoom, window and mask; the 3D view follows every mask change). |
| AC-9 | Window/level: drag to adjust, numeric W and L shown, one-step reset, and CT presets for brain, soft tissue, lung and bone. CT values are correct Hounsfield units after rescale. | unit, e2e | **Met.** `src/viewer/window.test.ts`, `src/io/dicom.test.ts` (rescale to CT numbers); `e2e/windowing.spec.ts`, `e2e/ux.spec.ts` (HU shown only for CT-like values). |
| AC-10 | Rooms: create one of two kinds (shared copy, view through host) or join with a display name and an invite link that works once and expires. Participants are listed; the host can remove them and end the room. An edit by one participant appears for the others within 300 ms on a local network. Concurrent edits converge to the same mask on every client. A client that drops and reconnects catches up. | unit, e2e with two contexts, cargo | **In progress.** Covered: `e2e/room.spec.ts` (both kinds, single-use and expiring links, remove, end, convergence, offline and merge), `e2e/room-server.spec.ts` (server restart), `src/collab/*.test.ts`, `cargo test` in `relay/`. The 0.1.2 review found that a view-through-host guest who is offline for 15 s was put out with a wrong message (M1) and got unusable window presets (M2); both are fixed in 0.1.3, with tests in `e2e/room.spec.ts`. Open: the 300 ms target has not been measured, and the council has not looked at rooms again since the fixes. |
| AC-11 | Room traffic contains display name, presence and mask edits; in a shared-copy room also the image, in a view-through-host room 8-bit pictures of the slices a guest looks at. Never file names, paths or DICOM tags. Payloads are encrypted between the apps. Supersedes the earlier "no image data" (`docs/design/ROOMS.md` A8). | unit on the protocol, e2e | **Met by tests and by reading; no wire capture.** `src/collab/protocol.test.ts`, `crypto.test.ts`, `transfer.test.ts`, `hostview.test.ts`; `e2e/room.spec.ts` ("sees and edits without receiving the files"). The watchdog read the handshake and frames in the 0.1.2 review and found no name or file name in the clear. |
| AC-12 | Performance on a 512 x 512 x 300 16-bit volume on a mid-range laptop: first image visible within 5 s of opening; slice scrolling and brush strokes at 30 fps or better. | manual measurement, recorded | **Not verified here.** No measurement has been recorded. |
| AC-13 | A first-time user (the `tester-user` agent) opens a volume and mask, corrects it with brush and eraser, and saves, with no help text beyond what is on screen, no dead ends and no critical or high bugs. | tester-user report | **In progress.** The 0.1.2 review: 0 critical, 2 high (B1, B2, both in view-through-host rooms), 6 medium, 6 low; one dead end (D1). Open, brush, erase and save worked. Both high bugs and the medium ones are fixed in 0.1.3; the tester has not been run again since. |
| AC-14 | UI is simple and calm: `ux-reviewer` reports no blocker or major issue against `docs/design/DESIGN.md`; the council verdict is APPROVE. | council | **In progress.** 0.1.2 review: all three roles APPROVE WITH CHANGES; four major UX issues, all in rooms. Needs a second council run after the fixes. |
| AC-15 | Accessibility: every control is reachable and operable by keyboard with a visible focus ring; text contrast at least 4.5:1; motion under 250ms, off under reduced motion, and never on the medical image. | e2e keyboard pass, ux-reviewer | **In progress.** `e2e/settings.spec.ts`, `e2e/ux.spec.ts`, `src/ui/focus.test.ts` (Tab, focus return, rings), `e2e/tour.spec.ts` (reduced motion), `e2e/council.spec.ts` (contrast computed in both themes for the two places the review measured under 4.5:1). Not verified: a screen reader, and reduced motion outside the tour. |
| AC-16 | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e` and `cargo test` all pass with zero skipped tests. | commands | **Met on `main` at 0.1.2 in CI.** In the review sandbox one e2e run had 1 failure of 209 while the machine was out of memory; the test passed 3 of 3 alone. `e2e/real-data.spec.ts` no longer registers a skipped placeholder. On `fix/council-0-1-2`: lint and typecheck clean, 1014 unit tests and 226 e2e tests passed in one run in Chromium on Linux; `cargo test` was not run there (no Rust changed). With the polish and rooms fixes merged in, as 0.1.3: 1056 unit, 242 e2e (one run, Chromium, Linux) and 160 Rust tests passed, none skipped or ignored. |
| AC-17 | `pnpm tauri build` produces installable builds for macOS (signed and notarised; passes Gatekeeper), Windows and Linux, and each launches and opens a volume. | release workflow, manual per platform | **Met by the workflows; not verified by hand.** CI builds the app on macOS, Windows and Linux and drives the built app on Linux and Windows; the macOS job runs the built app's self-test. The Release workflow for 0.1.2 passed, including its signature check (run 44922414843). Nobody in this loop has installed a release on a Mac or a Windows machine. |
| AC-18 | Auto-update: an installed build finds a newer GitHub Release, verifies its signature, installs it after the user agrees and restarts into the new version. | manual per platform | **Not verified here.** The Release workflow checks `latest.json`; an update from one installed version to the next has not been watched in this loop. `docs/RELEASING.md` says how to test it by hand. |
| AC-19 | No AI features in code, dependencies or copy. | watchdog | **Met.** Watchdog, 0.1.2 review: no inference, model or ML dependency, and no such copy. |

### Added since the goal was set (0.1.0 to 0.1.2)

These shipped without a criterion and were recorded only in `DECISIONS.md`. The criteria below say what "works" means for each, so the gate can check them.

| ID | Criterion | Verified by | Status and evidence |
| --- | --- | --- | --- |
| AC-20 | DICOM SEG: a segmentation object opens as a mask on its image, and a mask can be saved as DICOM SEG and reopens with the same voxels, segment names and colours. | unit, e2e | **Met.** `src/io/dicomseg.test.ts`; `e2e/annotate.spec.ts` ("a mask saved as DICOM SEG reopens with the same voxels and names"). It has shipped since 0.1.0 and no version's entry in `CHANGELOG.md` names it. |
| AC-21 | Window presets beyond AC-9: a menu on the status bar's window read-out with any tool; CT presets with a stated source for each number; windows worked out from the image where values have no unit; saved presets (up to 12); keys to step through them; a window taken from a box drawn on the image. Display only: no voxel value changes. | unit, e2e | **Met.** `src/viewer/window.test.ts`; `e2e/windowing.spec.ts`. Sources and the two pancreas presets: `DECISIONS.md`, 2026-11-21 and 2026-11-22 (the last Pancreas row). Not verified on a real MR volume. |
| AC-22 | Zoom: a menu on the status bar's zoom read-out with Zoom in, Zoom out, Fit and Actual size, and keys for the first three. Resizing the window or the panel keeps millimetres per pixel; maximising a view is the one exception. | unit, e2e | **Met.** `e2e/windowing.spec.ts`, `e2e/layout.spec.ts`, `src/viewer/layout.test.ts`. |
| AC-23 | Scissors: freehand outline, erase outside, this slice or all slices; the active segment only. A cut that changed anything not on screen says how much, with Undo. | unit, e2e | **Met.** `src/mask/scissors.test.ts`; `e2e/mask-tools.spec.ts`, `e2e/council.spec.ts` (erase outside on one slice, zoomed in). |
| AC-24 | Islands: Remove island and Keep island by clicking, Keep largest, Remove small, and Split into separate segments (at most 20, asking first when many). Each is one undo step and says what it changed. | unit, e2e | **Met.** `src/mask/islands.test.ts`, `src/mask/ops.test.ts`; `e2e/mask-tools.spec.ts`, `e2e/operations.spec.ts`, `e2e/council.spec.ts`. Undo of a split removes the rows it made since 0.1.3 (S5). |
| AC-25 | Paint over: everything, empty only, or only inside one segment, for every tool that adds voxels and for Fill between slices. Erasing is never limited. | unit, e2e | **Met.** `src/mask/paintOver.test.ts`; `e2e/mask-tools.spec.ts`, `e2e/operations.spec.ts`. |
| AC-26 | Fill between slices shows a preview that is not part of the mask and is never sent to a room; Apply writes it as one undo step; Cancel, another tool or segment, painting, undo, redo or saving drops it. | unit, e2e | **Met.** `src/mask/preview.test.ts`; `e2e/mask-tools.spec.ts`, `e2e/council.spec.ts`. |
| AC-27 | Alt-click picks the segment under the cursor with any tool. "Smooth pixels" switches display interpolation only. | unit, e2e | **Met.** `src/mask/pick.test.ts`; `e2e/mask-tools.spec.ts`. |
| AC-28 | Layouts, any view in any pane, reference lines, several masks on one image (one edited, the others outlines), a Files section, autosave and recovery, trackpad gestures, Open with, a welcome tour with a sample scan, settings and rebindable shortcuts, light and dark themes, a report dialog (0.1.1). | unit, e2e | **Met by tests.** `e2e/layout.spec.ts`, `files.spec.ts`, `autosave.spec.ts`, `gestures.spec.ts`, `tour.spec.ts`, `sample.spec.ts`, `settings.spec.ts`, `theme.spec.ts`, `report.spec.ts`, and their unit tests under `src/`. Open with and real trackpad hardware: not verified by hand. |

## Out of scope

- Any AI or machine-learning feature: auto-segmentation, model inference, assistants, suggestions.
- Accounts, login, permissions, cloud storage of images or masks.
- PACS or DICOMweb connections; RTSTRUCT. (DICOM SEG was listed here while the app already read and wrote it; it is AC-20 now.)
- Diagnostic or regulated clinical use. This is a research tool.
- Measurements and annotations beyond what mask correction needs, reporting, hanging protocols.
- Registration, resampling and fusion of multiple volumes.
- Mobile, tablet and a hosted web version. The web build exists for testing.
- Plugins, scripting and theming by users.

## Open questions

Answered questions are not repeated here. They are in `DECISIONS.md`, which is the place to check before asking:

- Q1, where the room server runs and who runs it: the rows "Which address does the host of a room hosted by the app use?" (2026-11-19) and "Rooms v2: a room hosted by the desktop app" (2026-11-21). The server is `relay/`, self-hosted, or the desktop app as host.
- Q2, concurrent edits to the same voxel: the rows "Rooms v2: how are segment changes sent?" and "Rooms v2: how is offline work merged?" (2026-11-21). Edits follow one order set by the room server.
- Q3, overlapping labels: the row "What do subtract and intersect mean between two segments?" (2026-11-19). A labelmap holds one segment per voxel.

Still open, for the owner. Where the code already does something, that is said, but it has no decision row:

- Q4: Which mask data types and how many labels? As built: a mask holds up to 255 segments ("A mask can hold up to 255 segments.").
- Q5: Is 4D (time series) data in scope? As built: a 4D NIfTI opens on its first volume (`src/io/nifti.ts`). Whether the app should say so is not decided.
- Q6: The largest volume the app must handle, and what it says beyond that. Suggested: 1024 x 1024 x 1000 16-bit as the upper bound, with a clear message. As built: an operation that runs out of memory says so; there is no stated limit.
- Q7: Which Linux package formats? As built: every format Tauri bundles (`"targets": "all"` in `src-tauri/tauri.conf.json`).
- Q8: Are the numeric targets right: 50 undo steps (AC-6; the app keeps 100), 300 ms for an edit to reach the others (AC-10; never measured), 5 s and 30 fps (AC-12; never measured)?
