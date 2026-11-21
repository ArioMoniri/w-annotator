# W Annotator

A desktop app for opening medical volumes, overlaying segmentation masks and correcting them quickly, alone or with others in a realtime room.

- Tauri v2 (macOS signed and notarised, Windows, Linux), React, TypeScript, Vite, pnpm.
- Built on Cornerstone3D, the engine behind OHIF Viewers.
- Formats: NIfTI (`.nii`, `.nii.gz`), MetaImage (`.mha`, `.mhd`), NRRD, DICOM.
- Mask tools: brush, eraser, threshold brush, scissors, fill, interpolation. MPR and 3D views.
- Rooms for co-editing a mask, joined with a display name only.
- Auto-update through GitHub Releases.

## Commands

```
pnpm dev          # run the app in development
pnpm test         # unit tests (Vitest)
pnpm e2e          # end-to-end tests (Playwright, against the Vite web build)
pnpm lint
pnpm typecheck
pnpm tauri build  # desktop build
cargo test        # Rust tests, run in src-tauri/
```

Chromium is preinstalled for Playwright. Never run `playwright install`.

## Layout

```
src/         web app (React + TypeScript)
src-tauri/   Rust side of the Tauri app
server/      room relay
e2e/         Playwright tests and fixtures
e2e-webkit/  checks in WebKitGTK, the engine nearest the macOS app (`docs/process/TESTING-WEBKIT.md`)
public/      files shipped as they are; `sample/` is the scan the welcome tour opens
scripts/     one-off build scripts (`make-sample.mjs` rebuilds the sample)
docs/        process and design docs
```

Placeholder; update it as the code takes shape.

## Rules

1. **Test first.** Red, green, refactor. No production code without a failing test. See `docs/process/TDD.md`.
2. **Done means done.** A change is finished only when every line of `docs/process/DOD.md` holds, with evidence. Run the checks; do not assume.
3. **No AI features.** No model inference, auto-segmentation or assistants in the app, and no copy that suggests them.
4. **Never skip tests.** No `.skip`, `.only`, `#[ignore]`, commented-out tests or weakened assertions.
5. **Keep the UI simple and calm.** The image comes first. Do not add controls, dialogs or settings the goal does not ask for. Follow `docs/design/DESIGN.md`.
6. **Brief, human copy.** Short, plain, sentence case. No jargon, exclamation marks or emoji. Errors say what happened and what to do.
7. **Protect the image.** Never alter orientation, laterality, spacing or voxel values for convenience. Never animate the medical image.
8. **Privacy.** Rooms send display name and mask edits only. No telemetry. Never use real patient data in tests.
9. **Stay in scope.** Build what `docs/process/GOAL.md` asks for. Record decisions in `docs/process/DECISIONS.md`.
10. **Cross-platform.** Everything works on macOS, Windows and Linux. If you could not check a platform, say "not verified".

## Process

| Doc | What it is |
| --- | --- |
| `docs/COLLABORATING.md` | How to add a feature, what not to break, CI, releases and auto-update |
| `docs/process/GOAL.md` | Current goal and acceptance criteria |
| `docs/process/LOOP.md` | The iteration loop, its current state and log |
| `docs/process/TDD.md` | Test-first rules and what must be unit-tested |
| `docs/process/DOD.md` | Definition of done |
| `docs/process/DECISIONS.md` | Decisions already made; check before asking |
| `docs/design/DESIGN.md` | Design spec and tokens (owned by the designer agent) |
| `.claude/workflows/build-review-loop.md` | How the agents work together |

Commands: `/goal <text>` sets a new goal; `/iterate` runs one pass of the loop.

Skills: `grill-me` (question a spec until nothing is ambiguous), `council` (radiologist, annotator and UX review in parallel).

Agents in `.claude/agents/`:

| Agent | Use it for |
| --- | --- |
| orchestrator | Breaking a goal into tasks and keeping the loop state |
| prompt-enhancer | Turning a rough request into a spec |
| designer | Layout, components, tokens, copy |
| motion-designer | Transitions and micro-interactions |
| radiologist | Clinical review: orientation, W/L, measurement, editing |
| annotator-user | Learnability and speed of bulk mask correction |
| ux-reviewer | UI critique against the design spec |
| tester-user | Exploratory testing as a first-time user |
| watchdog | Read-only final gate: PASS or FAIL |
