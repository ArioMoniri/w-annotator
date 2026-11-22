# Test-driven development

All behaviour in this repo is written test first.

## The cycle

1. **Red.** Write one small test for the next piece of behaviour. Run it. It must fail, and for the reason you expect (an assertion, not a typo or missing import).
2. **Green.** Write the least code that makes it pass. Run the whole file's tests.
3. **Refactor.** Tidy code and tests with everything green. No new behaviour in this step.

Then repeat. Commit at green.

## Rules

- No production code without a failing test that asks for it.
- A bug fix starts with a test that reproduces the bug.
- One behaviour per test. Name it as a sentence: `fills a closed region without leaking through a diagonal gap`.
- Test behaviour through the public interface, not private details. A refactor should not break tests.
- Never skip, `.only`, comment out, delete or loosen a test to get to green. If a test is wrong, fix it and say why in the commit.
- Tests are deterministic: no real network, no real clock, no dependence on order. Seed anything random.
- Keep unit tests fast. The whole unit suite should run in well under a minute.
- Fixtures are small synthetic volumes built in code or tiny files checked in (a few voxels per side). The bundled sample and one CI job use a scan from an open, de-identified dataset with attribution (LUNA16; `DECISIONS.md`, 2026-11-19). Never use private patient data.
- Do not mock what you are testing. Mock only the edges: file system, network, Tauri commands, the GPU.

## What goes where

### Unit tests (Vitest, next to the code as `*.test.ts`) — required

Put logic in plain TypeScript modules that do not need a DOM, WebGL or Cornerstone to run, so it can be tested here.

| Area | Must cover |
| --- | --- |
| File parsers | NIfTI (`.nii`, `.nii.gz`; NIfTI-1 and -2; qform, sform and the fallback when both are missing), MetaImage (`.mha`, and `.mhd` with a separate or compressed data file), NRRD (attached and detached, raw and gzip), DICOM series (slice ordering, rescale slope and intercept, multi-frame). Every data type and both byte orders. Truncated, corrupt and unsupported files give a clear error, never a crash or a silently wrong volume. Writers round-trip: read, write, read gives identical voxels and geometry. |
| Geometry and orientation | Direction matrix, spacing and origin from each format; index ↔ world transforms; RAS/LPS conversion; oblique and anisotropic volumes; orientation marker letters for each view; mask-to-image geometry comparison with tolerance. Use an asymmetric phantom so a left-right flip fails the test. Lengths in mm and volumes in mL. |
| Mask operations | Brush and eraser stamps (shape, size, edges of the volume), threshold brush (inclusive bounds), scissors (inside and outside, self-crossing outlines), fill (2D and 3D, connectivity, no leaks), interpolation between slices, label rules (active label, overwrite and protect), and the exact set of voxels each operation reports as changed. |
| Undo and redo | Each operation undoes to the identical previous mask; redo restores it; a new edit clears redo; history limit; one stroke is one step; memory stays bounded (store diffs, not copies). |
| Sync protocol | Message encode and decode, versioning, applying remote edits, concurrent edits converge to the same mask on every client regardless of arrival order, duplicate and out-of-order messages, join with catch-up, reconnect, malformed messages rejected. Only display name and mask edits are in the payload. |
| Everything else with logic | Window/level presets and maths, shortcut mapping, state reducers, formatting of values shown to the user. |

### Rust tests (`cargo test` in `src-tauri/`, and in `server/` if the relay is Rust)

Tauri commands, file access and path handling, update configuration, and the room relay (join, leave, broadcast, limits, bad input).

### End-to-end tests (Playwright in `e2e/`, against the Vite web build)

Only what needs a real browser and the pieces wired together. Keep these few and stable.

- Open a volume and a mask; orientation markers are shown.
- Paint a stroke, undo, redo; the canvas changes and changes back.
- Each tool can be selected by click and by shortcut.
- Switch between MPR and 3D without losing edits.
- Save and reopen; the edit is kept.
- Two browser contexts in one room see each other's edits.
- Keyboard-only pass through the main flow.
- Screenshot checks of the key states listed in `DOD.md`.

Do not test parsing, geometry or mask maths through the UI. If an e2e test finds a logic bug, reproduce it in a unit test first, then fix it.

### Not automated

Signing, notarisation, installers and auto-update are checked by the release workflow and a manual run on each platform. Say "not verified here" rather than claiming them.

## Commands

```
pnpm test          # unit, once
pnpm test <file>   # one file while working
pnpm e2e           # end-to-end
cargo test         # Rust (run in src-tauri/)
```

Chromium is already installed for Playwright. Do not run `playwright install`.
