import { expect, test, type Page } from '@playwright/test';
import { copiedText, openPhantom } from './helpers';

/** Records what the app asks the browser to open, instead of leaving for GitHub. */
async function stubOpen(page: Page): Promise<() => Promise<{ url: string; target: string; features: string }[]>> {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    (window as unknown as Record<string, unknown>).__opened = calls;
    window.open = (url?: string | URL, target?: string, features?: string) => {
      calls.push({ url: String(url), target, features });
      return null;
    };
  });
  return () => page.evaluate(() => (window as unknown as { __opened: { url: string; target: string; features: string }[] }).__opened);
}

test('a bug report opens the pre-filled GitHub form with technical details and no file names', async ({ page }) => {
  const opened = await stubOpen(page);
  await openPhantom(page);

  // An error that mentions the open files, as a parser or the viewer might log it.
  await page.evaluate(() => console.error('Could not render phantom_ct.nii from /Users/mina/scans/phantom_seg.nii'));

  await page.locator('.filebtn').click();
  await page.getByRole('menuitem', { name: 'Report a problem…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Report a problem' });
  await expect(dialog).toContainText('Do not include patient names or screenshots of patient data.');

  await dialog.getByLabel('Title').fill('Fill leaks & spills');
  await dialog.getByLabel('What happened').fill('The fill went through a gap.\nIt covered 50% of the slice?');
  await dialog.getByLabel('What you expected').fill('It stays inside the outline');
  await dialog.getByLabel('Steps to reproduce').fill('1. Open\n2. Fill');

  // The preview shows what will be sent.
  await expect(dialog.getByLabel('Include technical details')).toBeChecked();
  await dialog.getByText('What will be sent').click();
  const preview = dialog.getByTestId('report-preview');
  await expect(preview).toContainText('Image: 48 × 48 × 48, Int16');
  await expect(preview).toContainText('Mask: 48 × 48 × 48, Uint8');
  await expect(preview).toContainText('File formats: .nii image, .nii mask');
  const previewText = (await preview.textContent())!.trim();

  await dialog.getByRole('button', { name: 'Continue on GitHub' }).click();
  await expect(dialog).toBeHidden();

  const calls = await opened();
  expect(calls).toHaveLength(1);
  expect(calls[0].target).toBe('_blank');
  expect(calls[0].features).toBe('noopener');
  const url = calls[0].url;
  expect(url.startsWith('https://github.com/ArioMoniri/w-annotator/issues/new?template=bug.yml&')).toBe(true);
  expect(url).toContain('title=Bug%3A%20Fill%20leaks%20%26%20spills');
  expect(url).toContain('what=The%20fill%20went%20through%20a%20gap.%0AIt%20covered%2050%25%20of%20the%20slice%3F');
  expect(url.length).toBeLessThanOrEqual(7500);

  const p = new URL(url).searchParams;
  expect(p.get('expected')).toBe('It stays inside the outline');
  expect(p.get('steps')).toBe('1. Open\n2. Fill');
  expect(p.get('version')).toMatch(/^\d+\.\d+\.\d+/);
  expect(['macOS', 'Windows', 'Linux']).toContain(p.get('os'));
  expect(p.get('data')).toBe('.nii image, .nii mask');
  expect(p.get('logs')).toContain('Image: 48 × 48 × 48, Int16');
  expect(p.get('logs')).toContain('error: Could not render <file> from <path>');
  // The preview was exactly what went into the link.
  expect(previewText).toBe(
    [`App version: ${p.get('version')}`, `Operating system: ${p.get('os')}`, `File formats: ${p.get('data')}`, p.get('logs')].join('\n'),
  );

  // Nothing in the link names the files or where they were.
  const decoded = decodeURIComponent(url);
  expect(decoded).not.toMatch(/phantom/i);
  expect(decoded).not.toMatch(/mina|scans/i);
});

test('technical details are left out when the box is unticked', async ({ page }) => {
  const opened = await stubOpen(page);
  await openPhantom(page);
  await page.locator('.filebtn').click();
  await page.getByRole('menuitem', { name: 'Report a problem…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Report a problem' });

  // Nothing is opened until the report says something.
  await dialog.getByRole('button', { name: 'Continue on GitHub' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Add a short title.');
  expect(await opened()).toHaveLength(0);

  await dialog.getByLabel('Title').fill('Crash on save');
  await dialog.getByLabel('What happened').fill('It closed');
  await dialog.getByLabel('Include technical details').uncheck();
  await expect(dialog.getByText('What will be sent')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Continue on GitHub' }).click();

  const [{ url }] = await opened();
  const p = new URL(url).searchParams;
  expect([...p.keys()].sort()).toEqual(['template', 'title', 'what']);
  expect(p.get('template')).toBe('bug.yml');
  expect(decodeURIComponent(url)).not.toMatch(/phantom/i);
});

test('an idea can be sent from the empty state, by keyboard, or copied instead', async ({ page }) => {
  const readCopied = await copiedText(page);
  const opened = await stubOpen(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Report a problem' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Title')).toBeFocused();

  await dialog.getByRole('tab', { name: 'Idea' }).click();
  await expect(page.getByRole('dialog', { name: 'Suggest an idea' })).toBeVisible();
  await dialog.getByLabel('Title').fill('Lasso');
  await dialog.getByLabel('Problem').fill('Outlining is slow');
  // Typing in the dialog never reaches the app's shortcuts.
  await dialog.getByLabel('Proposal').fill('A lasso tool?');
  await expect(page.getByRole('dialog')).toHaveCount(1);

  await dialog.getByRole('button', { name: 'Copy report' }).click();
  await expect(page.locator('.toast')).toContainText('Report copied');
  const copied = await readCopied();
  expect(copied).toContain('Feature: Lasso');
  expect(copied).toContain('Problem\nOutlining is slow');
  expect(copied).toContain('Proposal\nA lasso tool?');

  await dialog.getByLabel('Proposal').press('Enter'); // a new line, not a submit
  expect(await opened()).toHaveLength(0);
  await dialog.getByLabel('Title').press('Enter');
  await expect(dialog).toBeHidden();

  const [{ url }] = await opened();
  const p = new URL(url).searchParams;
  expect(p.get('template')).toBe('feature.yml');
  expect(p.get('title')).toBe('Feature: Lasso');
  expect(p.get('problem')).toMatch(/^Outlining is slow\n\nApp version: \d+\.\d+\.\d+/);
  expect(p.get('proposal')).toBe('A lasso tool?');
});

test('an unexpected error offers to report it; Escape closes the dialog', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => '__w' in window);
  // The browser refusing to schedule a frame stands in for a failure nobody planned for,
  // unlike a damaged or unsupported file.
  await page.evaluate(async () => {
    const real = window.requestAnimationFrame;
    window.requestAnimationFrame = () => {
      throw new Error('Could not draw /Users/mina/scans/broken.nii');
    };
    try {
      await window.__w.session.openFiles([{ name: 'broken.nii', bytes: new Uint8Array(10) }]);
    } finally {
      window.requestAnimationFrame = real;
    }
  });
  const toast = page.locator('.toast[data-kind="error"]');
  await toast.getByRole('button', { name: 'Report' }).click();
  const dialog = page.getByRole('dialog', { name: 'Report a problem' });
  await expect(dialog).toBeVisible();
  // The error is in the details, without the path it mentioned.
  await dialog.getByText('What will be sent').click();
  await expect(dialog.getByTestId('report-preview')).toContainText('error: Error: Could not draw <path>');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a file that cannot be read is not something to report', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => '__w' in window);
  await page.evaluate(() =>
    window.__w.session.openFiles([{ name: 'broken.nii', bytes: new Uint8Array(10) }]),
  );
  const toast = page.locator('.toast[data-kind="error"]');
  await expect(toast).toBeVisible();
  await expect(toast.getByRole('button', { name: 'Report' })).toHaveCount(0);
});
