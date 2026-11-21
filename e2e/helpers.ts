import type { Page } from '@playwright/test';

/** Loads a small synthetic CT-like image and a two-label mask through the app's normal open path. */
/**
 * The welcome tour is for first launches, so tests start as someone who has
 * seen it. playwright.config.ts does the same for every context; this covers a
 * page whose storage was cleared. Saved settings are left alone.
 */
export async function skipTour(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const key = 'w-annotator:settings';
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ tourSeen: true }));
  });
}

export async function openPhantom(page: Page, withMask = true, peak = 300): Promise<void> {
  await skipTour(page);
  await page.goto('/');
  await page.waitForFunction(() => '__w' in window);
  await page.evaluate(async ({ withMask, peak }) => {
    const n = 48;
    const img = new Int16Array(n * n * n);
    const msk = new Uint8Array(n * n * n);
    for (let z = 0; z < n; z++)
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const r = Math.hypot(x - 24, y - 24, z - 24);
          img[z * n * n + y * n + x] = r < 20 ? peak - r * 8 : -1000;
          if (Math.hypot(x - 30, y - 22, z - 24) < 5) msk[z * n * n + y * n + x] = 1;
          if (Math.hypot(x - 17, y - 27, z - 23) < 4) msk[z * n * n + y * n + x] = 2;
        }
    const nifti = (data: Int16Array | Uint8Array, dtype: number, bitpix: number) => {
      const buf = new ArrayBuffer(352 + data.byteLength);
      const v = new DataView(buf);
      v.setInt32(0, 348, true);
      v.setInt16(40, 3, true);
      [n, n, n].forEach((d, i) => v.setInt16(42 + i * 2, d, true));
      v.setInt16(70, dtype, true);
      v.setInt16(72, bitpix, true);
      v.setFloat32(76, 1, true);
      [1, 1, 1].forEach((s, i) => v.setFloat32(80 + i * 4, s, true));
      v.setFloat32(108, 352, true);
      v.setFloat32(112, 1, true);
      v.setInt16(254, 1, true);
      [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
      ].forEach((row, r) => row.forEach((x, c) => v.setFloat32(280 + r * 16 + c * 4, x, true)));
      new Uint8Array(buf, 344, 4).set([0x6e, 0x2b, 0x31, 0]);
      new Uint8Array(buf, 352).set(new Uint8Array(data.buffer));
      return new Uint8Array(buf);
    };
    const files = [{ name: 'phantom_ct.nii', bytes: nifti(img, 4, 16) }];
    if (withMask) files.push({ name: 'phantom_seg.nii', bytes: nifti(msk, 2, 8) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).__w.session.openFiles(files);
  }, { withMask, peak });
  await page.locator('[data-view="axial"] canvas').first().waitFor();
  await page.waitForTimeout(800);
}

export async function maskVoxels(page: Page, label?: number): Promise<number> {
  return page.evaluate((label) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (window as any).__w.session.getMask().data as Uint8Array;
    let n = 0;
    for (let i = 0; i < d.length; i++) if (label === undefined ? d[i] !== 0 : d[i] === label) n++;
    return n;
  }, label);
}

export async function drag(page: Page, view: string, from: [number, number], to: [number, number]): Promise<void> {
  const box = (await page.locator(`[data-view="${view}"]`).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx + from[0], cy + from[1]);
  await page.mouse.down();
  await page.mouse.move(cx + to[0], cy + to[1], { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

/**
 * Gives the test a way to read what the app copies. Call it before the copy.
 * Chromium: grants clipboard access, and the returned function reads the real clipboard.
 * WebKit: Playwright has no clipboard permission to grant there and reading the clipboard
 * asks the user, so the app's write is recorded instead of reaching the system clipboard.
 */
export async function copiedText(page: Page): Promise<() => Promise<string>> {
  if (page.context().browser()?.browserType().name() !== 'webkit') {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    return () => page.evaluate(() => navigator.clipboard.readText());
  }
  const record = () => {
    // A blank page, before the app is loaded, has no clipboard.
    if (typeof Clipboard === 'undefined') return;
    Object.defineProperty(Clipboard.prototype, 'writeText', {
      configurable: true,
      value: async (text: string) => {
        (window as unknown as { __copied: string }).__copied = text;
      },
    });
  };
  await page.addInitScript(record);
  await page.evaluate(record);
  return () => page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? '');
}

/** Centres of the two segments in the phantom, as voxel indices. */
export const SEGMENT_1: [number, number, number] = [30, 22, 24];
export const SEGMENT_2: [number, number, number] = [17, 27, 23];

/**
 * Colour drawn in a view at a voxel, read back from the view's canvas. The image is
 * grey, so a pixel whose channels differ is mask overlay.
 */
export async function pixelAt(page: Page, view: string, ijk: [number, number, number]): Promise<[number, number, number]> {
  return page.evaluate(
    ({ view, ijk }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = (window as any).__w;
      const vol = w.session.getMask();
      const d = vol.direction as number[];
      const world = [0, 1, 2].map(
        (r) => vol.origin[r] + d[r] * vol.spacing[0] * ijk[0] + d[3 + r] * vol.spacing[1] * ijk[1] + d[6 + r] * vol.spacing[2] * ijk[2],
      );
      const [x, y] = w.engine.worldToCanvas(view, world) as [number, number];
      const canvas = document.querySelector(`[data-view="${view}"] canvas`) as HTMLCanvasElement;
      const scale = canvas.width / canvas.clientWidth;
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const ctx = copy.getContext('2d')!;
      ctx.drawImage(canvas, 0, 0);
      const px = ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
      return [px[0], px[1], px[2]] as [number, number, number];
    },
    { view, ijk },
  );
}

/** How many pixels of a view are tinted, that is, how much mask overlay (fill or outline) it shows. */
export async function tintedPixels(page: Page, view: string): Promise<number> {
  return page.evaluate((view) => {
    const canvas = document.querySelector(`[data-view="${view}"] canvas`) as HTMLCanvasElement;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext('2d')!;
    ctx.drawImage(canvas, 0, 0);
    const px = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) > 24) n++;
    }
    return n;
  }, view);
}

/** True when a pixel is tinted rather than grey. */
export const isTinted = (rgb: [number, number, number]): boolean => Math.max(...rgb) - Math.min(...rgb) > 24;

/** Moves every view to a voxel. */
export async function jumpToVoxel(page: Page, ijk: [number, number, number]): Promise<void> {
  await page.evaluate((ijk) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = (window as any).__w;
    const vol = w.session.getMask();
    const d = vol.direction as number[];
    const s = vol.spacing as number[];
    w.engine.jumpTo([0, 1, 2].map((r) => vol.origin[r] + d[r] * s[0] * ijk[0] + d[3 + r] * s[1] * ijk[1] + d[6 + r] * s[2] * ijk[2]));
  }, ijk);
}

/** A shortcut with the main modifier as the app shows it on this system: "Ctrl+S", or "⌘ S" on a Mac. */
export const modLabel = (key: string): string => (process.platform === 'darwin' ? `⌘ ${key}` : `Ctrl+${key}`);

/**
 * Presses Tab the way that reaches every control. WebKit on macOS, like Safari and the desktop
 * app's webview there, only stops at text fields with plain Tab unless "Keyboard navigation" is
 * on in System Settings; Option+Tab stops at buttons too, so that is what a keyboard user presses.
 */
export async function tab(page: Page, back = false): Promise<void> {
  const mac = process.platform === 'darwin' && page.context().browser()?.browserType().name() === 'webkit';
  await page.keyboard.press(`${mac ? 'Alt+' : ''}${back ? 'Shift+' : ''}Tab`);
}

/* ───────────────────────── rooms ───────────────────────── */

/** What an invite link looks like: the room server, a room id, and the secret after `#`, which no server sees. */
export const INVITE_LINK = /^http:\/\/[^/]+\/j\/[A-Z0-9]{12}#[A-Za-z0-9_-]{22}$/;

/** Starts a room on the image that is open and returns the first invite link. */
export async function startRoom(page: Page, name: string, kind: 'Shared copy' | 'View through my computer' = 'Shared copy'): Promise<string> {
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByPlaceholder('How others will see you').fill(name);
  await page.getByRole('radio', { name: kind }).check();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const link = (await page.getByTestId('room-link').textContent())!.trim();
  await page.keyboard.press('Escape');
  return link;
}

/** Another single-use link from the host's room menu. */
export async function anotherLink(host: Page, ttlSeconds?: number): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return host.evaluate((ttl) => (window as any).__w.session.createInvite(ttl), ttlSeconds);
}

/** Fills in the join form and submits it. Does not wait for the outcome. */
export async function submitJoin(page: Page, name: string, link: string): Promise<void> {
  if (!(await page.getByRole('dialog').isVisible())) {
    const inRoomless = page.getByRole('button', { name: 'Join a room', exact: true });
    if (await inRoomless.isVisible()) await inRoomless.click();
    else {
      await page.getByRole('button', { name: 'Share' }).click();
      await page.getByRole('tab', { name: 'Join a room' }).click();
    }
  }
  await page.getByPlaceholder('How others will see you').fill(name);
  await page.getByPlaceholder('Paste the invite link').fill(link);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
}

/** Joins a room from a fresh page and waits until its views are up. */
export async function joinRoom(page: Page, name: string, link: string): Promise<void> {
  await skipTour(page);
  await page.goto('/');
  await submitJoin(page, name, link);
  await page.locator('[data-view="axial"] canvas').first().waitFor({ timeout: 30_000 });
}

/** The whole mask as a string, to compare two people's masks voxel for voxel. */
export async function maskDump(page: Page): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return page.evaluate(() => Array.from((window as any).__w.session.getMask().data as Uint8Array).join(''));
}

/**
 * Puts this page's connection to the room server under the test's control. `cut()` breaks
 * the connection and refuses new ones, as a network that went away would; `restore()` lets
 * the app through again. Call it before the page joins or starts a room.
 */
export async function cuttable(page: Page): Promise<{ cut(): Promise<void>; restore(): void }> {
  let offline = false;
  const live = new Set<{ close(): Promise<void> }>();
  await page.routeWebSocket(/\/v2\/rooms\//, (ws) => {
    if (offline) {
      void ws.close();
      return;
    }
    const server = ws.connectToServer();
    const both = {
      close: async () => {
        await ws.close();
        await server.close();
      },
    };
    live.add(both);
    ws.onClose(() => live.delete(both));
  });
  return {
    cut: async () => {
      offline = true;
      const open = [...live];
      live.clear();
      await Promise.all(open.map((c) => c.close()));
    },
    restore: () => {
      offline = false;
    },
  };
}

/** Counts what the room server sends this page: bytes in all, and frames of each kind (the second byte of a frame). */
export function watchRoomTraffic(page: Page): { bytes: number; kinds: Record<number, number> } {
  const seen = { bytes: 0, kinds: {} as Record<number, number> };
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/v2/rooms/')) return;
    ws.on('framereceived', (frame) => {
      if (typeof frame.payload === 'string') return;
      seen.bytes += frame.payload.length;
      const kind = frame.payload[1];
      seen.kinds[kind] = (seen.kinds[kind] ?? 0) + 1;
    });
  });
  return seen;
}

/** The value the app holds for one voxel of the image. */
export async function imageValue(page: Page, ijk: [number, number, number]): Promise<number> {
  return page.evaluate((ijk) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vol = (window as any).__w.session.getImage();
    return vol.data[(ijk[2] * vol.dims[1] + ijk[1]) * vol.dims[0] + ijk[0]] as number;
  }, ijk);
}

/** One stored slice of the mask as a string. */
export async function sliceDump(page: Page, k: number): Promise<string> {
  return page.evaluate((k) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vol = (window as any).__w.session.getMask();
    const n = vol.dims[0] * vol.dims[1];
    return Array.from((vol.data as Uint8Array).subarray(k * n, (k + 1) * n)).join('');
  }, k);
}

/** After `restore()`: reconnect from the room menu rather than wait for the next attempt. */
export async function reconnectNow(page: Page): Promise<void> {
  await page.getByTestId('room-pill').click();
  // The app may have got there first; then there is nothing to press.
  await page
    .getByRole('button', { name: 'Reconnect now' })
    .click({ timeout: 2000 })
    .catch(() => undefined);
  await page.keyboard.press('Escape');
}
