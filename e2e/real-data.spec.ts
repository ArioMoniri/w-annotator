/**
 * Real-data checks. Skipped unless W_REALDATA_DIR points at a folder that holds
 * a cases.json manifest:
 *
 *   [{ "name": "picai-10964", "image": ["picai/10964/x_t2w.mha"], "mask": ["picai/10964/x_lesion.nii.gz"] }]
 *
 * Paths are relative to W_REALDATA_DIR. `image` may list a header and its data
 * file (.mhd + .raw). Masks must be NIfTI (.nii or .nii.gz) on the image grid.
 * The data never lives in the repository. See docs/reviews/real-data.md.
 *
 *   W_REALDATA_DIR=/tmp/realdata pnpm e2e e2e/real-data.spec.ts
 *   W_REALDATA_URL=http://localhost:4173   optional: test a built app instead of the dev server
 */
import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { drag, maskVoxels } from './helpers';

const DIR = process.env.W_REALDATA_DIR ?? '';
const manifest = DIR ? join(DIR, 'cases.json') : '';
interface Case {
  name: string;
  image: string[];
  mask: string[];
}
const cases: Case[] = manifest && existsSync(manifest) ? (JSON.parse(readFileSync(manifest, 'utf8')) as Case[]) : [];

test.skip(cases.length === 0, 'Set W_REALDATA_DIR to a folder with cases.json to run the real-data checks.');
test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.W_REALDATA_URL ? { baseURL: process.env.W_REALDATA_URL } : {}) });
test.setTimeout(240_000);

/* eslint-disable @typescript-eslint/no-explicit-any */
const abs = (rel: string[]) => rel.map((p) => join(DIR, p));

async function idle(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__w.store.getState().busy === null, null, { timeout: 180_000 });
}

async function openImage(page: Page, files: string[]): Promise<number> {
  await page.goto('/');
  await page.waitForFunction(() => '__w' in window);
  const started = Date.now();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open image', exact: true }).click();
  await (await chooser).setFiles(files);
  await page.waitForFunction(() => (window as any).__w.store.getState().image !== null, null, { timeout: 180_000 });
  await idle(page);
  await page.locator('[data-view="axial"] canvas').first().waitFor();
  return Date.now() - started;
}

async function openMask(page: Page, files: string[]): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.filebtn').click();
  await page.getByRole('menuitem', { name: /Open mask/ }).click();
  await (await chooser).setFiles(files);
  await page.waitForFunction(() => (window as any).__w.store.getState().maskName !== null, null, { timeout: 180_000 });
  await idle(page);
  await page.waitForTimeout(500);
}

const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__w.store.getState();
    return { toasts: s.toasts as { kind: string; text: string }[], segments: s.segments.map((x: any) => x.index) as number[], range: s.image.range as [number, number] };
  });

const geometry = (page: Page, which: 'image' | 'mask') =>
  page.evaluate((which) => {
    const v = which === 'mask' ? (window as any).__w.session.getMask() : (window as any).__w.session.getImage();
    return { dims: v.dims as number[], spacing: v.spacing as number[], origin: v.origin as number[], direction: v.direction as number[] };
  }, which);

const maskHash = (page: Page) =>
  page.evaluate(async () => {
    const h = await crypto.subtle.digest('SHA-256', (window as any).__w.session.getMask().data);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  });

const imageHash = (page: Page) =>
  page.evaluate(async () => {
    const d = (window as any).__w.session.getImage().data;
    const h = await crypto.subtle.digest('SHA-256', new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  });

async function maskBytes(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const d = (window as any).__w.session.getMask().data as Uint8Array;
    let s = '';
    for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return Buffer.from(b64, 'base64');
}

/** Keeps a copy of the mask in the page so later edits can be diffed against it. */
const remember = (page: Page, key: string) =>
  page.evaluate((key) => {
    (window as any)[key] = (window as any).__w.session.getMask().data.slice();
  }, key);

/** Voxels that differ from the remembered copy, with their bounding box in voxel indices. */
const changedSince = (page: Page, key: string) =>
  page.evaluate((key) => {
    const m = (window as any).__w.session.getMask();
    const d = m.data as Uint8Array;
    const o = (window as any)[key] as Uint8Array;
    const [nx, ny] = m.dims as number[];
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-1, -1, -1];
    let n = 0;
    for (let i = 0; i < d.length; i++) {
      if (d[i] === o[i]) continue;
      n++;
      const p = [i % nx, Math.floor(i / nx) % ny, Math.floor(i / (nx * ny))];
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], p[a]);
        hi[a] = Math.max(hi[a], p[a]);
      }
    }
    return { n, lo, hi };
  }, key);

async function saveMask(page: Page): Promise<Buffer> {
  const download = page.waitForEvent('download');
  await page.locator('.filebtn').click();
  await page.getByRole('menuitem', { name: /Save mask/ }).click();
  const path = await (await download).path();
  return readFileSync(path);
}

/** A minimal NIfTI-1 reader, independent of the app's own reader. Affine is RAS, row-major 3 × 4. */
function readNifti(file: Buffer): { dims: number[]; datatype: number; affine: number[]; values: (i: number) => number; count: number } {
  const b = file[0] === 0x1f && file[1] === 0x8b ? gunzipSync(file) : file;
  expect(b.readInt32LE(0)).toBe(348);
  const dims = [b.readInt16LE(42), b.readInt16LE(44), b.readInt16LE(46)];
  const datatype = b.readInt16LE(70);
  const offset = b.readFloatLE(108);
  const pix = [b.readFloatLE(76), b.readFloatLE(80), b.readFloatLE(84), b.readFloatLE(88)];
  let affine: number[];
  if (b.readInt16LE(254) > 0) affine = Array.from({ length: 12 }, (_, i) => b.readFloatLE(280 + i * 4));
  else {
    const [qb, qc, qd] = [b.readFloatLE(256), b.readFloatLE(260), b.readFloatLE(264)];
    const qa = Math.sqrt(Math.max(0, 1 - (qb * qb + qc * qc + qd * qd)));
    const q = pix[0] < 0 ? -1 : 1;
    const r = [
      [qa * qa + qb * qb - qc * qc - qd * qd, 2 * (qb * qc - qa * qd), 2 * (qb * qd + qa * qc)],
      [2 * (qb * qc + qa * qd), qa * qa + qc * qc - qb * qb - qd * qd, 2 * (qc * qd - qa * qb)],
      [2 * (qb * qd - qa * qc), 2 * (qc * qd + qa * qb), qa * qa + qd * qd - qb * qb - qc * qc],
    ];
    const t = [b.readFloatLE(268), b.readFloatLE(272), b.readFloatLE(276)];
    affine = r.flatMap((row, i) => [row[0] * pix[1], row[1] * pix[2], row[2] * pix[3] * q, t[i]]);
  }
  const readers: Record<number, [number, (o: number) => number]> = {
    2: [1, (o) => b.readUInt8(o)],
    4: [2, (o) => b.readInt16LE(o)],
    512: [2, (o) => b.readUInt16LE(o)],
    8: [4, (o) => b.readInt32LE(o)],
    16: [4, (o) => b.readFloatLE(o)],
    64: [8, (o) => b.readDoubleLE(o)],
  };
  const reader = readers[datatype];
  expect(reader, `NIfTI datatype ${datatype}`).toBeTruthy();
  return { dims, datatype, affine, count: dims[0] * dims[1] * dims[2], values: (i) => Math.round(reader[1](offset + i * reader[0])) };
}

/** The RAS affine a NIfTI file should carry for the app's LPS geometry. */
function rasAffine(g: { spacing: number[]; origin: number[]; direction: number[] }): number[] {
  const { spacing: s, origin: o, direction: d } = g;
  return [
    -d[0] * s[0], -d[3] * s[1], -d[6] * s[2], -o[0],
    -d[1] * s[0], -d[4] * s[1], -d[7] * s[2], -o[1],
    d[2] * s[0], d[5] * s[1], d[8] * s[2], o[2],
  ];
}

const closeTo = (a: number[], b: number[], tol: number) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

for (const c of cases) {
  test.describe(c.name, () => {
    test('opens the image with its mask on the same grid', async ({ page }) => {
      const ms = await openImage(page, abs(c.image));
      await openMask(page, abs(c.mask));
      const s = await state(page);
      expect(s.toasts.filter((t) => t.kind === 'error' || t.kind === 'warning')).toEqual([]);
      expect(s.segments.length).toBeGreaterThan(0);
      expect(await maskVoxels(page)).toBeGreaterThan(0);
      expect(await geometry(page, 'mask')).toEqual(await geometry(page, 'image'));

      // The loaded mask holds exactly the file's voxels, and sits where the file says it does.
      const original = readNifti(readFileSync(abs(c.mask)[0]));
      const loaded = await maskBytes(page);
      const g = await geometry(page, 'mask');
      expect(original.dims).toEqual(g.dims);
      expect(closeTo(original.affine, rasAffine(g), 1e-3)).toBe(true);
      let differing = 0;
      for (let i = 0; i < original.count; i++) if (original.values(i) !== loaded[i]) differing++;
      expect(differing).toBe(0);
      test.info().annotations.push({ type: 'load', description: `${g.dims.join(' × ')} in ${ms} ms` });
    });

    test('brush, eraser, undo and redo, then a saved mask that verifies and reopens', async ({ page, browser }) => {
      await openImage(page, abs(c.image));
      await openMask(page, abs(c.mask));
      const start = await maskHash(page);
      await remember(page, '__start');

      await page.keyboard.press('b');
      await drag(page, 'axial', [-70, -60], [-20, -40]);
      const painted = await changedSince(page, '__start');
      expect(painted.n).toBeGreaterThan(0);
      const afterBrush = await maskHash(page);

      await page.keyboard.press('Control+z');
      await expect.poll(() => maskHash(page)).toBe(start);
      await page.keyboard.press('Control+Shift+z');
      await expect.poll(() => maskHash(page)).toBe(afterBrush);

      await page.keyboard.press('e');
      const before = await maskVoxels(page);
      await drag(page, 'axial', [-50, -75], [-45, -30]);
      expect(await maskVoxels(page)).toBeLessThan(before);

      const edit = await changedSince(page, '__start');
      const g = await geometry(page, 'mask');
      const final = await maskBytes(page);
      const savedFile = await saveMask(page);
      const saved = readNifti(savedFile);
      await expect(page.getByTestId('sync')).toHaveText('Saved');

      // Geometry: what the app shows, and what the original mask file said.
      const original = readNifti(readFileSync(abs(c.mask)[0]));
      expect(saved.dims).toEqual(g.dims);
      expect(saved.datatype).toBe(2);
      expect(closeTo(saved.affine, rasAffine(g), 1e-3)).toBe(true);
      expect(closeTo(saved.affine, original.affine, 1e-3)).toBe(true);

      // Voxels: the file is the app's mask; outside the edited box it is the original file.
      const [nx, ny] = g.dims;
      let wrong = 0;
      let outside = 0;
      let inside = 0;
      for (let i = 0; i < saved.count; i++) {
        const v = saved.values(i);
        if (v !== final[i]) wrong++;
        if (v === original.values(i)) continue;
        const p = [i % nx, Math.floor(i / nx) % ny, Math.floor(i / (nx * ny))];
        if (p.every((x, a) => x >= edit.lo[a] && x <= edit.hi[a])) inside++;
        else outside++;
      }
      expect(wrong).toBe(0);
      expect(outside).toBe(0);
      expect(inside).toBe(edit.n);

      // Reopening the saved file gives the same mask.
      const again = await (await browser.newContext()).newPage();
      await openImage(again, abs(c.image));
      const download = join(test.info().outputDir, 'saved.nii.gz');
      mkdirSync(test.info().outputDir, { recursive: true });
      writeFileSync(download, savedFile);
      await openMask(again, [download]);
      expect(await maskHash(again)).toBe(await maskHash(page));
      await again.context().close();
    });

    test('threshold brush only paints voxels inside its range', async ({ page }) => {
      await openImage(page, abs(c.image));
      await openMask(page, abs(c.mask));
      const { range } = await state(page);
      // A band that cannot contain zero, so "paint everything" and "paint nothing" both show up.
      const lo = Math.round(range[0] + (range[1] - range[0]) * 0.35);
      const hi = Math.round(range[0] + (range[1] - range[0]) * 0.9);
      await page.keyboard.press('t');
      await page.evaluate((r) => (window as any).__w.session.setToolOption({ threshold: r }), [lo, hi]);
      const stroke: [[number, number], [number, number]][] = [
        [[-120, -100], [120, -100]],
        [[-120, 0], [120, 0]],
        [[-120, 100], [120, 100]],
      ];
      await remember(page, '__start');
      for (const [from, to] of stroke) await drag(page, 'axial', from, to);
      const result = await page.evaluate(([lo, hi]) => {
        const m = (window as any).__w.session.getMask().data as Uint8Array;
        const o = (window as any).__start as Uint8Array;
        const im = (window as any).__w.session.getImage().data as ArrayLike<number>;
        let painted = 0;
        let outside = 0;
        for (let i = 0; i < m.length; i++) {
          if (m[i] === o[i]) continue;
          painted++;
          if (im[i] < lo || im[i] > hi) outside++;
        }
        return { painted, outside };
      }, [lo, hi]);
      // What a plain brush covers on the same strokes, to know how much was in range.
      await page.evaluate(() => (window as any).__w.session.undo());
      await page.keyboard.press('b');
      await remember(page, '__plain');
      for (const [from, to] of stroke) await drag(page, 'axial', from, to);
      const expected = await page.evaluate(([lo, hi]) => {
        const m = (window as any).__w.session.getMask().data as Uint8Array;
        const o = (window as any).__plain as Uint8Array;
        const im = (window as any).__w.session.getImage().data as ArrayLike<number>;
        let n = 0;
        for (let i = 0; i < m.length; i++) if (m[i] !== o[i] && im[i] >= lo && im[i] <= hi) n++;
        return n;
      }, [lo, hi]);
      expect(result.outside).toBe(0);
      if (expected > 0) expect(result.painted).toBeGreaterThan(0);
    });

    test('crosshair click moves the other views to that point', async ({ page }) => {
      await openImage(page, abs(c.image));
      const slices = () => page.evaluate(() => JSON.stringify((window as any).__w.store.getState().slices));
      const before = JSON.parse(await slices()) as Record<string, { index: number }>;
      const box = (await page.locator('[data-view="axial"]').boundingBox())!;
      await page.keyboard.press('c');
      await page.mouse.click(box.x + box.width / 2 + 60, box.y + box.height / 2 + 50, { delay: 80 });
      await expect
        .poll(async () => {
          const now = JSON.parse(await slices()) as Record<string, { index: number }>;
          return now.sagittal.index !== before.sagittal.index && now.coronal.index !== before.coronal.index;
        })
        .toBe(true);
    });

    test('a guest with nothing open gets the image and mask from the room, and edits converge', async ({ browser }) => {
      const hostCtx = await browser.newContext();
      const guestCtx = await browser.newContext();
      const host = await hostCtx.newPage();
      const guest = await guestCtx.newPage();
      await openImage(host, abs(c.image));
      await openMask(host, abs(c.mask));

      await host.getByRole('button', { name: 'Share' }).click();
      await host.getByPlaceholder('How others will see you').fill('Mina');
      await host.getByRole('button', { name: 'Start', exact: true }).click();
      const link = (await host.getByTestId('room-link').textContent())!.trim();
      await host.keyboard.press('Escape');

      await guest.goto('/');
      await guest.getByRole('button', { name: 'Join a room', exact: true }).click();
      await guest.getByPlaceholder('How others will see you').fill('Ario');
      await guest.getByPlaceholder('Paste the invite link').fill(link);
      const started = Date.now();
      await guest.getByRole('button', { name: 'Join', exact: true }).click();
      await guest.waitForFunction(
        () => {
          const s = (window as any).__w.store.getState();
          return s.image !== null && s.busy === null && s.maskName !== null;
        },
        null,
        { timeout: 180_000 },
      );
      test.info().annotations.push({ type: 'room', description: `guest had the case after ${Date.now() - started} ms` });
      expect(await imageHash(guest)).toBe(await imageHash(host));
      expect(await maskHash(guest)).toBe(await maskHash(host));
      const hg = await geometry(host, 'mask');
      const gg = await geometry(guest, 'mask');
      expect(gg.dims).toEqual(hg.dims);
      expect(closeTo(rasAffine(gg), rasAffine(hg), 1e-9)).toBe(true);

      await host.keyboard.press('b');
      await drag(host, 'axial', [-70, -60], [-20, -40]);
      await expect.poll(() => maskHash(guest)).toBe(await maskHash(host));
      await guest.keyboard.press('e');
      await drag(guest, 'axial', [-50, -75], [-45, -30]);
      await expect.poll(async () => (await maskHash(host)) === (await maskHash(guest))).toBe(true);
      await Promise.all([drag(host, 'axial', [-90, 60], [-40, 90]), drag(guest, 'axial', [60, -80], [110, -50])]);
      await expect.poll(async () => (await maskHash(host)) === (await maskHash(guest))).toBe(true);

      // The guest's save holds the shared mask at the original file's position.
      const final = await maskBytes(host);
      const saved = readNifti(await saveMask(guest));
      const original = readNifti(readFileSync(abs(c.mask)[0]));
      expect(saved.dims).toEqual(original.dims);
      expect(closeTo(saved.affine, original.affine, 1e-3)).toBe(true);
      let wrong = 0;
      for (let i = 0; i < saved.count; i++) if (saved.values(i) !== final[i]) wrong++;
      expect(wrong).toBe(0);

      await hostCtx.close();
      await guestCtx.close();
    });
  });
}
