/**
 * Test hook: a short scripted check of the real desktop app, run inside its own
 * window. It only runs when the app was launched with W_SELFTEST=<result file>
 * (see src-tauri/README.md); otherwise this module is never loaded.
 *
 * It expects an image and a mask on the command line, paints a stroke, hosts a
 * room and lets a second connection join it, saves the mask, writes the result
 * as JSON and quits the app.
 */
import { RoomClient } from './collab/client';
import { loadCodec } from './io/codecs';
import * as engine from './viewer/engine';
import { makeSeed } from './collab/identity';
import { FrameKind, parseInvite } from './collab/protocol';
import { finishSelfTest } from './platform';
import * as session from './session';
import { get } from './state/store';
import { endTour, useTour } from './tour/state';

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

/** Joins the room as a second person with the invite link, says its name, and leaves again. */
async function botVisit(link: string): Promise<string> {
  const invite = parseInvite(link);
  if (!invite) throw new Error(`Unexpected invite link ${link}`);
  // The app is the host and reaches its own relay over loopback, whatever address the link carries.
  const server = `ws://127.0.0.1:${new URL(invite.server.replace(/^ws/, 'http')).port}`;
  let people = 0;
  let failed = '';
  const bot: RoomClient = new RoomClient(server, invite.room, makeSeed(), { t: 'redeem', secret: invite.secret }, null, {
    onStatus: () => undefined,
    onWelcome: (welcome) => {
      if (!bot.keys) failed = 'The invite did not say who the host is';
      people = welcome.roster.length;
    },
    onText: () => undefined,
    onFrame: () => undefined,
    // The host has let the bot in and handed it the room key: now it can say its name.
    onKeys: () => void bot.sendFrame(FrameKind.Presence, { t: 'hi', name: 'Bot' }),
    onEnded: (code, reason) => {
      failed = `Could not join through ${link}: ${code} ${reason}`;
    },
    members: () => [],
  });
  bot.connect();
  try {
    await until('the guest to show up in the app', () => {
      if (failed) throw new Error(failed);
      return get().peers.some((p) => p.name === 'Bot');
    });
    if (people !== 2) throw new Error(`Expected the host and the guest in the room, found ${people} people`);
  } finally {
    bot.close();
  }
  await until('the guest to leave', () => get().peers.length === 0);
  return `guest joined through ${link} and left`;
}

/** The exact WebView2 version on Windows, so a test run can fetch the matching Edge driver. Null elsewhere. */
async function webviewVersion(): Promise<string | null> {
  type Brands = { fullVersionList?: { brand: string; version: string }[] };
  const data = (navigator as unknown as { userAgentData?: { getHighEntropyValues(hints: string[]): Promise<Brands> } }).userAgentData;
  try {
    const list = (await data?.getHighEntropyValues(['fullVersionList']))?.fullVersionList ?? [];
    return list.find((b) => b.brand.includes('Edge'))?.version ?? null;
  } catch {
    return null;
  }
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

  // A first launch offers the welcome tour; it would cover the views.
  if (useTour.getState().phase !== 'off') endTour();

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
    if (!/^http:\/\/[^/]+\/j\/[A-Z0-9]{12}#/.test(started.link)) throw new Error(`Unexpected invite link ${started.link}`);
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

  await step('3D view drawn', async () => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-view="volume3d"] canvas');
    if (!canvas || canvas.width < 16 || canvas.height < 16) throw new Error('The 3D view has no canvas');
    engine.refreshImage();
    await sleep(300);
    return `${canvas.width} x ${canvas.height}`;
  });

  await step('image decoders loaded', async () => {
    // The decoders for compressed DICOM are WebAssembly, fetched and compiled on first use.
    const loaded: string[] = [];
    for (const [name, syntax] of [['JPEG', '1.2.840.10008.1.2.4.50'], ['JPEG-LS', '1.2.840.10008.1.2.4.80'], ['JPEG 2000', '1.2.840.10008.1.2.4.90'], ['HTJ2K', '1.2.840.10008.1.2.4.201']]) {
      await loadCodec(syntax);
      loaded.push(name);
    }
    return loaded.join(', ');
  });

  await step('update check ran', async () => {
    // Whether there is an update or the network is away, the check itself must not be refused.
    const { check } = await import('@tauri-apps/plugin-updater');
    try {
      const update = await check();
      return update ? `version ${update.version} is available` : 'up to date';
    } catch (err) {
      return `asked, and the answer was: ${err instanceof Error ? err.message : String(err)}`;
    }
  });

  await step('nothing refused by the content security policy', async () => {
    await sleep(300);
    const blocked = (window as unknown as { __w: { blocked: string[] } }).__w.blocked;
    if (blocked.length > 0) throw new Error(blocked.join('; '));
    return 'no violations';
  });

  const report = { ok: steps.every((s) => s.ok), steps, saved, userAgent: navigator.userAgent, webview: await webviewVersion() };
  await finishSelfTest(JSON.stringify(report, null, 2));
}
