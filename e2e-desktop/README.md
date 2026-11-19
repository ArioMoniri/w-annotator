# e2e-desktop

Tests of the built desktop app, as opposed to `e2e/`, which tests the web build in a browser.

| File | What it does | Runs on |
| --- | --- | --- |
| `app.test.mjs` | Drives the app window through WebDriver: start, files from the command line, every tool, segments, save, and a room hosted by the app that a second client joins. | Linux, Windows |
| `selftest.mjs` | Launches the app with `W_SELFTEST` set, so the app checks itself and writes a JSON result, then checks the result and the saved file. | Linux, Windows, macOS |
| `driver.mjs` | Starts `tauri-driver` and the app; small helpers for the tests. | |
| `fixtures.mjs` | Writes a synthetic `.mha` image and `.nii.gz` mask by hand, and reads a saved NIfTI back. | |

macOS has no WebDriver for WKWebView, so `app.test.mjs` cannot run there. CI covers macOS with the Playwright suite in WebKit (`W_E2E_BROWSER=webkit pnpm e2e`) and with the self-test of the built `.app`.

## Run it

Build the app first. Any build works; CI uses a debug build without installers:

```
pnpm tauri build --debug --no-bundle
cargo install tauri-driver --locked
```

Linux also needs `webkit2gtk-driver`, and `xvfb` when there is no display:

```
sudo apt-get install -y webkit2gtk-driver xvfb
xvfb-run -a pnpm e2e:desktop
xvfb-run -a pnpm selftest:desktop
```

If the window stays blank under a virtual display, set `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

Windows needs the Edge driver that matches the installed WebView2 (see the [Tauri WebDriver guide](https://v2.tauri.app/develop/tests/webdriver/)). Put `msedgedriver.exe` on the `PATH` or name it in `W_NATIVE_DRIVER`:

```
pnpm e2e:desktop
pnpm selftest:desktop
```

macOS, with the app bundle built by `pnpm tauri build --debug --bundles app`:

```
pnpm selftest:desktop "target/debug/bundle/macos/W Annotator.app/Contents/MacOS/w-annotator"
```

## Settings

| Variable | Meaning | Default |
| --- | --- | --- |
| `W_APP` | Path to the app binary | `target/debug/w-annotator` |
| `TAURI_DRIVER` | Path to `tauri-driver` | `~/.cargo/bin/tauri-driver` |
| `W_NATIVE_DRIVER` | Path to the system driver, passed to `tauri-driver --native-driver` | found on the `PATH` |
| `W_DRIVER_PORT` | First port used for the drivers | `4444` |
| `W_SELFTEST_TIMEOUT` | How long the self-test may take, in ms | `180000` |

## Notes

- The tests in `app.test.mjs` share one app window and run in order; later tests build on the edits of earlier ones.
- The native save dialog cannot be driven, so the tests launch the app with `W_E2E_SAVE_DIR`. The hooks are described under "Test hooks" in `src-tauri/README.md`; they do nothing unless their variables are set at launch.
- WebKit's driver leaves text that cannot be selected out of `getText()`, so some checks read `textContent` instead.
- Fixtures are synthetic. No patient data.
