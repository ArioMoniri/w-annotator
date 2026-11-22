import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { cuttable, skipTour, startRoom, submitJoin, watchRoomTraffic } from './helpers';

/**
 * Rooms on a scan of ordinary size: 512 x 512 x 300, 16-bit, with a mask of a few large
 * segments. The other room tests use a 48-voxel cube, which says nothing about minutes,
 * megabytes or a frozen screen. The scan is made here from a formula; no patient data.
 *
 * Slow and memory-hungry, so it only runs when asked for: `W_SCALE=1 pnpm e2e e2e/room-scale.spec.ts`.
 * It checks that things work and stay within generous limits, and writes what it measured
 * to `test-results/room-scale.json`. The numbers of record are in docs/reviews/rooms-scale.md.
 */

const DIMS: [number, number, number] = [512, 512, 300];
const RELAY_PORT = Number(process.env.W_RELAY_PORT ?? 8787);
const MB = 1024 * 1024;

test.describe.configure({ mode: 'serial' });
test.setTimeout(900_000);

const results: Record<string, unknown> = {
  machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, memoryGiB: Math.round(totalmem() / 1024 ** 3), platform: process.platform },
  volume: { dims: DIMS, imageMB: (DIMS[0] * DIMS[1] * DIMS[2] * 2) / MB, maskMB: (DIMS[0] * DIMS[1] * DIMS[2]) / MB },
};

test.afterAll(() => {
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/room-scale.json', JSON.stringify(results, null, 2));
  console.log(`\nroom-scale results\n${JSON.stringify(results, null, 2)}`);
});

const opened: import('@playwright/test').BrowserContext[] = [];

async function person(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  opened.push(context);
  const page = await context.newPage();
  await skipTour(page);
  return page;
}

// A scan this size takes about a gigabyte per page: close each test's pages before the next.
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((context) => context.close()));
});

/** Opens the synthetic scan and its mask through the app's normal open path. */
async function openScan(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => '__w' in window);
  await page.evaluate(async (dims) => {
    const [nx, ny, nz] = dims;
    const img = new Int16Array(nx * ny * nz);
    const msk = new Uint8Array(nx * ny * nz);
    // A body of soft tissue in air, two lungs, a spine, and scanner-like noise so that it
    // compresses about as badly as a real CT does.
    let seed = 0x9e3779b9;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        const dy = (y - 256) / 150;
        for (let x = 0; x < nx; x++) {
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          const noise = (seed & 63) - 32;
          const dx = (x - 256) / 200;
          const at = (z * ny + y) * nx + x;
          let v = -1000 + (noise >> 3);
          if (dx * dx + dy * dy < 1) {
            v = 40 + noise;
            const lung = Math.min(((x - 170) / 60) ** 2, ((x - 342) / 60) ** 2) + ((y - 230) / 80) ** 2 + ((z - 150) / 110) ** 2;
            if (lung < 1) {
              v = -850 + noise;
              msk[at] = 2;
            }
            if ((x - 256) ** 2 + (y - 380) ** 2 < 25 * 25) {
              v = 700 + noise * 4;
              msk[at] = 3;
            }
            if (((x - 256) / 120) ** 2 + ((y - 300) / 55) ** 2 + ((z - 150) / 100) ** 2 < 1 && msk[at] === 0) msk[at] = 1;
          }
          img[at] = v;
        }
      }
    }
    const nifti = (data: Int16Array | Uint8Array, dtype: number, bitpix: number) => {
      const buf = new ArrayBuffer(352 + data.byteLength);
      const v = new DataView(buf);
      v.setInt32(0, 348, true);
      v.setInt16(40, 3, true);
      dims.forEach((d, i) => v.setInt16(42 + i * 2, d, true));
      v.setInt16(70, dtype, true);
      v.setInt16(72, bitpix, true);
      v.setFloat32(76, 1, true);
      [0.7, 0.7, 1].forEach((s, i) => v.setFloat32(80 + i * 4, s, true));
      v.setFloat32(108, 352, true);
      v.setFloat32(112, 1, true);
      v.setInt16(254, 1, true);
      [
        [0.7, 0, 0, 0],
        [0, 0.7, 0, 0],
        [0, 0, 1, 0],
      ].forEach((row, r) => row.forEach((x, c) => v.setFloat32(280 + r * 16 + c * 4, x, true)));
      new Uint8Array(buf, 344, 4).set([0x6e, 0x2b, 0x31, 0]);
      new Uint8Array(buf, 352).set(new Uint8Array(data.buffer));
      return new Uint8Array(buf);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).__w.session.openFiles([
      { name: 'scale_ct.nii', bytes: nifti(img, 4, 16) },
      { name: 'scale_seg.nii', bytes: nifti(msk, 2, 8) },
    ]);
  }, DIMS);
  await page.locator('[data-view="axial"] canvas').first().waitFor({ timeout: 120_000 });
  await expect(page.locator('.segrow')).toHaveCount(3, { timeout: 120_000 });
}

/** A fingerprint of the image or the mask as the page holds it, to compare two people's copies. */
async function checksum(page: Page, which: 'image' | 'mask'): Promise<string> {
  return page.evaluate((which) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (window as any).__w.session;
    const data = (which === 'image' ? s.getImage() : s.getMask()).data as Int16Array | Uint8Array;
    const words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
    let h = 0x811c9dc5;
    for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 16777619);
    return `${data.constructor.name}:${data.length}:${h >>> 0}`;
  }, which);
}

const voxels = (page: Page, label: number) =>
  page.evaluate((label) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (window as any).__w.session.getMask().data as Uint8Array;
    let n = 0;
    for (let i = 0; i < d.length; i++) if (d[i] === label) n++;
    return n;
  }, label);

/**
 * Watches how long the page goes without drawing a frame: the longest gap, and how many
 * gaps were over 100 ms. A page that stays responsive has short gaps.
 */
async function watchFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as never as { __frames: { last: number; max: number; long: number; on: boolean } };
    w.__frames = { last: performance.now(), max: 0, long: 0, on: true };
    const tick = () => {
      const f = w.__frames;
      const now = performance.now();
      const gap = now - f.last;
      f.last = now;
      if (f.on) {
        if (gap > f.max) f.max = gap;
        if (gap > 100) f.long++;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function frames(page: Page, reset = true): Promise<{ longestGapMs: number; gapsOver100ms: number }> {
  return page.evaluate((reset) => {
    const f = (window as never as { __frames: { last: number; max: number; long: number } }).__frames;
    const out = { longestGapMs: Math.round(f.max), gapsOver100ms: f.long };
    if (reset) {
      f.max = 0;
      f.long = 0;
      f.last = performance.now();
    }
    return out;
  }, reset);
}

/* ── memory, read from the operating system (Linux only) ── */

const rssMB = (pid: number): number | null => {
  try {
    const kb = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return kb ? Math.round(Number(kb[1]) / 1024) : null;
  } catch {
    return null;
  }
};

function relayPid(): number | null {
  try {
    const out = execSync(`pgrep -f "w-relay.* --port ${RELAY_PORT}"`, { encoding: 'utf8' });
    const pids = out.split('\n').map(Number).filter(Boolean);
    // `cargo run` matches too; the relay itself is the one whose program is w-relay.
    return pids.find((pid) => /w-relay$/.test(execSync(`readlink /proc/${pid}/exe`, { encoding: 'utf8' }).trim())) ?? null;
  } catch {
    return null;
  }
}

async function rendererPids(browser: Browser): Promise<number[]> {
  const cdp = await browser.newBrowserCDPSession();
  const info = (await cdp.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; id: number }[] };
  await cdp.detach();
  return info.processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
}

/** Samples the memory of some processes until stopped; reports the peak of each. */
function sampler(pids: () => (number | null)[]): { stop(): number[] } {
  const peak: number[] = [];
  const timer = setInterval(() => {
    pids().forEach((pid, i) => {
      const now = pid ? rssMB(pid) : null;
      if (now !== null) peak[i] = Math.max(peak[i] ?? 0, now);
    });
  }, 200);
  return {
    stop: () => {
      clearInterval(timer);
      return peak;
    },
  };
}

const progressOf = (page: Page) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page.evaluate(() => (window as any).__w.store.getState().progress as number | null);

/** Records every progress value the page shows, so a test can tell a moving bar from a stuck one. */
async function watchProgress(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as never as { __progress: Set<number>; __w: { store: { subscribe(fn: (s: { progress: number | null }) => void): void } } };
    w.__progress = new Set();
    w.__w.store.subscribe((s) => {
      if (typeof s.progress === 'number') w.__progress.add(Math.round(s.progress * 100));
    });
  });
}

/**
 * `from` clears a whole segment; resolves when its last voxel has changed for `to`.
 * Times are taken inside the pages, so the test's own polling is not in them.
 */
async function bigEdit(from: Page, to: Page, label: number): Promise<{ secondsToMakeTheEdit: number; secondsUntilTheOtherHasIt: number }> {
  const last = await from.evaluate((label) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (window as any).__w.session.getMask().data as Uint8Array;
    for (let i = d.length - 1; i >= 0; i--) if (d[i] === label) return i;
    return -1;
  }, label);
  expect(last).toBeGreaterThan(0);
  const arrived = to.evaluate(async (last) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (window as any).__w.session.getMask().data as Uint8Array;
    while (d[last] !== 0) await new Promise((r) => setTimeout(r, 4));
    return Date.now();
  }, last);
  const made = await from.evaluate((label) => {
    const t0 = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__w.session.clearSegment(label);
    return { t0, t1: Date.now() };
  }, label);
  const at = await arrived;
  return { secondsToMakeTheEdit: Number(((made.t1 - made.t0) / 1000).toFixed(2)), secondsUntilTheOtherHasIt: Number(((at - made.t0) / 1000).toFixed(2)) };
}

const inRoom = async (page: Page) => {
  await expect(page.locator('[data-view="axial"] canvas').first()).toBeVisible({ timeout: 600_000 });
  await expect(page.locator('.segrow')).toHaveCount(3, { timeout: 600_000 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await expect.poll(() => page.evaluate(() => (window as any).__w.store.getState().busy), { timeout: 600_000 }).toBeNull();
};

/* ───────────────────────── shared copy ───────────────────────── */

test('shared copy: a full-size scan reaches a guest, with progress, without freezing the host', async ({ browser }) => {
  const host = await person(browser);
  await openScan(host);
  const link = await startRoom(host, 'Mina');
  await watchFrames(host);
  const before = await rendererPids(browser);
  const relay = relayPid();
  const relayIdle = relay ? rssMB(relay) : null;

  const guest = await person(browser);
  const traffic = watchRoomTraffic(guest);
  await guest.goto('/');
  await guest.waitForFunction(() => '__w' in window);
  await watchFrames(guest);
  await watchProgress(guest);
  const guestPid = (await rendererPids(browser)).find((pid) => !before.includes(pid)) ?? null;
  const memory = sampler(() => [guestPid, relay]);

  await frames(host);
  const started = Date.now();
  await submitJoin(guest, 'Ario', link);
  // While the scan is on its way: the bar moves, and both screens keep drawing.
  await expect.poll(() => progressOf(guest), { timeout: 120_000, intervals: [50] }).toBeGreaterThan(0.05);
  const firstSlabs = (Date.now() - started) / 1000;
  await expect.poll(() => progressOf(guest), { timeout: 600_000, intervals: [50] }).toBeGreaterThan(0.9);
  const ninety = (Date.now() - started) / 1000;
  const hostWhileSending = await frames(host);
  const guestWhileReceiving = await frames(guest);
  await inRoom(guest);
  const seconds = (Date.now() - started) / 1000;
  const [guestPeak, relayPeak] = memory.stop();

  // The guest has the scan itself, voxel for voxel, and the mask.
  expect(await checksum(guest, 'image')).toBe(await checksum(host, 'image'));
  expect(await checksum(guest, 'mask')).toBe(await checksum(host, 'mask'));
  const steps = await guest.evaluate(() => (window as never as { __progress: Set<number> }).__progress.size);
  expect(steps).toBeGreaterThan(10);
  // Sending must not lock the host's screen, nor receiving the guest's.
  expect(hostWhileSending.longestGapMs).toBeLessThan(1500);
  expect(guestWhileReceiving.longestGapMs).toBeLessThan(1500);
  await expect(host.getByTestId('sync')).not.toContainText('Offline');

  const settled = guestPid ? rssMB(guestPid) : null;
  results.sharedCopyJoin = {
    seconds: Number(seconds.toFixed(1)),
    secondsToFivePercent: Number(firstSlabs.toFixed(1)),
    secondsToNinetyPercent: Number(ninety.toFixed(1)),
    megabytesOnTheWire: Number((traffic.bytes / MB).toFixed(1)),
    megabytesPerSecondWhileSending: Number(((traffic.bytes * 0.85) / MB / (ninety - firstSlabs)).toFixed(1)),
    imageFrames: traffic.kinds[4] ?? 0,
    maskFrames: traffic.kinds[3] ?? 0,
    progressSteps: steps,
    hostWhileSending,
    guestWhileReceiving,
    guestMemoryMB: { peakDuringJoin: guestPeak ?? null, afterJoin: settled, extraAtPeak: guestPeak && settled ? guestPeak - settled : null },
    relayMemoryMB: { before: relayIdle, peak: relayPeak ?? null, after: relay ? rssMB(relay) : null },
  };

  /* ── a large edit, each way ── */

  await frames(host);
  await frames(guest);
  const whole = await voxels(host, 1);
  expect(whole).toBeGreaterThan(1_500_000);
  const lungs = await voxels(host, 2);
  expect(lungs).toBeGreaterThan(1_500_000);
  const bytesBefore = traffic.bytes;
  const patchesBefore = traffic.kinds[1] ?? 0;
  // Every voxel of a large segment, on every slice it touches. The last voxel of the
  // segment is the last to change on the other side, so that is the one to wait for.
  const hostToGuest = await bigEdit(host, guest, 1);
  const hostDuringEdit = await frames(host);
  const guestDuringEdit = await frames(guest);
  const megabytes = Number(((traffic.bytes - bytesBefore) / MB).toFixed(1));
  const patchFrames = (traffic.kinds[1] ?? 0) - patchesBefore;
  expect(await checksum(guest, 'mask')).toBe(await checksum(host, 'mask'));
  await frames(host);
  await frames(guest);

  // The other way: the guest clears the next largest segment.
  const guestToHost = await bigEdit(guest, host, 2);
  const hostDuringSecond = await frames(host);
  const guestDuringSecond = await frames(guest);
  expect(await checksum(guest, 'mask')).toBe(await checksum(host, 'mask'));
  expect(await voxels(host, 1)).toBe(0);
  expect(await voxels(host, 2)).toBe(0);
  // Neither was thrown out for sending too fast, and neither had to start over.
  await expect(host.getByTestId('sync')).not.toContainText('Offline');
  await expect(guest.getByTestId('sync')).not.toContainText('Offline');
  for (const f of [hostDuringEdit, guestDuringEdit, hostDuringSecond, guestDuringSecond]) expect(f.longestGapMs).toBeLessThan(3000);

  results.largeEdit = {
    hostToGuest: { voxels: whole, ...hostToGuest, megabytesOnTheWire: megabytes, patchFrames, host: hostDuringEdit, guest: guestDuringEdit },
    guestToHost: { voxels: lungs, ...guestToHost, host: hostDuringSecond, guest: guestDuringSecond },
    relayMemoryMB: relay ? rssMB(relay) : null,
  };
});

test('shared copy: a connection cut in the middle of the transfer picks up where it stopped', async ({ browser }) => {
  const host = await person(browser);
  await openScan(host);
  const link = await startRoom(host, 'Mina');

  const guest = await person(browser);
  const line = await cuttable(guest);
  const traffic = watchRoomTraffic(guest);
  await guest.goto('/');
  await guest.waitForFunction(() => '__w' in window);
  const started = Date.now();
  await submitJoin(guest, 'Ario', link);
  await expect.poll(() => progressOf(guest), { timeout: 300_000, intervals: [100] }).toBeGreaterThan(0.25);
  const imageFramesBefore = traffic.kinds[4] ?? 0;
  await line.cut();
  await guest.waitForTimeout(2000);
  line.restore();
  // The app comes back by itself; the test does not press anything.
  await inRoom(guest);
  const seconds = (Date.now() - started) / 1000;

  expect(await checksum(guest, 'image')).toBe(await checksum(host, 'image'));
  expect(await checksum(guest, 'mask')).toBe(await checksum(host, 'mask'));
  // What had arrived before the cut was not sent again: far fewer image frames in all
  // than two whole transfers would take.
  const imageFramesAfter = (traffic.kinds[4] ?? 0) - imageFramesBefore;
  const total = traffic.kinds[4] ?? 0;
  expect(imageFramesBefore).toBeGreaterThan(5);
  expect(imageFramesAfter).toBeLessThan(total - imageFramesBefore / 2);
  results.cutTransfer = { seconds: Number(seconds.toFixed(1)), imageFramesBeforeCut: imageFramesBefore, imageFramesAfterCut: imageFramesAfter, megabytesOnTheWire: Number((traffic.bytes / MB).toFixed(1)) };
});

/* ───────────────────────── view through the host ───────────────────────── */

test('view through host: the first slice and each scroll arrive quickly, and no file is sent', async ({ browser }) => {
  const host = await person(browser);
  await openScan(host);
  const link = await startRoom(host, 'Mina', 'View through my computer');
  await watchFrames(host);

  const guest = await person(browser);
  const traffic = watchRoomTraffic(guest);
  await guest.goto('/');
  await guest.waitForFunction(() => '__w' in window);
  const started = Date.now();
  await submitJoin(guest, 'Ario', link);
  // A voxel of the spine, off the planes the other two views show, so only its own slice fills it in.
  const probe = (page: Page, k: number) =>
    page.evaluate((k) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = (window as any).__w.session.getMask();
      return m ? ((m.data as Uint8Array)[(k * 512 + 380) * 512 + 250] as number) : 0;
    }, k);
  await expect.poll(() => probe(guest, 150), { timeout: 120_000, intervals: [50] }).toBe(3);
  const firstSlice = (Date.now() - started) / 1000;

  // Scroll in steps larger than what is fetched ahead, and time each until its labels are there.
  const latencies: number[] = [];
  for (const k of [140, 128, 116, 104, 92, 164, 176, 188, 200, 212]) {
    const ms = await guest.evaluate(async (k) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = (window as any).__w;
      const vol = w.session.getMask();
      const at = (k * 512 + 380) * 512 + 250;
      const t0 = performance.now();
      w.engine.jumpTo([vol.origin[0] + 0.7 * 256, vol.origin[1] + 0.7 * 256, vol.origin[2] + k]);
      while ((vol.data as Uint8Array)[at] !== 3) {
        if (performance.now() - t0 > 30_000) return -1;
        await new Promise((r) => setTimeout(r, 4));
      }
      return performance.now() - t0;
    }, k);
    expect(ms).toBeGreaterThanOrEqual(0);
    latencies.push(Math.round(ms));
    await guest.waitForTimeout(700);
  }
  latencies.sort((a, b) => a - b);
  const median = latencies[Math.floor(latencies.length / 2)];
  expect(firstSlice).toBeLessThan(60);
  expect(median).toBeLessThan(3000);
  // No image or mask slab, ever; and what did arrive is a small part of the scan.
  expect(traffic.kinds[3] ?? 0).toBe(0);
  expect(traffic.kinds[4] ?? 0).toBe(0);
  expect(traffic.bytes).toBeLessThan(40 * MB);
  results.viewThroughHost = {
    secondsToFirstSlice: Number(firstSlice.toFixed(1)),
    scrollLatencyMs: { median, slowest: latencies[latencies.length - 1], fastest: latencies[0] },
    megabytesOnTheWire: Number((traffic.bytes / MB).toFixed(1)),
    sliceFrames: traffic.kinds[7] ?? 0,
    host: await frames(host),
  };
});

/* ───────────────────────── encryption speed ───────────────────────── */

test('sealing and opening frames is fast enough not to be what limits a room', async ({ browser }) => {
  const page = await person(browser);
  await page.goto('/');
  await page.waitForFunction(() => '__w' in window);
  const speed = await page.evaluate(async () => {
    // The app's own module, as the page runs it.
    const crypto2 = (await import(/* @vite-ignore */ `${location.origin}/src/collab/crypto.ts`)) as typeof import('../src/collab/crypto');
    const key = crypto2.makeRoomKey();
    const frame = new Uint8Array(1 << 20);
    for (let i = 0; i < frame.length; i += 65536) crypto.getRandomValues(frame.subarray(i, i + 65536));
    const aad = crypto2.frameAad('ROOM12345678', 1, 4);
    const rounds = 24;
    let sealed = crypto2.seal(key, aad, frame);
    let t = performance.now();
    for (let i = 0; i < rounds; i++) sealed = crypto2.seal(key, aad, frame);
    const seal = rounds / ((performance.now() - t) / 1000);
    t = performance.now();
    for (let i = 0; i < rounds; i++) crypto2.open(key, aad, sealed);
    const open = rounds / ((performance.now() - t) / 1000);
    return { sealMiBPerSecond: Math.round(seal), openMiBPerSecond: Math.round(open), secureContext: window.isSecureContext, webCrypto: !!crypto.subtle };
  });
  // The connection sends at most 10 MiB a second; sealing must be well above that.
  expect(speed.sealMiBPerSecond).toBeGreaterThan(15);
  expect(speed.openMiBPerSecond).toBeGreaterThan(15);
  results.encryption = speed;
});
