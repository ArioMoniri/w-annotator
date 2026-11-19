# Contributing

Thanks for taking the time to help. This page says how to set up, what a change needs before it can be merged, and what is in scope.

## Set up

You need Node.js with pnpm, a stable Rust toolchain, and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```
pnpm install
pnpm tauri dev    # the desktop app
pnpm dev          # the web build only, in a browser
```

The layout is described in `CLAUDE.md`: `src/` is the web app, `src-tauri/` the Rust side, `relay/` the room relay and `e2e/` the Playwright tests.

## Checks

All of these must pass before a pull request is merged. CI runs the same commands.

```
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

## Test first

Behaviour is written test first: a failing test, the least code that passes it, then tidy. A bug fix starts with a test that reproduces the bug. Tests are never skipped, narrowed with `.only`, commented out or loosened. The rules, and what belongs in unit, Rust and end-to-end tests, are in [`docs/process/TDD.md`](docs/process/TDD.md).

## Definition of done

A change is done when every line of [`docs/process/DOD.md`](docs/process/DOD.md) holds. If you could not check something, such as a platform you do not have, say "not verified" in the pull request.

## Scope

- No AI features. No model inference, auto-segmentation or assistants, and no copy that suggests them.
- Keep the UI simple. The image comes first. Do not add controls, dialogs or settings without a clear need; open an issue first for anything larger than a fix.
- Copy is brief and plain: sentence case, no jargon, no exclamation marks, no emoji. Errors say what happened and what to do.
- Do not change orientation, laterality, spacing or voxel values for convenience.
- No telemetry. A room sends display names and mask edits only.
- Everything works on macOS, Windows and Linux.
- No new dependency without agreeing it in an issue first.

## Patient data

Never put real patient data in an issue, a pull request, a test or a screenshot. Test fixtures are small synthetic volumes built in code or tiny files checked in.

## Branches and commits

- Branch from `main` with a short descriptive name, for example `fix/nrrd-gzip-header`.
- Keep a pull request to one change.
- Write the commit subject in the imperative, sentence case, with no trailing full stop: "Fix threshold brush reading mask values". Say why in the body if it is not obvious.
- Commit at green: each commit should pass the checks.
- Add a line to `CHANGELOG.md` under "Unreleased" for anything a user would notice.

## Reporting bugs

Use the "Report a problem" item in the app, which opens the bug form with the version and system filled in, or open one of the [issue forms](https://github.com/ArioMoniri/w-annotator/issues/new/choose) yourself. For a security problem, follow [`SECURITY.md`](SECURITY.md) instead of opening a public issue.

## Licence

The project is released under the [PolyForm Noncommercial License 1.0.0](LICENSE). By submitting a contribution you agree that it is licensed under the same terms, and that Ariorad Moniri, as the licensor, may also grant others permission to use it commercially. Only submit work you have the right to contribute.
