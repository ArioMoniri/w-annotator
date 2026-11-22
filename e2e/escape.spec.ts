import { expect, test, type Page } from '@playwright/test';
import { drag, openPhantom } from './helpers';

/**
 * Esc belongs to whatever is on top: a menu, a popover, a dialog, a fill preview, a text field
 * or a drag. Only an Esc that none of them took restores a maximised view.
 */

const maximised = (page: Page) => page.locator('.views').getAttribute('data-layout');

async function openMaximised(page: Page, withMask = true): Promise<void> {
  await openPhantom(page, withMask);
  await page.locator('[data-view="axial"]').click({ position: { x: 60, y: 90 } });
  await page.keyboard.press('m');
  await expect(page.locator('.views')).toHaveAttribute('data-layout', 'single');
}

/** Esc pressed once and let go, as a person does. Says what is left on screen afterwards. */
async function escape(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
}

test('Esc closes a menu and leaves the maximised view as it is', async ({ page }) => {
  await openMaximised(page);
  const menus: { name: string; open: () => Promise<void>; shown: () => ReturnType<Page['locator']> }[] = [
    { name: 'window', open: () => page.getByTestId('status-window').click(), shown: () => page.getByRole('menu', { name: 'Window' }) },
    { name: 'zoom', open: () => page.getByTestId('status-zoom').click(), shown: () => page.getByRole('menu', { name: 'Zoom' }) },
    { name: 'view name', open: () => page.locator('[data-view="axial"] .viewlabel > button').click(), shown: () => page.getByRole('menu', { name: 'View in this pane' }) },
    { name: 'file', open: () => page.locator('.filebtn').click(), shown: () => page.getByRole('menuitem', { name: /^Open image/ }) },
    {
      name: 'segment',
      open: async () => {
        await page.locator('.segrow', { hasText: 'Segment 1' }).hover();
        await page.getByRole('button', { name: 'More for Segment 1' }).click();
      },
      shown: () => page.getByRole('menuitem', { name: 'Rename' }),
    },
    { name: 'segment colour', open: () => page.getByRole('button', { name: 'Colour of Segment 1' }).click(), shown: () => page.locator('.menu.palette') },
    {
      name: 'grow',
      open: async () => {
        await page.locator('.segrow', { hasText: 'Segment 1' }).hover();
        await page.getByRole('button', { name: 'More for Segment 1' }).click();
        await page.getByRole('menuitem', { name: /^Grow/ }).click();
      },
      shown: () => page.getByRole('dialog', { name: /^Grow/ }),
    },
  ];
  for (const menu of menus) {
    await menu.open();
    await expect(menu.shown(), menu.name).toBeVisible();
    await escape(page);
    await expect(menu.shown(), menu.name).toHaveCount(0);
    expect(await maximised(page), `Esc in the ${menu.name} menu`).toBe('single');
  }
  // With nothing open, Esc restores the layout.
  await escape(page);
  expect(await maximised(page)).toBe('grid');
});

test('Esc held down closes the menu and does no more', async ({ page }) => {
  await openMaximised(page);
  for (const id of ['status-window', 'status-zoom']) {
    await page.getByTestId(id).click();
    await expect(page.locator('.menu.statuspop')).toBeVisible();
    // A key held a moment too long repeats.
    await page.keyboard.down('Escape');
    await page.keyboard.down('Escape');
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    await expect(page.locator('.menu.statuspop')).toHaveCount(0);
    expect(await maximised(page), id).toBe('single');
  }
});

test('Esc cancels a fill preview, a rename and a drag before it restores a maximised view', async ({ page }) => {
  await openMaximised(page, false);
  await page.getByRole('button', { name: 'Add segment' }).first().click();
  await drag(page, 'axial', [-20, 0], [20, 0]);
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await drag(page, 'axial', [-20, 0], [20, 0]);
  await page.keyboard.press('i');
  await expect(page.locator('.strip [role="status"]')).toBeVisible();
  await escape(page);
  await expect(page.locator('.strip [role="status"]')).toHaveCount(0);
  expect(await maximised(page), 'fill preview').toBe('single');

  // A segment being renamed.
  await page.locator('.segrow .name').first().dblclick();
  await expect(page.getByRole('textbox', { name: 'Segment name' })).toBeFocused();
  await escape(page);
  await expect(page.getByRole('textbox', { name: 'Segment name' })).toHaveCount(0);
  expect(await maximised(page), 'rename').toBe('single');

  // A brush stroke under way: Esc is not a layout change in the middle of it.
  const box = (await page.locator('[data-view="axial"]').boundingBox())!;
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.keyboard.press('b');
  await page.mouse.move(cx - 30, cy + 60);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 60, { steps: 4 });
  await escape(page);
  expect(await maximised(page), 'brush stroke').toBe('single');
  await expect(page.locator('.strip')).toHaveAttribute('data-strip', 'brush');
  await page.mouse.move(cx + 30, cy + 60, { steps: 4 });
  await page.mouse.up();

  // Pan with the hand tool.
  await page.keyboard.press('h');
  await page.mouse.move(cx - 30, cy + 60);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 60, { steps: 4 });
  await escape(page);
  expect(await maximised(page), 'pan').toBe('single');
  await page.mouse.up();

  // A view name being dragged to another pane is not a thing in a maximised view; a scissors outline is.
  await page.keyboard.press('s');
  await page.mouse.move(cx - 30, cy - 60);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 40, { steps: 4 });
  await escape(page);
  await page.mouse.up();
  expect(await maximised(page), 'scissors').toBe('single');
});
