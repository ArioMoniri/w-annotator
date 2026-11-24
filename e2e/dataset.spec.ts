import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maskVoxels, skipTour } from './helpers';

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
const dataset = (page: Page) => page.getByRole('region', { name: 'Dataset' });
const caseRow = (page: Page, name: string) => page.getByRole('option', { name, exact: true });

async function openFolder(page: Page): Promise<void> {
  await skipTour(page);
  await page.goto('/');
  await page.waitForFunction(() => '__w' in window);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open a dataset folder' }).click();
  await (await chooser).setFiles(folder);
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
  await expect.poll(() => maskVoxels(page, 1)).toBeGreaterThan(0);
  expect(await maskVoxels(page, 2)).toBe(0);
});

test('the next case opens by click, button or shortcut, and a case without a label gets an empty mask', async ({ page }) => {
  await openFolder(page);
  await caseRow(page, 'p1_0002').click();
  await expect(rows(page).nth(0)).toContainText('p1_0002_0000');
  // The image shows first; its label follows.
  await expect.poll(() => maskVoxels(page, 2)).toBeGreaterThan(0);

  await page.keyboard.press('Alt+ArrowDown');
  await expect(rows(page).nth(0)).toContainText('p2_0001_0000');
  await expect(caseRow(page, 'p2_0001, no label')).toHaveAttribute('aria-selected', 'true');
  expect(await maskVoxels(page)).toBe(0);
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
  await expect.poll(() => maskVoxels(page, 1)).toBeGreaterThan(0);
  expect(await maskVoxels(page, 2)).toBe(0);
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
  await (await chooser).setFiles(join(folder, 'LabelsTr'));
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
