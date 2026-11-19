# Definition of done

A change is done when every line below is true and you have the evidence. If a line does not apply, write "n/a" and why. If you could not check it, it is not done; say "not verified".

## Tests

- [ ] New behaviour was written test first (`TDD.md`); each new test was seen to fail before the code existed.
- [ ] `pnpm test` passes.
- [ ] `cargo test` passes (if Rust changed).
- [ ] `pnpm e2e` passes.
- [ ] No skipped tests: no `.skip`, `.only`, `.todo`, `fixme`, `#[ignore]`, commented-out tests or weakened assertions anywhere in the diff.
- [ ] Bug fixes include a test that failed before the fix.

## Code quality

- [ ] `pnpm lint` passes with no new warnings and no new disable comments.
- [ ] `pnpm typecheck` passes with no new `any`, `@ts-ignore` or `@ts-expect-error`.
- [ ] No leftover debug output, dead code or TODOs without an owner.
- [ ] No new dependency unless it was agreed and recorded in `DECISIONS.md`.

## UI (if anything visible changed)

- [ ] Screenshot check: the affected states were captured from the running web build and looked at. At minimum: empty state, volume with mask, the changed feature in use, and its error state.
- [ ] Matches `docs/design/DESIGN.md` and uses tokens, not raw values.
- [ ] Nothing was added that the goal did not ask for. No new modal, setting or toast without a reason.
- [ ] Motion is under 250ms, respects reduced motion, and the medical image is never animated.

## Accessibility

- [ ] Everything new works by keyboard, with a visible focus ring and a sensible tab order.
- [ ] Controls have accessible names; icon buttons have tooltips that show the shortcut.
- [ ] Text contrast is at least 4.5:1; controls and focus indicators at least 3:1.
- [ ] Nothing is conveyed by colour alone.

## Copy

- [ ] Short, plain, sentence case. No jargon, no exclamation marks, no emoji.
- [ ] Errors say what happened and what to do next.

## Correctness of the image

- [ ] Orientation, laterality, spacing and voxel values are unchanged by this work, or the change is covered by geometry tests.
- [ ] Saving a mask keeps its format, geometry and label values.

## Product rules

- [ ] No AI features: no model inference, auto-segmentation, assistants, or copy that suggests them.
- [ ] Nothing leaves the machine except display name and mask edits in a room, and update checks to GitHub Releases. No telemetry.

## Cross-platform

- [ ] No platform-specific paths, separators, shortcuts or APIs without handling macOS, Windows and Linux. Shortcuts use Cmd on macOS and Ctrl elsewhere.
- [ ] File handling works with spaces and non-ASCII characters in paths.
- [ ] If packaging, signing or updating changed: built and checked on each platform, or marked "not verified" per platform.

## Docs

- [ ] `GOAL.md` status updated for the acceptance criteria this change meets, with evidence.
- [ ] `DECISIONS.md` has any decision made along the way.
- [ ] `DESIGN.md`, `CLAUDE.md` and user-facing docs updated if behaviour, commands or layout changed.
- [ ] `LOOP.md` log has a row for the iteration.

## Gate

- [ ] The `watchdog` agent returned PASS on the final diff.
