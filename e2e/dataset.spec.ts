import { errors, expect, test, type FileChooser, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skipTour } from './helpers';

// Opening a folder has hung now and then in WebKit on CI, with nothing to show where.
// On CI a failing test here keeps its trace (test-results/), which is uploaded. Not
// locally: recording slows the first page of a cold dev server past the time limit.
test.use({ trace: process.env.CI ? 'retain-on-failure' : 'off' });

const N = 24;

/** A MetaImage file: a header and the voxels after it. */
function mha(data: Int16Array | Uint8Array): Buffer {
  const type = data instanceof Int16Array ? 'MET_SHORT' : 'MET_UCHAR';
  const header = `ObjectType = Image\nNDims = 3\nTransformMatrix = 1 0 0 0 1 0 0 0 1\nOffset = 0 0 0\nDimSize = ${N} ${N} ${N}\nElementSpacing = 1 1 1\nElementType = ${type}\nElementDataFile = LOCAL\n`;
  return Buffer.concat([Buffer.from(header, 'latin1'), Buffer.from(data.buffer)]);
}

const scan = () => {
  const d = new Int16Array(N * N * N);
  for (let i = 0; i < d.length; i++) d[i] = 100 + (i % 97) * 9;
  return mha(d);
};

/** A ball of one label value, so the test can tell which label file was opened. */
const ball = (value: number) => {
  const d = new Uint8Array(N * N * N);
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.hypot(x - 12, y - 12, z - 12) < 5) d[z * N * N + y * N + x] = value;
  return mha(d);
};

/**
 * A small dataset in the PANTHER layout: patient p1 has two scans, each with its
 * own label (values 1 and 2); patient p2 has one scan and no label.
 */
function makeDataset(): string {
  const root = mkdtempSync(join(tmpdir(), 'w-dataset-'));
  const ds = join(root, 'task1');
  for (const d of ['ImagesTr', 'ImagesTr_unlabeled', 'LabelsTr']) mkdirSync(join(ds, d), { recursive: true });
  writeFileSync(join(ds, 'ImagesTr', 'p1_0001_0000.mha'), scan());
  writeFileSync(join(ds, 'ImagesTr_unlabeled', 'p1_0002_0000.mha'), scan());
  writeFileSync(join(ds, 'ImagesTr', 'p2_0001_0000.mha'), scan());
  writeFileSync(join(ds, 'LabelsTr', 'p1_0001.mha'), ball(1));
  writeFileSync(join(ds, 'LabelsTr', 'p1_0002.mha'), ball(2));
  writeFileSync(join(ds, 'dataset.json'), '{}');
  return ds;
}

let folder = '';
test.beforeAll(() => {
  folder = makeDataset();
});
test.afterAll(() => {
  rmSync(join(folder, '..'), { recursive: true, force: true });
});

const rows = (page: Page) => page.locator('.filerow');

/**
 * Hands a folder to the picker. In WebKit, Playwright's folder upload now and
 * then never returns: it waits for the input's `input` event but starts
 * listening without waiting for the listener to be in place, so an early event
 * is missed (playwright-core 1.63, `_setInputFiles`). The wait is cut short
 * here; the checks after it then show whether the app got the folder.
 */
async function setFolder(chooser: FileChooser, path: string): Promise<void> {
  await chooser.setFiles(path, { timeout: 10_000 }).catch((err: unknown) => {
    if (!(err instanceof errors.TimeoutError)) throw err;
  });
}

/**
 * Voxels of `label` (any label when not given) in the mask on screen, or -1
 * while there is no mask yet: a case's label loads after its image, and a
 * slow browser can be asked before it is there.
 */
const voxels = (page: Page, label?: number) =>
  page.evaluate((label) => {
    const mask = window.__w.session.getMask() as { data: Uint8Array } | null;
    if (!mask) return -1;
    let n = 0;
    for (const v of mask.data) if (label === undefined ? v !== 0 : v === label) n++;
    return n;
  }, label);
const dataset = (page: Page) => page.getByRole('region', { name: 'Dataset' });
const caseRow = (page: Page, name: string) => page.getByRole('option', { name, exact: true });

async function openFolder(page: Page): Promise<void> {
  await skipTour(page);
  await page.goto('/');
  await page.waitForFunction(() => '__w' in window);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open a dataset folder' }).click();
  await setFolder(await chooser, folder);
  await expect(rows(page).nth(0)).toContainText('p1_0001_0000');
}

test('a dataset folder lists its cases by patient and opens the first one with its label', async ({ page }) => {
  await openFolder(page);
  await expect(dataset(page)).toContainText('task1');
  await expect(dataset(page).getByRole('group', { name: 'Patient p1' }).getByRole('option')).toHaveCount(2);
  await expect(caseRow(page, 'p2_0001, no label')).toBeVisible();
  await expect(caseRow(page, 'p1_0001')).toHaveAttribute('aria-selected', 'true');
  await expect(dataset(page).getByLabel('Case 1 of 3')).toBeVisible();
  // The case's own label is the mask, named after the case.
  await expect(rows(page).nth(1)).toContainText('p1_0001');
  await expect.poll(() => voxels(page, 1)).toBeGreaterThan(0);
  expect(await voxels(page, 2)).toBe(0);
});

test('the next case opens by click, button or shortcut, and a case without a label gets an empty mask', async ({ page }) => {
  await openFolder(page);
  await caseRow(page, 'p1_0002').click();
  await expect(rows(page).nth(0)).toContainText('p1_0002_0000');
  // The image shows first; its label follows.
  await expect.poll(() => voxels(page, 2)).toBeGreaterThan(0);

  await page.keyboard.press('Alt+ArrowDown');
  await expect(rows(page).nth(0)).toContainText('p2_0001_0000');
  await expect(caseRow(page, 'p2_0001, no label')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => voxels(page)).toBe(0);
  // Saving suggests the label name the case would have.
  await expect(page.locator('.filebtn')).toContainText('p2_0001.mha');

  await page.getByRole('button', { name: 'Next case' }).click();
  await expect(page.getByText('This is the last case.')).toBeVisible();
  await page.getByRole('button', { name: 'Previous case' }).click();
  await expect(rows(page).nth(0)).toContainText('p1_0002_0000');
});

test('a case can start from the label of its patient’s first scan', async ({ page }) => {
  await openFolder(page);
  await dataset(page).getByLabel('Start from').selectOption({ label: 'First scan’s label' });
  await caseRow(page, 'p1_0002').click();
  await expect(rows(page).nth(0)).toContainText('p1_0002_0000');
  // The ball of scan 0001's label, under the name of this case.
  await expect.poll(() => voxels(page, 1)).toBeGreaterThan(0);
  expect(await voxels(page, 2)).toBe(0);
  await expect(rows(page).nth(1)).toContainText('p1_0002');
  await expect(page.getByText('Started from the label of p1_0001. Check that it fits this scan.')).toBeVisible();

  // It is not saved for this case yet, so moving on asks.
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.getByRole('heading', { name: 'Save changes to p1_0002.mha?' })).toBeVisible();
  await page.getByRole('button', { name: "Don't save" }).click();
  await expect(rows(page).nth(0)).toContainText('p2_0001_0000');
});

test('a folder that is not an nnU-Net dataset says so and opens nothing', async ({ page }) => {
  await skipTour(page);
  await page.goto('/');
  await page.waitForFunction(() => '__w' in window);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open a dataset folder' }).click();
  await setFolder(await chooser, join(folder, 'LabelsTr'));
  await expect(page.getByText('No images named like nnU-Net cases (case_0000.nii.gz) were found in this folder.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Drop an image and a mask' })).toBeVisible();
});

test('closing the dataset keeps the case on screen', async ({ page }) => {
  await openFolder(page);
  await page.getByRole('button', { name: 'Close dataset' }).click();
  await expect(dataset(page)).toHaveCount(0);
  // The case on screen stays open.
  await expect(rows(page).nth(0)).toContainText('p1_0001_0000');
});

/**
 * Stands in for the browser's folder picker (File System Access API), which a
 * test cannot click through. The folder lives in `window.__out`: its name, its
 * files, and whether the next pick is cancelled.
 */
async function fakeOutputFolder(page: Page, name = 'labels_corrected', files: Record<string, number[]> = {}): Promise<void> {
  await page.addInitScript(
    ({ name, files }) => {
      const st = { name, cancel: false, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new Uint8Array(v)])) as Record<string, Uint8Array> };
      (window as unknown as { __out: typeof st }).__out = st;
      (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
        if (st.cancel) throw new DOMException('cancelled', 'AbortError');
        return {
          name: st.name,
          async *values() {
            for (const n of Object.keys(st.files)) yield { kind: 'file', name: n };
          },
          async getFileHandle(n: string, opts?: { create?: boolean }) {
            if (!(n in st.files) && !opts?.create) throw new DOMException('not found', 'NotFoundError');
            return {
              getFile: async () => new File([st.files[n] as BlobPart], n),
              createWritable: async () => {
                const parts: BlobPart[] = [];
                return {
                  write: async (b: BlobPart) => void parts.push(b),
                  close: async () => {
                    st.files[n] = new Uint8Array(await new Blob(parts).arrayBuffer());
                  },
                };
              },
            };
          },
        };
      };
    },
    { name, files },
  );
}

const written = (page: Page) => page.evaluate(() => Object.keys((window as unknown as { __out: { files: Record<string, Uint8Array> } }).__out.files).sort());
const progress = (page: Page) =>
  page.evaluate(() => JSON.parse(new TextDecoder().decode((window as unknown as { __out: { files: Record<string, Uint8Array> } }).__out.files['w-annotator-progress.json'])) as { cases: Record<string, { status: string; changed?: boolean; start?: string }> });

test('Done and next saves the case into the chosen folder, marks it and opens the next one', async ({ page }) => {
  await fakeOutputFolder(page);
  await openFolder(page);
  await expect(dataset(page).getByRole('button', { name: 'Choose folder…' })).toBeVisible();
  await dataset(page).getByRole('button', { name: 'Choose folder…' }).click();
  await expect(dataset(page)).toContainText('labels_corrected');
  await expect(dataset(page)).toContainText('0 done · 0 skipped · 3 left');

  await dataset(page).getByRole('button', { name: 'Done and next' }).click();
  await expect(caseRow(page, 'p1_0002')).toHaveAttribute('aria-selected', 'true');
  expect(await written(page)).toEqual(['p1_0001.mha', 'w-annotator-progress.json']);
  const first = await progress(page);
  expect(first.cases.p1_0001).toMatchObject({ status: 'done', changed: false, start: 'own' });
  await expect(caseRow(page, 'p1_0001, done')).toBeVisible();
  await expect(dataset(page)).toContainText('1 done · 0 skipped · 2 left');
  // The saved file is a compressed MetaImage on the image's grid.
  const header = await page.evaluate(() => new TextDecoder('latin1').decode((window as unknown as { __out: { files: Record<string, Uint8Array> } }).__out.files['p1_0001.mha'].slice(0, 400)));
  expect(header).toContain('CompressedData = True');
  expect(header).toContain('DimSize = 24 24 24');

  // An edit is recorded as a change; the shortcut does the same as the button.
  await expect.poll(() => voxels(page, 2)).toBeGreaterThan(0);
  await page.evaluate(() => window.__w.session.clearSegment(2));
  await page.keyboard.press('Control+Enter');
  await expect(caseRow(page, 'p2_0001, no label')).toHaveAttribute('aria-selected', 'true');
  expect((await progress(page)).cases.p1_0002).toMatchObject({ status: 'done', changed: true, start: 'own' });
});

test('Skip marks a case without saving a mask, asking first about unsaved edits', async ({ page }) => {
  await fakeOutputFolder(page);
  await openFolder(page);
  await expect.poll(() => voxels(page, 1)).toBeGreaterThan(0);
  await page.evaluate(() => window.__w.session.clearSegment(1));
  // No folder yet: Skip asks for one first.
  await dataset(page).getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Skip p1_0001?' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip', exact: true }).last().click();
  await expect(caseRow(page, 'p1_0002')).toHaveAttribute('aria-selected', 'true');
  expect(await written(page)).toEqual(['w-annotator-progress.json']);
  expect((await progress(page)).cases.p1_0001.status).toBe('skipped');
  await expect(caseRow(page, 'p1_0001, skipped')).toBeVisible();
});

test('a folder with earlier progress picks up where the work stopped', async ({ page }) => {
  const earlier = {
    version: 1,
    dataset: 'task1',
    cases: { p1_0001: { status: 'done', at: '2026-11-22T10:00:00.000Z', changed: true, start: 'own' } },
  };
  // The mask saved for p1_0001 earlier is a ball of label 2, unlike its original label 1.
  await fakeOutputFolder(page, 'labels_corrected', {
    'p1_0001.mha': Array.from(ball(2)),
    'w-annotator-progress.json': Array.from(Buffer.from(JSON.stringify(earlier))),
  });
  await openFolder(page);
  await dataset(page).getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText('labels_corrected already has 1 done and 0 skipped. They keep their status.')).toBeVisible();
  await expect(caseRow(page, 'p1_0001, done')).toBeVisible();

  // A done case opens with the mask saved for it.
  await caseRow(page, 'p1_0002').click();
  await expect(rows(page).nth(0)).toContainText('p1_0002_0000');
  await caseRow(page, 'p1_0001, done').click();
  await expect(rows(page).nth(0)).toContainText('p1_0001_0000');
  await expect.poll(() => voxels(page, 2)).toBeGreaterThan(0);
  expect(await voxels(page, 1)).toBe(0);

  // Done and next goes on to the next case not yet handled.
  await dataset(page).getByRole('button', { name: 'Done and next' }).click();
  await expect(caseRow(page, 'p1_0002')).toHaveAttribute('aria-selected', 'true');
});

test('the dataset’s own labels folder cannot be the output folder', async ({ page }) => {
  await fakeOutputFolder(page, 'LabelsTr', { 'p1_0001.mha': [1], 'p1_0002.mha': [1] });
  await openFolder(page);
  await dataset(page).getByRole('button', { name: 'Choose folder…' }).click();
  await expect(page.getByText("LabelsTr holds the dataset's own labels. Choose or make another folder, so the originals stay as they are.")).toBeVisible();
  await expect(dataset(page).getByRole('button', { name: 'Choose folder…' })).toBeVisible();
});

test('moving on with unsaved edits saves into the output folder when there is one', async ({ page }) => {
  await fakeOutputFolder(page);
  await openFolder(page);
  await dataset(page).getByRole('button', { name: 'Choose folder…' }).click();
  await expect(dataset(page)).toContainText('labels_corrected');
  await expect.poll(() => voxels(page, 1)).toBeGreaterThan(0);
  await page.evaluate(() => window.__w.session.clearSegment(1));
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.getByText('It is saved to labels_corrected and marked done.')).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(caseRow(page, 'p1_0002')).toHaveAttribute('aria-selected', 'true');
  expect(await written(page)).toEqual(['p1_0001.mha', 'w-annotator-progress.json']);
  expect((await progress(page)).cases.p1_0001).toMatchObject({ status: 'done', changed: true });
});

const outFile = (page: Page, name: string) =>
  page.evaluate((n) => Array.from((window as unknown as { __out: { files: Record<string, Uint8Array> } }).__out.files[n]), name);

async function zipNow(page: Page): Promise<{ name: string; files: Record<string, Uint8Array> }> {
  const [download] = await Promise.all([page.waitForEvent('download'), dataset(page).getByRole('button', { name: 'Zip for email…' }).click()]);
  return { name: download.suggestedFilename(), files: unzipSync(new Uint8Array(readFileSync((await download.path())!))) };
}

test('the output folder zips into one file for email: the masks of done cases and the progress', async ({ page }) => {
  await fakeOutputFolder(page);
  await openFolder(page);
  await dataset(page).getByRole('button', { name: 'Choose folder…' }).click();
  // Nothing done or skipped yet: nothing to send.
  await expect(dataset(page).getByRole('button', { name: 'Zip for email…' })).toBeDisabled();

  await dataset(page).getByRole('button', { name: 'Done and next' }).click();
  await expect(caseRow(page, 'p1_0002')).toHaveAttribute('aria-selected', 'true');
  await dataset(page).getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(caseRow(page, 'p2_0001, no label')).toHaveAttribute('aria-selected', 'true');

  const zip = await zipNow(page);
  expect(zip.name).toMatch(/^labels_corrected-\d{4}-\d{2}-\d{2}\.zip$/);
  expect(Object.keys(zip.files).sort()).toEqual(['labels_corrected/p1_0001.mha', 'labels_corrected/w-annotator-progress.json']);
  expect(Array.from(zip.files['labels_corrected/p1_0001.mha'])).toEqual(await outFile(page, 'p1_0001.mha'));
  const sent = JSON.parse(new TextDecoder().decode(zip.files['labels_corrected/w-annotator-progress.json'])) as { cases: Record<string, { status: string }> };
  expect(sent.cases.p1_0001.status).toBe('done');
  expect(sent.cases.p1_0002.status).toBe('skipped');
  await expect(page.getByText(/^Saved labels_corrected-[\d-]+\.zip: 1 mask, \d+ KB\. Attach it to an email\.$/)).toBeVisible();
  // The output folder itself is left as it was.
  expect(await written(page)).toEqual(['p1_0001.mha', 'w-annotator-progress.json']);
});

test('a case marked done whose mask is not in the folder is left out of the zip, and said so', async ({ page }) => {
  const earlier = {
    version: 1,
    dataset: 'task1',
    cases: {
      p1_0001: { status: 'done', at: '2026-11-22T10:00:00.000Z', changed: false, start: 'own' },
      p1_0002: { status: 'done', at: '2026-11-22T10:05:00.000Z', changed: true, start: 'own' },
    },
  };
  await fakeOutputFolder(page, 'labels_corrected', {
    'p1_0001.mha': Array.from(ball(1)),
    'w-annotator-progress.json': Array.from(Buffer.from(JSON.stringify(earlier))),
  });
  await openFolder(page);
  await dataset(page).getByRole('button', { name: 'Choose folder…' }).click();
  await expect(caseRow(page, 'p1_0002, done')).toBeVisible();

  const zip = await zipNow(page);
  expect(Object.keys(zip.files).sort()).toEqual(['labels_corrected/p1_0001.mha', 'labels_corrected/w-annotator-progress.json']);
  await expect(page.getByText(/1 case marked done has no mask in labels_corrected and is left out: p1_0002\./)).toBeVisible();
});
