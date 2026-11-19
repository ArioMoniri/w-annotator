/**
 * Starts the built desktop app under WebDriver. `tauri-driver` proxies to the
 * system's driver: WebKitWebDriver on Linux, msedgedriver on Windows. macOS has
 * no driver for WKWebView, so this suite does not run there (see README.md).
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { remote } from 'webdriverio';
import { APP } from './app.mjs';

const exe = process.platform === 'win32' ? '.exe' : '';

const DRIVER = process.env.TAURI_DRIVER ?? join(homedir(), '.cargo', 'bin', `tauri-driver${exe}`);
// Each launch gets its own pair of ports, so a driver left over from an earlier launch is never reused.
let nextPort = Number(process.env.W_DRIVER_PORT ?? 4444);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((done) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), done(true)));
    socket.once('error', () => done(false));
  });
}

/** Polls `read` until `ok(value)` holds, and returns the value. */
export async function until(read, ok = Boolean, { timeout = 20_000, what = 'the condition' } = {}) {
  const end = Date.now() + timeout;
  let value;
  let error;
  for (;;) {
    try {
      value = await read();
      error = undefined;
      if (ok(value)) return value;
    } catch (err) {
      error = err;
    }
    if (Date.now() > end) {
      throw new Error(`Timed out after ${timeout} ms waiting for ${what}. Last value: ${JSON.stringify(value)}${error ? `, last error: ${error.message}` : ''}`);
    }
    await sleep(150);
  }
}

/**
 * Launches the app with the given command-line arguments and environment and
 * returns a WebdriverIO browser for its window, plus `quit()`.
 */
export async function launch({ args = [], env = {} } = {}) {
  if (!existsSync(APP)) throw new Error(`The app is not built: ${APP}. Run pnpm tauri build --debug --no-bundle first.`);
  const PORT = nextPort;
  const NATIVE_PORT = nextPort + 1;
  nextPort += 2;
  if (await portOpen(PORT)) throw new Error(`Port ${PORT} is in use; is another tauri-driver running?`);

  const driverArgs = ['--port', String(PORT), '--native-port', String(NATIVE_PORT)];
  if (process.env.W_NATIVE_DRIVER) driverArgs.push('--native-driver', process.env.W_NATIVE_DRIVER);
  // The app inherits the environment of tauri-driver.
  const driver = spawn(DRIVER, driverArgs, { env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
  let exited = false;
  driver.once('exit', () => (exited = true));
  driver.once('error', (err) => {
    exited = true;
    console.error(`Could not start ${DRIVER}: ${err.message}`);
  });

  const stop = async () => {
    if (!exited) {
      // On Windows a plain kill would leave msedgedriver and the app behind.
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(driver.pid), '/T', '/F'], { stdio: 'ignore' });
      else driver.kill();
    }
    await until(async () => exited || !(await portOpen(PORT)), Boolean, { timeout: 10_000, what: 'tauri-driver to stop' }).catch(() => {});
  };

  try {
    await until(() => portOpen(PORT), Boolean, { timeout: 15_000, what: 'tauri-driver to listen' });
    const browser = await remote({
      hostname: '127.0.0.1',
      port: PORT,
      logLevel: 'error',
      connectionRetryCount: 0,
      connectionRetryTimeout: 120_000,
      capabilities: { 'tauri:options': { application: APP, args } },
    });
    await until(() => browser.execute(() => '__w' in window), Boolean, { timeout: 60_000, what: 'the app to load' });
    return {
      browser,
      quit: async () => {
        await browser.deleteSession().catch(() => {});
        await stop();
      },
    };
  } catch (err) {
    if (process.platform === 'win32') {
      // Shows whether the app and its WebView2 processes came up at all.
      const list = spawnSync('tasklist', [], { encoding: 'utf8' }).stdout ?? '';
      const found = list.split('\n').filter((l) => /w-annotator|msedge|webview/i.test(l)).join('\n');
      const note = `Session failed: ${String(err.message).slice(0, 200)}\nProcesses at that moment:\n${found || '(none of the app, Edge or WebView2)'}\n`;
      console.error(note);
      if (process.env.W_DIAG_FILE) appendFileSync(process.env.W_DIAG_FILE, note);
    }
    await stop();
    throw err;
  }
}

/* ───────────── helpers that talk to the app window ───────────── */

/** Non-zero voxels in the mask, or voxels of one label. */
export function maskVoxels(browser, label = null) {
  return browser.execute((label) => {
    const d = window.__w.session.getMask().data;
    let n = 0;
    for (let i = 0; i < d.length; i++) if (label === null ? d[i] !== 0 : d[i] === label) n++;
    return n;
  }, label);
}

export const store = (browser, pick) => browser.execute(`return (${pick})(window.__w.store.getState())`);

/** Waits until the app is not loading or saving. */
export const idle = (browser) => until(() => store(browser, (s) => s.image !== null && s.busy === null), Boolean, { timeout: 60_000, what: 'the image to finish loading' });

async function centre(browser, view) {
  const box = await browser.execute((view) => {
    const r = document.querySelector(`[data-view="${view}"]`).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, view);
  return box;
}

/** Drags with the left button inside a view; offsets are from the view's centre, in CSS pixels. */
export async function drag(browser, view, from, to, steps = 8) {
  const c = await centre(browser, view);
  const at = (p) => ({ x: Math.round(c.x + p[0]), y: Math.round(c.y + p[1]), origin: 'viewport' });
  const action = browser.action('pointer', { parameters: { pointerType: 'mouse' } }).move(at(from)).down({ button: 0 }).pause(50);
  for (let i = 1; i <= steps; i++) {
    action.move({ ...at([from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]), duration: 20 });
  }
  await action.pause(50).up({ button: 0 }).perform();
  await sleep(500);
}

export async function click(browser, view, at) {
  const c = await centre(browser, view);
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: Math.round(c.x + at[0]), y: Math.round(c.y + at[1]), origin: 'viewport' })
    .down({ button: 0 })
    .pause(50)
    .up({ button: 0 })
    .perform();
  await sleep(500);
}

export { sleep };
