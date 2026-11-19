# src-tauri

The Rust side of W Annotator (Tauri v2). It does three things: reads and writes files the user chose, hosts a room on the local network, and reports files opened with the app from the system.

```
src/lib.rs       commands and app setup
src/files.rs     which paths may be read or written
src/hosting.rs   the embedded room relay (the `w-relay` crate in ../relay)
src/testing.rs   hooks for automated tests, off unless asked for (see "Test hooks")
capabilities/    what the window may call in the plugins
```

Check it with `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace` from the repository root.

## Commands

All are called with `invoke` from `@tauri-apps/api/core`. Each rejects with a plain string that says what went wrong.

```ts
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
```

### File access rule

The web side can only touch paths the user chose in this run of the app:

| How the path was chosen | Read | Write |
| --- | --- | --- |
| A file picked with `pick_open_paths`, or opened with the app from the system | yes | yes |
| A path picked with `pick_save_path` | yes | yes |
| A file in the same folder as one of the above (a `.mhd` next to its `.raw`) | yes | no |
| A file inside a folder picked with `pick_open_paths({ directory: true })` | yes | no |
| Anything else | no | no |

Paths picked with the JavaScript dialog plugin (`open()` / `save()` from `@tauri-apps/plugin-dialog`) are **not** on this list, because the Rust side never sees them. Use the two `pick_*` commands below for anything you will pass to `read_file` or `write_file`. Files dropped on the window arrive as HTML5 `File` objects and need no command.

### `pick_open_paths`

```ts
type Filter = { name: string; extensions: string[] }; // extensions without the dot

const paths = await invoke<string[]>('pick_open_paths', {
  multiple: true,          // optional, default false
  directory: false,        // optional, default false
  title: 'Open volume',    // optional
  filters: [{ name: 'Volumes', extensions: ['nii', 'gz', 'mha', 'mhd', 'nrrd', 'dcm'] }], // optional
});
```

Returns absolute paths; `[]` if the user cancelled. With `directory: true` the user picks one folder and the result is every file inside it, recursively and sorted (hidden files skipped, at most 20 000).

### `pick_save_path`

```ts
const path = await invoke<string | null>('pick_save_path', {
  defaultName: 'mask.nii.gz', // optional
  title: 'Save mask',         // optional
  filters: [{ name: 'NIfTI', extensions: ['nii', 'gz'] }], // optional
});
```

Returns the absolute path, or `null` if the user cancelled. The system dialog has already asked about replacing an existing file. (With the test hook `W_E2E_SAVE_DIR` there is no dialog; see "Test hooks".)

### `write_file`

The bytes are the raw request body and the path travels in a header, so a 100 MB mask is never turned into JSON.

```ts
const bytes: Uint8Array = /* file contents */;
await invoke<void>('write_file', bytes, {
  headers: { 'x-file-path': encodeURIComponent(path) },
});
```

- Second argument: a `Uint8Array` or `ArrayBuffer` (not an object).
- `x-file-path`: the path, percent-encoded as UTF-8 with `encodeURIComponent`.
- The path must be writable under the rule above, or the call rejects.
- The data is written to a temporary file beside the target and then moved over it, so a crash cannot leave a half-written file.

### `read_file`

```ts
const buffer = await invoke<ArrayBuffer>('read_file', { path });
const bytes = new Uint8Array(buffer);
```

Returns the raw bytes as an `ArrayBuffer`. The path must be readable under the rule above.

### `opened_files`

```ts
const paths = await invoke<string[]>('opened_files');

const unlisten = await listen<string[]>('opened-files', (event) => {
  // event.payload: paths opened while the app was already running (macOS)
});
```

Returns every file the system has asked the app to open so far: paths on the command line ("Open with" on Windows and Linux) and macOS file-open events. Call it once at startup. The list is not cleared by reading it. Each later macOS open also emits the `opened-files` event with just the new paths. These paths are readable and writable.

Limits: `.nii.gz` is not registered as a file type (the system only sees `.gz`); on Linux only `.dcm` is registered, because the other formats have no standard MIME type; and on Windows and Linux "Open with" while the app is already running starts a second window instead of reusing the first.

### `host_room`

```ts
const { port, addresses } = await invoke<{ port: number; addresses: string[] }>('host_room', {
  port: 8787, // optional, default 8787
});
// Others join with: ws://<addresses[i]>:<port>/r/<ROOM>?name=<name>
// The host itself uses ws://127.0.0.1:<port>/r/<ROOM>?name=<name>
```

The web side always connects the host over `127.0.0.1`, so a firewall or network setting cannot keep the host out of its own room; the invite link carries `addresses[0]`. When `addresses` is empty the link falls back to `127.0.0.1` and the dialog says it only works on this computer (`../src/collab/hosting.ts`).

Starts the relay on `0.0.0.0`. If the port is taken, a free one is used, so always read `port` from the result. `addresses` holds this machine's IPv4 addresses on the network (no loopback), private ranges first; it can be empty when offline. Calling it again while hosting returns the running relay and ignores `port`. The relay protocol is in `../relay/README.md`.

### `stop_hosting`

```ts
await invoke<void>('stop_hosting');
```

Stops the relay and disconnects everyone. Does nothing if not hosting. Hosting also stops when the app quits.

## Test hooks

Two environment variables, read when the app is launched, let automated tests reach what they otherwise could not. Both are compiled into every build and do nothing unless set. They only take an absolute path. The code is in `src/testing.rs` and `../src/selftest.ts`; the tests that use them are in `../e2e-desktop`.

| Variable | Effect |
| --- | --- |
| `W_E2E_SAVE_DIR=<folder>` | `pick_save_path` shows no dialog and returns `<folder>/<defaultName>` (only the file name of `defaultName` is used, so the path cannot leave the folder; `mask.nii.gz` if there is none). The folder must exist. |
| `W_SELFTEST=<file>` | After the files from the command line have opened, the app runs a short scripted check in its own window, writes the result to `<file>` as JSON and quits. |

The self-test expects an image and a mask with at least two segments on the command line. Its steps: the files opened; a mouse stroke with the brush added voxels; a room hosted by the app was joined, and left, by a second WebSocket connection made from the window to the invite link; the mask was saved (so set `W_E2E_SAVE_DIR` too). The result looks like this:

```json
{
  "ok": true,
  "steps": [{ "name": "files opened", "ok": true, "detail": "…" }],
  "saved": { "file": "phantom_seg.nii.gz", "voxels": 839 },
  "userAgent": "…"
}
```

Two commands serve the self-test: `selftest_enabled` returns whether `W_SELFTEST` was set, and `selftest_finish({ report })` writes the report and quits. Without the variable `selftest_finish` rejects and writes nothing, and the web side never loads the self-test code.

## Plugins

Used from JavaScript through their own packages; the capability file grants only these:

| Plugin | Granted | Use |
| --- | --- | --- |
| `@tauri-apps/plugin-updater` | `updater:default` | `check()`, `downloadAndInstall()` |
| `@tauri-apps/plugin-process` | `process:allow-restart` | `relaunch()` after an update |
| `@tauri-apps/plugin-opener` | `opener:allow-open-url`, scoped to `https://github.com/ArioMoniri/w-annotator/*` | `openUrl()` for the pre-filled issue form of "Report a problem"; no other URL and no file can be opened |
| `@tauri-apps/plugin-dialog` | `dialog:allow-open`, `dialog:allow-save` | dialogs for paths that do not go through `read_file` / `write_file` |

## Notes

- `plugins.updater.pubkey` in `tauri.conf.json` is the placeholder `UPDATER_PUBKEY_PLACEHOLDER` until the real key is added; see `../docs/RELEASING.md`.
- `app.security.csp` is `null`. The app loads only its own bundled files, and Cornerstone needs workers, WebAssembly and blob URLs; a policy should be added once it can be tested against the real app.
- `icons/source.svg` is the icon source. Regenerate the set with `pnpm tauri icon src-tauri/icons/source.svg`, then delete `icons/android` and `icons/ios`.
