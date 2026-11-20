import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { isTinted, jumpToVoxel, pixelAt } from './helpers';

// The sample is opened from the welcome tour, which is for first launches.
test.use({ storageState: { cookies: [], origins: [] } });

/** Dimensions and segment names of a bundled file, read straight from its NIfTI header. */
function bundled(name: string): { dims: number[]; labels: Record<string, string> } {
  const nii = gunzipSync(readFileSync(`public/sample/${name}`));
  const dims = [42, 44, 46].map((at) => nii.readInt16LE(at));
  let labels: Record<string, string> = {};
  if (nii[348] === 1) {
    const size = nii.readInt32LE(352);
    const text = nii.subarray(360, 352 + size).toString('utf8').replace(/\0+$/, '');
    labels = (JSON.parse(text) as { 'w-annotator': { labels: Record<string, string> } })['w-annotator'].labels;
  }
  return { dims, labels };
}

async function openSample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open a sample to look around' }).click();
  await page.locator('[data-view="axial"] canvas').first().waitFor();
  await expect(page.getByTestId('tour-card')).toHaveAttribute('data-step', 'views');
}

interface Opened {
  image: { name: string; dims: number[] };
  mask: { dims: number[] };
  voi: { lower: number; upper: number };
}

const opened = (page: Page) =>
  page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = (window as any).__w;
    return {
      image: { name: w.session.getImage().name, dims: w.session.getImage().dims },
      mask: { dims: w.session.getMask().dims },
      voi: w.store.getState().voi,
    } as Opened;
  });

/** A voxel well inside a segment: the one nearest the middle of its largest slice. */
const middleOf = (page: Page, label: number) =>
  page.evaluate((label) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mask = (window as any).__w.session.getMask();
    const [nx, ny, nz] = mask.dims as number[];
    const d = mask.data as Uint8Array;
    let best = { z: 0, n: 0, x: 0, y: 0 };
    for (let z = 0; z < nz; z++) {
      let n = 0;
      let sx = 0;
      let sy = 0;
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++)
          if (d[(z * ny + y) * nx + x] === label) {
            n++;
            sx += x;
            sy += y;
          }
      if (n > best.n) best = { z, n, x: Math.round(sx / n), y: Math.round(sy / n) };
    }
    return { ijk: [best.x, best.y, best.z] as [number, number, number], value: d[(best.z * ny + best.y) * nx + best.x] as number, nx };
  }, label);

test('the tour opens the bundled scan with its named lung mask, on a lung window', async ({ page }) => {
  const image = bundled('chest_ct.nii.gz');
  const mask = bundled('lungs.nii.gz');
  expect(mask.labels).toEqual({ 1: 'Left lung', 2: 'Right lung', 3: 'Airways' });

  await openSample(page);
  const now = await opened(page);
  expect(now.image.name).toBe('chest_ct.nii.gz');
  expect(now.image.dims).toEqual(image.dims);
  expect(now.mask.dims).toEqual(mask.dims);
  expect(now.voi).toEqual({ lower: -1350, upper: 150 });
  await expect(page.locator('.segrow')).toHaveCount(3);
  for (const name of Object.values(mask.labels)) await expect(page.locator('.segrow').filter({ hasText: name })).toHaveCount(1);
  // Nothing went wrong on the way.
  await expect(page.locator('.toast')).toHaveCount(0);
});

test('the mask lies on the lungs, with the left lung on the right of the axial view', async ({ page }) => {
  await openSample(page);
  await page.getByRole('button', { name: 'Skip tour' }).click();

  const left = await middleOf(page, 1);
  const right = await middleOf(page, 2);
  // The voxel in the middle of the left lung carries the left-lung label, and sits in the half of the grid towards patient left.
  expect(left.value).toBe(1);
  expect(left.ijk[0]).toBeGreaterThan(left.nx / 2);
  expect(right.ijk[0]).toBeLessThan(right.nx / 2);

  // It is air there, and the overlay is drawn on it.
  const hu = await page.evaluate(([x, y, z]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const image = (window as any).__w.session.getImage();
    return image.data[(z * image.dims[1] + y) * image.dims[0] + x] as number;
  }, left.ijk);
  expect(hu).toBeLessThan(-600);
  await jumpToVoxel(page, left.ijk);
  await page.waitForTimeout(600);
  expect(isTinted(await pixelAt(page, 'axial', left.ijk))).toBe(true);

  // Patient left is drawn on the right of the screen in the axial view.
  const screenX = (ijk: [number, number, number]) =>
    page.evaluate((ijk) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = (window as any).__w;
      const vol = w.session.getMask();
      const world = [0, 1, 2].map((r) => vol.origin[r] + vol.direction[r] * vol.spacing[0] * ijk[0] + vol.direction[3 + r] * vol.spacing[1] * ijk[1] + vol.direction[6 + r] * vol.spacing[2] * ijk[2]);
      return (w.engine.worldToCanvas('axial', world) as [number, number])[0];
    }, ijk);
  expect(await screenX(left.ijk)).toBeGreaterThan(await screenX([right.ijk[0], right.ijk[1], left.ijk[2]]));
});

test('when the bundled scan cannot be loaded, the phantom opens and the tour goes on', async ({ page }) => {
  await page.route('**/sample/**', (route) => route.abort());
  await openSample(page);
  const now = await opened(page);
  expect(now.image.name).toBe('sample_image.nii');
  expect(now.image.dims).toEqual([64, 64, 48]);
  await expect(page.locator('.segrow')).toHaveCount(2);
  await expect(page.locator('.toast')).toHaveText(/The sample scan couldn't be loaded\. A simple test image is open instead\./);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByTestId('tour-card')).toHaveAttribute('data-step', 'tools');
});

test('the first card says what the sample is', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tour-card')).toContainText('The sample is a public research scan.');
});

test('the opened sample in both themes', async ({ page }) => {
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(() => localStorage.clear()).catch(() => {});
    await openSample(page);
    await page.getByRole('button', { name: 'Skip tour' }).click();
    const left = await middleOf(page, 1);
    await jumpToVoxel(page, left.ijk);
    await page.waitForTimeout(1200);
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await page.screenshot({ path: `test-results/sample/sample-${scheme}.png` });
  }
});
