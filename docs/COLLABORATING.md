# Working on W Annotator

A guide for a new collaborator and for any coding agent working on their behalf. It says how to add a feature, fix a bug and ship a release without breaking what is already there. Read it once, then keep `CLAUDE.md` open: its ten rules apply to every change.

Other pages go deeper and are linked where they matter: [`CONTRIBUTING.md`](../CONTRIBUTING.md), [`docs/RELEASING.md`](RELEASING.md), [`docs/process/TDD.md`](process/TDD.md), [`docs/process/DOD.md`](process/DOD.md), [`docs/design/DESIGN.md`](design/DESIGN.md).

## The short version

1. Branch from the latest `main`. Never commit to `main` directly.
2. Write a failing test, then the code, then tidy.
3. Run the checks locally.
4. Open a pull request. CI runs on macOS, Windows and Linux.
5. Merge only when all nine CI jobs are green.
6. A release is a separate, deliberate step: bump the version, then run the Release workflow.

## Set up

You need Node.js with pnpm, a stable Rust toolchain and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
pnpm install
```

```bash
pnpm tauri dev
```

`pnpm dev` runs the web build alone in a browser, which is enough for most UI work. The room relay lives in `relay/`; the end-to-end tests start it for you.

## Where things are

| Path | What it holds |
| --- | --- |
| `src/io/` | File formats: NIfTI, MetaImage, NRRD, DICOM, DICOM SEG. Pure TypeScript. |
| `src/viewer/` | The Cornerstone3D wrapper (`engine.ts`), layouts, gestures. |
| `src/mask/` | Mask edits as patches, undo history, interpolation, segment operations. |
| `src/session.ts` | The controller: opening files, edits, undo, saving, rooms. |
| `src/collab/` | Room protocol and client. |
| `src/state/` | Store, settings, shortcuts, theme. |
| `src/ui/` | React components and `styles.css`. |
| `src-tauri/` | The Rust side: file access, Open With, hosting a room, recovery, updater. |
| `relay/` | The room relay server. |
| `e2e/` | Playwright tests against the web build. |
| `e2e-desktop/` | Tests that drive the built desktop app, and its self-test. |
| `e2e-webkit/` | Checks in WebKitGTK, the engine nearest the macOS app. |
| `docs/` | Design, process, reviews, releasing. |

## Adding a feature

1. **Check it is in scope.** Read the Scope section of `CONTRIBUTING.md`. No AI features, no telemetry, no new controls without a clear need. For anything larger than a fix, open an issue first and agree it with the owner.
2. **Check what is already decided.** `docs/process/DECISIONS.md` records choices that were made on purpose. Do not undo one silently; if you must change one, add a new row that says why.
3. **Branch.** `git switch -c feat/short-name origin/main`.
4. **Design before code**, for anything visible. Follow `docs/design/DESIGN.md` for layout, tokens and copy, and update that file when you add a control.
5. **Test first.** Pure logic gets a Vitest unit test beside the file (`thing.test.ts`). A user-visible behaviour gets a Playwright test in `e2e/`; `e2e/helpers.ts` has helpers such as `openPhantom` and `maskVoxels`. Rust gets `cargo test`.
6. **Put the code in the right layer.** Keep file parsing in `src/io/`, mask maths in `src/mask/`, and Cornerstone calls inside `src/viewer/engine.ts`. Components call the session and the store; they do not call Cornerstone.
7. **Update the docs a user or the next person will read:** a line in `CHANGELOG.md` under "Unreleased", the README if the feature list changed, and `docs/process/DECISIONS.md` for any choice you made.

### Things a feature must not break

These are the places where a change that looks harmless has caused real bugs.

- **Every mask edit goes through the session's edit path** (`editMask` / `flushEdits` in `src/session.ts`). That one path feeds undo and redo, autosave and recovery, and room sync. A tool that writes voxels any other way will look fine alone and corrupt all three.
- **Never change the image.** Orientation, laterality, spacing and voxel values are never altered for convenience. Display options change how the image is drawn, not its data.
- **Opening or closing the sidebar and resizing the window keep the image at the same physical scale.** Two views are the exception and show their image enlarged: a maximised view, and the view in the large pane of "1 large and 3 stacked". Each shrinks back by as much when it leaves. Tests assert all of it.
- **Shortcuts are rebindable.** Register a new key in `src/state/shortcuts.ts`; do not add a raw key listener.
- **Labels differ by platform.** A Mac shows `⌘` and `⌥` where Windows and Linux show `Ctrl` and `Alt`. Use the helpers in `src/ui/common.tsx`, and in tests expect the label for the platform the test runs on.
- **The options strip must not overflow, and must not shorten words.** It tightens itself in steps and has tests at narrow widths: hints go first, then groups of buttons become lists with the same names. Add controls sparingly.
- **Dialogs use the shared `Modal`,** which handles Tab, Shift+Tab and Esc on every platform.
- **Rooms send display names and mask edits only.** Nothing else leaves the machine. There is no telemetry and the app holds no GitHub token.
- **No private patient data,** anywhere: tests, screenshots, issues, the README. Fixtures are synthetic, or from open datasets with attribution such as the LUNA16 sample.

### WebKit is not Chromium

The macOS app runs in WebKit and the Linux app in WebKitGTK; only Windows is Chromium. Bugs that appear only on a Mac have come from exactly this. Avoid Chromium-only APIs, do not rely on CSS grid auto-placement for hidden cells, and handle focus yourself instead of trusting the browser's Tab order. `pnpm webkit:check` runs a quick pass in WebKitGTK on Linux; the macOS CI job is the real proof. See [`docs/process/TESTING-WEBKIT.md`](process/TESTING-WEBKIT.md).

## Checks before you push

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm e2e --trace off
```

If Rust changed, also run these in `src-tauri/` and `relay/`:

```bash
cargo fmt --all --check
```

```bash
cargo clippy --workspace --all-targets --locked -- -D warnings
```

```bash
cargo test --workspace --locked
```

Chromium for Playwright is expected to be installed already in agent environments; do not run `playwright install` there. Tests are never skipped, narrowed with `.only`, commented out or loosened to get a green run. A test that fails on one platform only is telling you something about that platform: find out what.

## Pull requests and CI

Open a pull request against `main` using the template. Say which platforms you checked and write "not verified" for the rest. CI runs nine jobs:

| Job | What it proves |
| --- | --- |
| Web (lint, types, unit, build, e2e) | The checks above, with the Playwright suite in Chromium |
| Rust (fmt, clippy, test) | The Rust side and the relay |
| Tauri build, on macOS, Windows and Linux | The desktop app compiles on each platform |
| Desktop app e2e, on Linux and Windows | The built app works when driven like a user: open, paint, save, host a room |
| macOS (WebKit e2e, app self-test) | The whole Playwright suite in WebKit on a Mac, then the built `.app` tests itself |
| Real data (one LUNA16 case) | A real open CT and mask open, edit and save correctly |

Merge only when all nine are green. If a job fails, read its log and fix the cause; a job gets one re-run at most, and "flaky" is not an explanation. One pull request per change keeps a failure easy to trace.

## Releases and auto-update

How it works: the app asks GitHub for `releases/latest/download/latest.json`. That file names the newest **published** release and carries a signature for each platform. The app updates when the version is higher than its own and the signature matches the public key built into it. A draft release is invisible to the updater.

To ship a release:

1. Make sure `main` is green in CI.
2. Set the same version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, then run `cargo check` in `src-tauri/` so `Cargo.lock` follows. The workflow stops if they disagree.
3. In `CHANGELOG.md`, move the "Unreleased" entries under a new heading for the version with today's date, and update the compare links at the bottom.
4. Merge that to `main` through a pull request and wait for green CI.
5. On GitHub, open *Actions → Release → Run workflow*, choose `main`, tick **Publish the release when every build and check passes**, and run it.
6. The workflow builds macOS (universal, signed and notarised), Windows and Linux, checks the Mac signature and `latest.json`, adds the version-free file names the README buttons use, and publishes. If any check fails it stays a draft.
7. Afterwards, confirm the release page lists the installers and that `latest.json` shows the new version.

Rules for releases:

- **Only the owner decides when to release.** A collaborator or agent prepares the version bump and asks.
- **A published release is never rebuilt.** If something is wrong, fix it and bump the version.
- **Never lower a version** and never reuse one.
- **Do not rename release files.** The README download buttons and the updater depend on the names.
- Full detail, including how to test an update by hand, is in [`docs/RELEASING.md`](RELEASING.md).

## Secrets and keys

Signing and updating depend on repository secrets that only the owner manages: the Apple certificate and notarisation credentials, and the updater's private key (`TAURI_SIGNING_PRIVATE_KEY`).

- Never print, copy, commit or ask for these values. They are not needed for development; local and CI builds without them are simply unsigned.
- **Never change `plugins.updater.pubkey` or the updater endpoint in `src-tauri/tauri.conf.json`.** Installed copies trust that public key. If it changes, or the private key is lost, every installed copy stops updating for good.
- Do not change the app identifier, the bundle name or the file associations in `tauri.conf.json` without the owner: they tie installed copies, Open With and updates together.
- Do not edit `.github/workflows/release.yml` or `secrets-check.yml` as part of a feature. Propose changes to them in their own pull request.

## For coding agents

- Read `CLAUDE.md` first; its rules override your defaults. Then this page.
- Work on a branch, open a pull request, and let CI decide. Do not push to `main`, force-push, rewrite history, delete branches or tags, or publish a release unless the owner asked for exactly that.
- Do not skip, disable or weaken a test, and do not mark something done that you did not run. If you could not check a platform, say "not verified".
- Keep a change to what was asked. If you find another problem, report it instead of fixing it in the same pull request.
- Do not add dependencies, telemetry, network calls or anything that looks like an AI feature.
- Record decisions in `docs/process/DECISIONS.md`, and leave the changelog and README matching what you built.
- The agents in `.claude/agents/` (designer, radiologist, ux-reviewer, tester-user, watchdog and others) and the `council` and `grill-me` skills are there to review a spec or a build; `.claude/workflows/build-review-loop.md` says how they fit together.

## When something goes wrong

| Symptom | Likely cause |
| --- | --- |
| Works in Chromium, fails in the macOS job | A WebKit difference, or a test that expects `Ctrl`/`Alt` labels or Chromium's wheel behaviour |
| A desktop test clicks the wrong thing on Windows | The window is smaller there; position by the view's size, and keep clear of the view's name button |
| Room tests fail together | The relay process died; build it in `relay/` and start it by hand on the port in `playwright.config.ts` |
| Undo, autosave or a room misses an edit | The edit did not go through the session's edit path |
| The Release workflow stops at once | The three version numbers disagree, or the tag does not match the version |
| An installed copy is not offered an update | The release is still a draft, is marked pre-release, or `latest.json` is missing a platform |

If none of that helps, open an issue with what you did, what you expected and what happened, using synthetic data only.
