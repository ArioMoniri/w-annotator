# src-tauri

The Rust side of W Annotator (Tauri v2). It does four things: reads and writes files the user chose, keeps recovery copies of unsaved mask edits, hosts a room on the local network, and reports files opened with the app from the system.

```
src/lib.rs       commands and app setup
src/files.rs     which paths may be read or written
src/batch.rs     gathers files that arrive close together into one open
src/dump.rs      a test hook, off unless asked for
src/recovery.rs  recovery copies in the app's local data folder
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

Paths picked with the JavaScript dialog plugin (`open()` / `save()` from `@tauri-apps/plugin-dialog`) are **not** on this list, because the Rust side never sees them. Use the two `pick_*` commands below for anything you will pass to `read_file` or `write_file`.

Files and folders dropped on the window, opened with the app or named on the command line are on the list too: the Rust side records them when the system hands them over, and tells the web side with the `files-given` event (below). A dropped folder is readable like a picked one. The web side never makes a path readable by naming it.

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

### Files handed over by the system: `files-given`, `files_ready`

```ts
type GivenFiles = { paths: string[]; error: string | null };

const unlisten = await listen<GivenFiles>('files-given', (event) => {
  // event.payload.paths: absolute paths, readable with read_file, to open together
  // event.payload.error: why something was left out, in words for the user
});
await invoke<void>('files_ready'); // after listening; files from the launch are sent now
```

One event is one batch of files that belong together. They come from:

| Source | How it arrives | Batching |
| --- | --- | --- |
| Dropped on the window | Tauri's native drag-and-drop event (`dragDropEnabled: true`), with real paths | sent at once |
| "Open with", double click, command line at launch | arguments (Windows, Linux); `RunEvent::Opened` (macOS) | gathered |
| The same while the app is running | a second launch hands its arguments to the running app and quits (`tauri-plugin-single-instance`); `RunEvent::Opened` (macOS) | gathered |

Gathered means: everything that arrives within 300 ms of the previous arrival is one batch (`src/batch.rs`), and nothing is sent before `files_ready`. An image and its mask selected together and opened with the app therefore reach the window as one pair, however many pieces the system delivered them in.

Folders are replaced by the files inside them (hidden files skipped). One hand-over takes at most 20 000 files and 4 GB; past that the rest is left out and `error` says so. Arguments may be relative (read from the folder of the second launch) or `file://` addresses.

### `reveal_file`

```ts
await invoke<void>('reveal_file', { path });
```

Shows a file in Finder, Explorer or the file manager. Only for a path that is readable under the rule above; the opener plugin's own reveal command is not granted to the window, since it takes any path.

### File types ("Open with")

`bundle.fileAssociations` in `tauri.conf.json` is the common list; `tauri.macos.conf.json`, `tauri.windows.conf.json` and `tauri.linux.conf.json` each replace it with what their system needs. `src/associations.rs` checks that all four cover the same formats.

| | What is registered | Limits |
| --- | --- | --- |
| macOS | `.nii`, `.mha`, `.mhd`, `.nrrd`, `.nhdr` (which covers `.seg.nrrd`) and `.dcm`, all with rank Alternate: the app is in "Open With" and never becomes the default by itself. | Finder sees `.nii.gz` as a gzip archive. The app is listed for gzip archives (Alternate, viewer), so it is offered for every `.gz`, not only NIfTI. It also declares a type for the double extension `nii.gz`; macOS may ignore that. |
| Windows | The same extensions, each with its own file class (`WAnnotator.NIfTI` …). `.gz` is not claimed: the NSIS installer only adds the app to the "Open with" list of `.gz` (`windows/hooks.nsh`). | Tauri's installers register the listed extensions the normal way, which makes the app the default where no other program has been chosen; Windows keeps the user's own choice. The `.gz` entry is not added by the `.msi`. |
| Linux | MIME types in the `.desktop` entry (`linux/w-annotator.desktop`, with `%F` so the chosen files are passed). `application/x-nifti`, `application/x-nifti-gz` (`*.nii.gz`, which wins over `*.gz`), `application/x-metaimage` and `application/x-nrrd` are defined in `linux/w-annotator-mime.xml`, installed by the `.deb` and `.rpm`. | The AppImage installs nothing into the system, so it has no "Open with" entry unless a launcher tool adds one. |

Folders cannot be associated on any system; drop them or use Open DICOM folder.

### Test hook: `W_FILES_DUMP`

Launched with `W_FILES_DUMP=<absolute file>`, the app writes what is open to that file twice a second, as JSON: `{ "image": "ct.mha", "files": [{ "kind": "image", "label": "ct", "active": false }, …] }`. It lets a test look at a running app from outside, for example after a second launch. Without the variable the `dump_files` command writes nothing. Code: `src/dump.rs`.

### Recovery copies

Autosave keeps one recovery copy of the unsaved mask per image. The copies live in `recovery/` inside the app's local data directory (`app_local_data_dir()`):

| System | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/<bundle identifier>/recovery` |
| Windows | `%LOCALAPPDATA%\<bundle identifier>\recovery` |
| Linux | `~/.local/share/<bundle identifier>/recovery` |

These commands never take a path to write to. They take a **key**: 16 to 64 lowercase hex characters (`[a-f0-9]{16,64}`), the fingerprint of the image. Any other key is rejected before the disk is touched. A copy is the file `<key>.wrec`; nothing in its name or in the folder names the patient or the image. Copies are never sent anywhere.

```ts
// Write or replace a copy. The bytes are the raw request body, as with write_file.
await invoke<void>('recovery_write', bytes, {
  headers: {
    'x-recovery-key': key,
    'x-image-path': encodeURIComponent(imagePath), // optional
  },
});

// Read a copy. An empty buffer means there is none.
const buffer = await invoke<ArrayBuffer>('recovery_read', { key });

// List the copies, newest first.
const copies = await invoke<{ key: string; savedAt: number; bytes: number; imageName: string | null }[]>('recovery_list');

// Remove a copy. Removing one that is not there is not an error.
await invoke<void>('recovery_delete', { key });

// The bytes of the image a copy belongs to.
const image = await invoke<ArrayBuffer>('recovery_image', { key });
```

- `recovery_write` writes to a temporary file and moves it into place, so a crash cannot leave a half-written copy.
- `savedAt` is the file's modification time in milliseconds since 1970.
- `x-image-path` is kept (in `<key>.path`, beside the copy) only when the user chose that file in this run of the app, under the file access rule above; otherwise it is ignored. A write without the header keeps an earlier note. The path is used for one thing: `recovery_list` reports the file name as `imageName` while the file still exists, and `recovery_image` returns its bytes so the app can offer "Open {file name}". The path itself is never returned to the web side.
- `recovery_image` rejects when no path was recorded or the file has moved. It gives read access to that one file only.
- The web side decides when copies are written and removed (14 days, 5 images); see `src/mask/recovery.ts`.

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
  "userAgent": "…",
  "webview": "156.0.3900.12"
}
```

`webview` is the exact WebView2 version on Windows and `null` elsewhere. CI uses it to fetch the Edge driver that matches the WebView2 the app really loads, which is not always the newest one installed.

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
