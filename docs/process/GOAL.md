# Goal

| Field | Value |
| --- | --- |
| Title | W Annotator v1 |
| Status | active |
| Set on | 2026-11-19 |

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
- Rooms need a display name only: no accounts, no patient data sent.
- No telemetry. The only outbound traffic is the room relay and update checks to GitHub Releases.
- Built test first (`TDD.md`); every change meets `DOD.md`.
- Tests: Vitest for unit, Playwright for e2e against the Vite web build, `cargo test` for Rust.

## Acceptance criteria

Status is one of: not started, in progress, met (with evidence), not verified here.

The numeric targets are starting proposals. Confirm or change them with the `grill-me` skill and record the result in `DECISIONS.md`.

| ID | Criterion | Verified by | Status |
| --- | --- | --- | --- |
| AC-1 | Opens NIfTI (`.nii`, `.nii.gz`), MetaImage (`.mha`, `.mhd` + data file), NRRD (`.nrrd`, `.nhdr` + data file) and a DICOM series (folder or files), by file dialog and by drag and drop. Voxel values match the fixture exactly for every supported data type. | unit, e2e | not started |
| AC-2 | A corrupt, truncated or unsupported file gives a plain-language message naming the file and the problem. The app stays usable. No uncaught exceptions. | unit, e2e | not started |
| AC-3 | Orientation is correct for all four formats: an asymmetric phantom saved in each format renders identically, axial in radiological convention, with L/R/A/P/S/I markers on every 2D viewport. Oblique and anisotropic volumes keep true proportions. | unit, e2e screenshot | not started |
| AC-4 | A mask in any supported format overlays the volume voxel for voxel, with per-label colour, a global opacity control and per-label show/hide. A mask whose geometry does not match the volume is reported clearly and never drawn misaligned. | unit, e2e | not started |
| AC-5 | Mask tools work as specified and each is unit-tested at the voxel level: brush, eraser, threshold brush, scissors, fill, and interpolation between slices. Each has a toolbar button and a single-key shortcut. | unit, e2e | not started |
| AC-6 | Undo and redo cover every mask edit, at least 50 steps deep, one stroke per step, and restore the mask exactly. | unit, e2e | not started |
| AC-7 | Saving writes the mask in its original format with geometry and label values unchanged (read, write, read is identical). Unsaved changes are indicated, and closing with unsaved changes asks first. | unit, e2e | not started |
| AC-8 | MPR shows axial, coronal and sagittal views with linked crosshairs. A 3D view shows the volume with the mask. Switching layout keeps all edits. | e2e | not started |
| AC-9 | Window/level: drag to adjust, numeric W and L shown, one-step reset, and CT presets for brain, soft tissue, lung and bone. CT values are correct Hounsfield units after rescale. | unit, e2e | not started |
| AC-10 | Rooms: create or join with a display name and a room code. Participants are listed. An edit by one participant appears for the others within 300 ms on a local network. Concurrent edits converge to the same mask on every client. A client that drops and reconnects catches up. | unit, e2e with two contexts, cargo | not started |
| AC-11 | Room traffic contains only display name, presence and mask edits. No image data, file names, paths or DICOM tags. | unit on the protocol | not started |
| AC-12 | Performance on a 512 x 512 x 300 16-bit volume on a mid-range laptop: first image visible within 5 s of opening; slice scrolling and brush strokes at 30 fps or better. | manual measurement, recorded | not started |
| AC-13 | A first-time user (the `tester-user` agent) opens a volume and mask, corrects it with brush and eraser, and saves, with no help text beyond what is on screen, no dead ends and no critical or high bugs. | tester-user report | not started |
| AC-14 | UI is simple and calm: `ux-reviewer` reports no blocker or major issue against `docs/design/DESIGN.md`; the council verdict is APPROVE. | council | not started |
| AC-15 | Accessibility: every control is reachable and operable by keyboard with a visible focus ring; text contrast at least 4.5:1; motion under 250ms, off under reduced motion, and never on the medical image. | e2e keyboard pass, ux-reviewer | not started |
| AC-16 | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e` and `cargo test` all pass with zero skipped tests. | commands | not started |
| AC-17 | `pnpm tauri build` produces installable builds for macOS (signed and notarised; passes Gatekeeper), Windows and Linux, and each launches and opens a volume. | release workflow, manual per platform | not started |
| AC-18 | Auto-update: an installed build finds a newer GitHub Release, verifies its signature, installs it after the user agrees and restarts into the new version. | manual per platform | not started |
| AC-19 | No AI features in code, dependencies or copy. | watchdog | not started |

## Out of scope

- Any AI or machine-learning feature: auto-segmentation, model inference, assistants, suggestions.
- Accounts, login, permissions, cloud storage of images or masks.
- PACS or DICOMweb connections; DICOM SEG and RTSTRUCT.
- Sharing the image volume through a room. Each participant opens their own copy.
- Diagnostic or regulated clinical use. This is a research tool.
- Measurements and annotations beyond what mask correction needs, reporting, hanging protocols.
- Registration, resampling and fusion of multiple volumes.
- Mobile, tablet and a hosted web version. The web build exists for testing.
- Plugins, scripting and theming by users.

## Open questions

Resolve these with the `grill-me` skill and record the answers in `DECISIONS.md`.

- Q1: Where does the room relay run, and who operates it? Suggested: a small self-hostable relay in `server/`, with the address set in the app.
- Q2: How are concurrent edits to the same voxel resolved? Suggested: last write wins per voxel, ordered by the relay.
- Q3: Are masks single-label-per-voxel only, or may labels overlap? Suggested: one label per voxel.
- Q4: Which mask data types and maximum label count are supported? Suggested: unsigned 8-bit and 16-bit.
- Q5: Is 4D (time series) data in scope for v1? Suggested: no; show the first volume and say so.
- Q6: Largest volume the app must handle, and the memory limit? Suggested: 1024 x 1024 x 1000 16-bit as the upper bound, with a clear message beyond it.
- Q7: Which Linux package formats? Suggested: AppImage and `.deb`.
- Q8: Are the numeric targets in AC-6, AC-10 and AC-12 right?
