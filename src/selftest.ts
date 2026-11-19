/**
 * Test hook: a short scripted check of the real desktop app, run inside its own
 * window. It only runs when the app was launched with W_SELFTEST=<result file>
 * (see src-tauri/README.md); otherwise this module is never loaded.
 *
 * It expects an image and a mask on the command line, paints a stroke, hosts a
 * room and lets a second connection join it, saves the mask, writes the result
 * as JSON and quits the app.
 */
import { roomUrl, type ServerMessage } from './collab/protocol';
import { finishSelfTest } from './platform';
import * as session from './session';
import { get } from './state/store';

export interface SelfTestStep {
  name: string;
  ok: boolean;
  detail: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean, timeout = 15_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

function voxels(): number {
  const data = session.getMask()?.data;
  let n = 0;
  if (data) for (let i = 0; i < data.length; i++) if (data[i] !== 0) n++;
  return n;
}

/** Drags the mouse across the axial view the way a person would, so the real tool does the painting. */
async function stroke(): Promise<void> {
  const target = document.querySelector<HTMLElement>('[data-view="axial"] canvas');
  if (!target) throw new Error('The axial view is not on screen');
  const box = target.getBoundingClientRect();
  // Near the lower edge of the image, clear of both segments of the test mask.
  const at = (t: number) => ({ clientX: box.x + box.width * (0.45 + 0.1 * t), clientY: box.y + box.height * 0.82 });
  const send = (type: string, t: number, buttons: number) => {
    const init = { ...at(t), bubbles: true, cancelable: true, view: window, button: 0, buttons };
    target.dispatchEvent(new PointerEvent(`pointer${type}`, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    target.dispatchEvent(new MouseEvent(`mouse${type}`, init));
  };
  send('move', 0, 0);
  send('down', 0, 1);
  for (let i = 1; i <= 8; i++) {
    await sleep(30);
    send('move', i / 8, 1);
  }
  await sleep(30);
  send('up', 1, 0);
}

/** Joins the room as a second person over a plain WebSocket and leaves again. */
async function botVisit(link: string): Promise<string> {
  const ws = new WebSocket(roomUrl(link.replace(/\/r\/[^/]+$/, ''), link.split('/r/')[1], 'Bot'));
  try {
    const welcome = await new Promise<Extract<ServerMessage, { t: 'welcome' }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No answer from ${link}`)), 10_000);
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Could not connect to ${link}`));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        if (msg.t !== 'welcome') return;
        clearTimeout(timer);
        resolve(msg);
      };
    });
    if (welcome.peers.length !== 1) throw new Error(`Expected the host in the room, found ${welcome.peers.length} people`);
    await until('the guest to show up in the app', () => get().peers.some((p) => p.name === 'Bot'));
  } finally {
    ws.close();
  }
  await until('the guest to leave', () => get().peers.length === 0);
  return `guest joined through ${link} and left`;
}

export async function run(): Promise<void> {
  const steps: SelfTestStep[] = [];
  const step = async (name: string, body: () => Promise<string>) => {
    try {
      steps.push({ name, ok: true, detail: await body() });
    } catch (err) {
      steps.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };

  await step('files opened', async () => {
    await until('the image and the mask to open', () => !!get().image && get().busy === null && get().segments.length >= 2, 90_000);
    await sleep(800);
    return `${get().image!.name} with ${get().maskName}, ${get().segments.length} segments, ${voxels()} voxels`;
  });

  await step('stroke painted', async () => {
    const before = voxels();
    session.setTool('brush');
    await stroke();
    await until('the stroke to reach the mask', () => voxels() > before, 10_000);
    return `${before} to ${voxels()} voxels`;
  });

  await step('room hosted', async () => {
    const started = await session.startRoom('Self test');
    if (typeof started === 'string') throw new Error(started);
    if (!started.link.startsWith('ws://')) throw new Error(`Unexpected invite link ${started.link}`);
    if (!get().room?.hosting) throw new Error('The room is not hosted by this app');
    return `${await botVisit(started.link)}${started.localOnly ? ' (no network address, loopback only)' : ''}`;
  });

  let saved: { file: string; voxels: number } | null = null;
  await step('mask saved', async () => {
    await session.saveMask();
    await until('the save to finish', () => !get().dirty, 20_000);
    saved = { file: get().maskName ?? '', voxels: voxels() };
    return `${saved.file}, ${saved.voxels} voxels`;
  });

  await finishSelfTest(JSON.stringify({ ok: steps.every((s) => s.ok), steps, saved, userAgent: navigator.userAgent }, null, 2));
}
