import { expect, test, type Page } from '@playwright/test';
import { drag, modLabel, openPhantom } from './helpers';

/**
 * A tooltip is drawn from `data-tip` by a pseudo-element. It is something to look at: the
 * name a control has for a screen reader, or for a test that finds it by role, is the same
 * with tooltips as without them.
 */

/** Everything a screen reader is told about the page, with tooltips as shipped or with none at all. */
async function tree(page: Page, tooltips: boolean): Promise<string> {
  const off = tooltips ? null : await page.addStyleTag({ content: '[data-tip]::after { content: none !important; }' });
  const snapshot = await page.locator('body').ariaSnapshot();
  await off?.evaluate((el) => (el as HTMLElement).remove());
  // The save state in the status bar changes by itself as a recovery copy is written.
  return snapshot
    .split('\n')
    .filter((line) => !/^\s*- text: (Unsaved changes|Saved)/.test(line))
    .join('\n');
}

/** The names the browser itself gives the tooltipped buttons, where it can be asked (Chromium). */
async function browserNames(page: Page): Promise<string[] | null> {
  if (page.context().browser()?.browserType().name() !== 'chromium') return null;
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'button[data-tip]' });
  const names: string[] = [];
  for (const nodeId of nodeIds) {
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    names.push(String(nodes[0]?.name?.value ?? ''));
  }
  await cdp.detach();
  return names;
}

async function previewFill(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add segment' }).first().click();
  await drag(page, 'axial', [-20, 0], [20, 0]);
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await drag(page, 'axial', [-20, 0], [20, 0]);
  await page.keyboard.press('i');
  await expect(page.locator('.strip [role="status"]')).toBeVisible();
}

test('tooltipped buttons are found by their own names', async ({ page }) => {
  await openPhantom(page, false);
  await previewFill(page);
  // The two buttons of a fill preview carry text and a tooltip with the key beside it.
  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await expect(apply).toHaveCount(1);
  await expect(cancel).toHaveCount(1);
  await expect(apply).toHaveAttribute('data-tip', 'Apply  Enter');
  // Hovered or focused, when the tip is on screen, the name is still the button's own.
  await apply.hover();
  await expect(apply).toHaveAccessibleName('Apply');
  // And the tip is still what is drawn.
  expect(await apply.evaluate((el) => getComputedStyle(el, '::after').content)).toContain('Apply  Enter');
  await expect.poll(() => apply.evaluate((el) => getComputedStyle(el, '::after').opacity)).toBe('1');
  await cancel.focus();
  await expect(cancel).toHaveAccessibleName('Cancel');
  await cancel.click();

  // Buttons with text of their own, across the top bar and the strips.
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveAttribute('data-tip', 'Start or join a room');
  await page.keyboard.press('b');
  const fill = page.getByRole('button', { name: 'Fill between slices', exact: true });
  await expect(fill).toHaveAttribute('data-tip', /^Paint every few slices/);
  // Icon buttons, named by a label: tool rail, layout, panel, segment rows, views.
  await expect(page.getByRole('radio', { name: 'Brush', exact: true })).toHaveAttribute('data-tip', /^Brush/);
  await expect(page.getByRole('group', { name: 'Layout' }).getByRole('button', { name: '2 × 2', exact: true })).toHaveAttribute('data-tip', `2 × 2  ${modLabel('1')}`);
  await expect(page.getByRole('button', { name: 'Hide segments', exact: true })).toHaveAttribute('data-tip', /^Hide segments/);
  await page.locator('.segrow').first().hover();
  await expect(page.locator('.segrow').getByRole('button', { name: 'Lock', exact: true })).toHaveAttribute('data-tip', 'Lock');
  await page.locator('[data-view="axial"]').hover();
  await expect(page.locator('[data-view="axial"]').getByRole('button', { name: 'Maximise', exact: true })).toHaveAttribute('data-tip', /^Maximise/);
});

test('tooltips add nothing to what a screen reader is told', async ({ page }) => {
  await openPhantom(page, false);
  const compare = async (what: string) => {
    await page.mouse.move(2, 2);
    expect(await page.locator('[data-tip]').count(), what).toBeGreaterThan(10);
    expect(await tree(page, true), what).toBe(await tree(page, false));
    const names = await browserNames(page);
    if (!names) return;
    const tips = await page.locator('button[data-tip]').evaluateAll((all) => all.map((el) => (el as HTMLElement).dataset.tip!));
    expect(names.length, what).toBe(tips.length);
    await page.addStyleTag({ content: '[data-tip]::after { content: none !important; }' }).then(async (off) => {
      expect(names, what).toEqual(await browserNames(page));
      await off.evaluate((el) => (el as HTMLElement).remove());
    });
  };
  await compare('no segment');
  await previewFill(page);
  await compare('fill preview');
  await page.keyboard.press('Escape');
  for (const key of ['b', 't', 's', 'f']) {
    await page.keyboard.press(key);
    await compare(`tool ${key}`);
  }
});
