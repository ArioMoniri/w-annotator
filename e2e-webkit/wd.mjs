/**
 * A very small WebDriver client for WebKitGTK, with no dependencies.
 *
 * It starts `WebKitWebDriver` (package `webkit2gtk-driver`) and opens either WebKitGTK's
 * MiniBrowser on a URL, or the built desktop app. WebKitGTK is the engine of the Linux
 * desktop build and the same engine family as the WKWebView of the macOS build, so this is
 * the closest thing to the Mac app that can be driven on Linux. See docs/process/TESTING-WEBKIT.md.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MINIBROWSERS = [
  process.env.W_MINIBROWSER,
  '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser',
  '/usr/lib/aarch64-linux-gnu/webkit2gtk-4.1/MiniBrowser',
  '/usr/libexec/webkit2gtk-4.1/MiniBrowser',
  '/usr/lib/webkit2gtk-4.1/MiniBrowser',
].filter(Boolean);

function portOpen(port) {
  return new Promise((done) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), done(true)));
    socket.once('error', () => done(false));
  });
}

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
 * Opens a session. `app`: path of the built desktop binary; otherwise MiniBrowser is used
 * and `url` is loaded. Returns helpers bound to the session.
 */
export async function open({ url, app, port = Number(process.env.W_WD_PORT ?? 4581), size = [1280, 800] } = {}) {
  const env = { ...process.env, WEBKIT_DISABLE_DMABUF_RENDERER: '1', WEBKIT_DISABLE_COMPOSITING_MODE: process.env.WEBKIT_DISABLE_COMPOSITING_MODE ?? '' };
  if (await portOpen(port)) throw new Error(`Port ${port} is in use; set W_WD_PORT.`);
  const driver = spawn('WebKitWebDriver', [`--port=${port}`], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  const stop = () => driver.kill();
  try {
    await until(() => portOpen(port), Boolean, { what: 'WebKitWebDriver to listen (is webkit2gtk-driver installed?)' });
    const base = `http://127.0.0.1:${port}`;
    const call = async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json();
      if (json.value && json.value.error) throw new Error(`${json.value.error}: ${json.value.message}`);
      return json.value;
    };
    let binary = app;
    if (!binary) {
      binary = MINIBROWSERS.find((p) => existsSync(p));
      if (!binary) throw new Error('MiniBrowser not found. Set W_MINIBROWSER to its path.');
    }
    const options = app ? { binary, args: [] } : { binary, args: ['--automation'] };
    const created = await call('POST', '/session', {
      capabilities: { alwaysMatch: { 'webkitgtk:browserOptions': options } },
    });
    const sid = created.sessionId;
    const s = `/session/${sid}`;
    const api = {
      call: (method, path, body) => call(method, s + path, body),
      /** Runs a function body (or function) in the page and returns its value. */
      exec: (fn, ...args) => call('POST', `${s}/execute/sync`, { script: typeof fn === 'function' ? `return (${fn}).apply(null, arguments)` : fn, args }),
      execAsync: (fn, ...args) =>
        call('POST', `${s}/execute/async`, {
          script: `const done = arguments[arguments.length - 1]; Promise.resolve((${fn}).apply(null, Array.prototype.slice.call(arguments, 0, -1))).then(done, (e) => done({ __error: String(e && e.stack || e) }))`,
          args,
        }).then((v) => {
          if (v && v.__error) throw new Error(v.__error);
          return v;
        }),
      goto: (to) => call('POST', `${s}/url`, { url: to }),
      screenshot: async (file) => {
        const png = await call('GET', `${s}/screenshot`);
        const { writeFileSync } = await import('node:fs');
        writeFileSync(file, Buffer.from(png, 'base64'));
      },
      /** Pointer actions: a list of {type:'move'|'down'|'up'|'pause', x, y, duration, button}. */
      pointer: (actions) =>
        call('POST', `${s}/actions`, {
          actions: [
            {
              type: 'pointer',
              id: 'mouse',
              parameters: { pointerType: 'mouse' },
              actions: actions.map((a) =>
                a.type === 'move'
                  ? { type: 'pointerMove', x: Math.round(a.x), y: Math.round(a.y), origin: 'viewport', duration: a.duration ?? 0 }
                  : a.type === 'down'
                    ? { type: 'pointerDown', button: a.button ?? 0 }
                    : a.type === 'up'
                      ? { type: 'pointerUp', button: a.button ?? 0 }
                      : { type: 'pause', duration: a.duration ?? 50 },
              ),
            },
          ],
        }),
      keys: (text) =>
        call('POST', `${s}/actions`, {
          actions: [{ type: 'key', id: 'kbd', actions: [...text].flatMap((value) => [{ type: 'keyDown', value }, { type: 'keyUp', value }]) }],
        }),
      quit: async () => {
        await call('DELETE', s).catch(() => {});
        stop();
      },
    };
    await call('POST', `${s}/window/rect`, { width: size[0], height: size[1] }).catch(() => {});
    if (url) await api.goto(url);
    return api;
  } catch (err) {
    stop();
    throw err;
  }
}

/* ───────────── helpers that talk to the app ───────────── */

export const idle = (b) =>
  until(() => b.exec(() => '__w' in window && window.__w.store.getState().image !== null && window.__w.store.getState().busy === null), Boolean, {
    timeout: 60_000,
    what: 'the image to finish loading',
  });

export const state = (b, pick) => b.exec(`return (${pick})(window.__w.store.getState())`);

/** Non-zero voxels in the mask, or voxels of one label. */
export const maskVoxels = (b, label = null) =>
  b.exec((label) => {
    const d = window.__w.session.getMask().data;
    let n = 0;
    for (let i = 0; i < d.length; i++) if (label === null ? d[i] !== 0 : d[i] === label) n++;
    return n;
  }, label);

export const rect = (b, selector) =>
  b.exec((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);

async function centre(b, view) {
  const r = await rect(b, `[data-view="${view}"]`);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Drags with the left button inside a view; offsets are from the view's centre, in CSS pixels. */
export async function drag(b, view, from, to, steps = 8) {
  const c = await centre(b, view);
  const actions = [{ type: 'move', x: c.x + from[0], y: c.y + from[1] }, { type: 'down' }, { type: 'pause', duration: 50 }];
  for (let i = 1; i <= steps; i++) {
    actions.push({ type: 'move', x: c.x + from[0] + ((to[0] - from[0]) * i) / steps, y: c.y + from[1] + ((to[1] - from[1]) * i) / steps, duration: 20 });
  }
  actions.push({ type: 'pause', duration: 50 }, { type: 'up' });
  await b.pointer(actions);
  await sleep(500);
}

export async function click(b, view, at = [0, 0]) {
  const c = await centre(b, view);
  await b.pointer([{ type: 'move', x: c.x + at[0], y: c.y + at[1] }, { type: 'down' }, { type: 'pause', duration: 50 }, { type: 'up' }]);
  await sleep(500);
}

export async function clickOn(b, selector) {
  const r = await until(() => rect(b, selector), Boolean, { what: `${selector} to exist` });
  await b.pointer([{ type: 'move', x: r.x + r.width / 2, y: r.y + r.height / 2 }, { type: 'down' }, { type: 'pause', duration: 30 }, { type: 'up' }]);
  await sleep(250);
}

export async function hover(b, selector) {
  const r = await until(() => rect(b, selector), Boolean, { what: `${selector} to exist` });
  await b.pointer([{ type: 'move', x: r.x + r.width / 2, y: r.y + r.height / 2 }]);
}
