# Testing in WebKit

The desktop app runs in the system webview: WKWebView on macOS, WebKitGTK on Linux, WebView2 (Chromium) on Windows. The Playwright suite in `e2e/` runs in Chromium, so a bug that only WebKit has can pass every test and still reach macOS users. Issue #21 was such a bug: an enlarged view collapsed to a 2 px strip in WebKit and nothing could be painted.

`e2e-webkit/` checks the app in WebKitGTK. It is the same engine family as WKWebView and shares its layout and JavaScript engines, so it catches most WebKit-only bugs on a Linux machine. It is not macOS: see "What this does not cover".

## What you need

Linux with:

```
sudo apt-get install -y webkit2gtk-driver xvfb
```

`webkit2gtk-driver` provides `WebKitWebDriver`. WebKitGTK's `MiniBrowser` comes with the WebKitGTK packages (`libwebkit2gtk-4.1-0` installs it under `/usr/lib/<arch>/webkit2gtk-4.1/`); set `W_MINIBROWSER` if yours is elsewhere. Node 22 or newer. No npm packages are needed: `e2e-webkit/wd.mjs` speaks WebDriver over `fetch`.

## Run it

Against the web build, in WebKitGTK's MiniBrowser. Fast, no Rust build:

```
pnpm dev                      # in one terminal (or any port: W_PORT=1481 pnpm dev)
xvfb-run -a pnpm webkit:check # in another; W_URL=http://localhost:1481/ for another port
```

Against the built desktop app, which is what Linux users get:

```
pnpm tauri build --debug --no-bundle
W_APP=target/debug/w-annotator xvfb-run -a pnpm webkit:check
```

The script prints one line per check and exits with 1 if any failed. It takes about a minute.

| Variable | Meaning | Default |
| --- | --- | --- |
| `W_URL` | Page to open in MiniBrowser | `http://localhost:1420/` |
| `W_APP` | Path of the built app; when set, the app is driven instead of MiniBrowser | unset |
| `W_SHOTS` | Folder for a screenshot of each state visited, and of each failure | unset |
| `W_RELAY` | Room server for the web build, e.g. `ws://localhost:8787` (`cargo run -p w-relay`). When set, or when `W_APP` is set, a room is started and a second client joins it | unset |
| `W_WD_PORT` | Port for `WebKitWebDriver` | `4581` |
| `W_MINIBROWSER` | Path of MiniBrowser | looked up in the usual places |

`GDK_SCALE=2` with a larger virtual screen (`xvfb-run -a -s "-screen 0 2800x1800x24"`) runs it at a device pixel ratio of 2, like a Retina display.

## What it checks

- First launch: the welcome tour opens the sample and every step points at something.
- Every edit tool (brush, eraser, threshold brush, scissors, fill) changes the mask; undo and redo; every navigation tool can be picked and dragged.
- A freehand scissors loop erases and undoes; Alt-click selects the segment under the cursor; the Fill tool removes a clicked island; fill between slices previews and applies on Enter; Smooth pixels switches.
- The window and zoom read-outs of the status bar open their menus above the bar; a preset changes the window and Zoom in enlarges the view.
- Each of the four views fills the view area when enlarged; a double-click enlarges; painting works enlarged and after going back.
- A click on the 3D view with an edit tool says where to paint.
- A key whose key-up never arrived does not stop the brush.
- The smallest brush paints a few voxels with one click.
- Tooltips of the buttons over a view open below them, are fully shown and are plain text.
- In every dialog the close button is clear of tabs, headings and other controls.
- The segment menu, an amount form and the colour palette are as wide as the row, and the menu stays above the status bar.
- The theme switches both ways. Saving clears the unsaved state (web build only; the native save dialog cannot be driven).
- Nothing logged an error.

## Adding a check

Add a `check('what should be true', async () => { ... })` block to `e2e-webkit/check.mjs`. Helpers in `wd.mjs`: `b.exec(fn, ...args)` runs a function in the page, `clickOn`, `hover`, `drag`, `click`, `rect`, `state`, `maskVoxels`. Behaviour that is the same in every engine belongs in `e2e/` instead; put here what needs a WebKit engine to fail.

When a bug is found in the macOS app, first try to reproduce it here. If it reproduces, write the check before the fix and see it fail.

## What this does not cover

- **macOS itself.** WKWebView draws with Metal and takes input from AppKit: Retina compositing, trackpad gestures, the native menu's key equivalents, focus rules (WebKit on macOS does not focus a button on click) and Cmd shortcuts are not exercised. Say "not verified on macOS" for those.
- **An older WebKit.** The check runs the WebKitGTK installed on the machine (2.52 when this was written). The macOS app runs the WebKit of the user's macOS, which can be years older (the app supports macOS 10.15).
- **Playwright's WebKit.** `W_E2E_BROWSER=webkit pnpm e2e` on a macOS runner (see the desktop e2e work) runs the whole Playwright suite in a WebKit build. Use both: that one for breadth, this one for a quick local check and for the built Linux app.
