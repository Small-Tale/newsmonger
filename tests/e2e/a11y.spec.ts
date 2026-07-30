import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { expect, openSettingsTab, test, topicAction } from './fixtures.js';

// Accessibility regression net (NEWS-90). Runs axe against the real rendered
// app in both colour schemes, then checks the keyboard paths axe cannot see —
// axe finds missing labels and poor contrast, but it can't tell you that the
// only route to a topic's actions is a right-click.

test.describe.configure({ mode: 'serial' });

/** Serious/critical only: axe's "minor" bucket is mostly advisory. */
async function scan(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}


test('the main view has no serious accessibility violations (light)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
  expect(await scan(page)).toEqual([]);
});

test('...and none in dark mode either', async ({ page }) => {
  // Contrast is theme-specific, so a single-theme scan proves half the point.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
  expect(await scan(page)).toEqual([]);
});

test('the settings dialog has no serious violations, on any tab, in either theme (NEWS-159)', async ({ page }) => {
  // Was: one scan, light only, on whichever tab opens first. The main view has
  // been scanned in both schemes since NEWS-90 precisely because contrast is
  // theme-specific — the dialog just never got the same treatment, and it holds
  // most of the app's controls. Each tab is a different set of them, so a scan of
  // the first one says nothing about the other three.
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');
    await page.click('[data-action=open-settings]');
    await expect(page.locator('.dialog')).toBeVisible();

    for (const tab of ['Schedule', 'Source', 'Data', 'App'] as const) {
      await page.locator('.settings-tab', { hasText: tab }).click();
      await expect(page.locator('.settings-tab.active')).toHaveText(tab);
      expect(await scan(page), `${scheme} / ${tab}`).toEqual([]);
    }

    await page.locator('.dialog [data-action=close-settings]').click();
  }
  await page.emulateMedia({ colorScheme: 'light' });
});

test('the export dialog is labelled, grouped and keyboard-operable (NEWS-158)', async ({ page }) => {
  // Deliberately **not** an axe scan, and worth saying why: axe cannot read a
  // dialog opened over another dialog. Both backdrops are `position: fixed;
  // inset: 0` at the same z-index, so axe's overlap detection composites the
  // lower one *over* the upper dialog's opaque panel and invents colours —
  // measured, it reports `#b5b8b6` for a button sitting on `rgb(251,252,251)`,
  // and fails on contrast that is actually 14:1. The existing scans only ever
  // open one dialog, which is why this has not come up before.
  //
  // (One axe finding here was real and is fixed: `.export-option.on` has its own
  // opaque background, needing no ancestor walk, and its hint text measured
  // 4.43:1 against `--pine-soft` — just under AA.)
  //
  // So the checks axe would have made are made directly.
  await page.goto('/');
  await openSettingsTab(page, 'Data');
  await page.locator('[data-action=open-export]').click();
  const dialog = page.locator('.dialog.export-dialog');
  await expect(dialog).toBeVisible();

  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  // The label has to resolve to real text, not just point somewhere.
  await expect(page.locator(`#${String(await dialog.getAttribute('aria-labelledby'))}`)).toHaveText('Export stories');

  // Two groups with distinct names. Sharing one name is the classic version of
  // this bug: choosing a format would silently clear the scope.
  await expect(dialog.locator('input[name=export-scope]')).toHaveCount(3); // all / saved / one topic
  await expect(dialog.locator('input[name=export-format]')).toHaveCount(2); // markdown / json

  // Every radio sits inside a <label>, so its accessible name comes from the
  // text beside it rather than from nothing. Counted from the two groups above
  // rather than written as a total, so adding a scope updates one number.
  const radios = dialog.locator('input[type=radio]');
  const count = await radios.count();
  expect(count).toBe(5);
  for (let i = 0; i < count; i += 1) {
    await expect(radios.nth(i).locator('xpath=ancestor::label')).toHaveCount(1);
  }

  // …and each group is a fieldset with a legend naming the question.
  const legends = await dialog.locator('fieldset legend').allTextContents();
  expect(legends).toEqual(['What', 'Format']);

  // Operable without a mouse, end to end — and each group moves independently,
  // which is the observable consequence of them having distinct names.
  await dialog.locator('[data-export-scope=saved]').focus();
  await page.keyboard.press('Space');
  await expect(dialog.locator('a[data-export]')).toHaveAttribute('href', '/api/export.md?scope=saved');

  await dialog.locator('[data-export-format=json]').focus();
  await page.keyboard.press('Space');
  await expect(dialog.locator('a[data-export]')).toHaveAttribute('href', '/api/export.json?scope=saved');

  await page.keyboard.press('Escape');
  await page.locator('.dialog [data-action=close-settings]').click();
});

test('topic rows are reachable and operable from the keyboard (NEWS-90)', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'Keyboard Topic');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Keyboard Topic' });
  await expect(row).toBeVisible();

  // Focusable, and Enter selects — neither was true when the row was a plain
  // <li> with a click handler.
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(row).toHaveClass(/selected/);

  // Shift+F10 opens the same menu the right-click does, anchored to the row.
  await page.keyboard.press('Shift+F10');
  await expect(page.locator('.menu')).toBeVisible();
  await expect(page.locator('[data-menu-action=check]')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.menu')).toHaveCount(0);
});

test('Escape closes each dialog, innermost first (NEWS-90)', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('.topic', { hasText: 'Keyboard Topic' });
  await row.click({ button: 'right' });
  await page.locator('[data-menu-action=guidance]').click();
  await expect(page.locator('.dialog.guidance')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog.guidance')).toHaveCount(0);

  await page.click('[data-action=open-settings]');
  await expect(page.locator('.dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog')).toHaveCount(0);
});

test('Tab stays inside an open dialog (NEWS-90)', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-settings]');
  const dialog = page.locator('.dialog');
  await expect(dialog).toBeVisible();

  // Tab a generous number of times; focus must never escape the dialog. Without
  // the trap it walks out into the page behind within a handful of presses.
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
    expect(inside, `focus left the dialog after ${String(i + 1)} tabs`).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('clean up the topic this spec created', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('.topic', { hasText: 'Keyboard Topic' });
  if ((await row.count()) === 0) return;
  await row.click();
  await page.keyboard.press('Delete');
  await page.locator('[data-action=confirm-ok]').click();
  await expect(row).toHaveCount(0);
});

// --- The dial's track stays visible on a selected row (NEWS-153) ------------

/**
 * Composite the dial's track over its row and return the WCAG contrast ratio.
 *
 * The track is drawn with `stroke-opacity`, so its *computed* colour is not what
 * lands on screen — the whole point of the fix is that it blends with whatever
 * fill the row has. Compositing here is what makes the assertion about the ring
 * the user sees rather than about a CSS declaration.
 */
async function dialTrackContrast(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const track = document.querySelector('.topic .dial-track');
    const row = track?.closest('.topic');
    if (!track || !row) return null;
    const parts = (c: string): number[] => (/rgba?\(([^)]+)\)/.exec(c)?.[1] ?? '0,0,0').split(',').map(Number);
    const style = getComputedStyle(track);
    const opacity = Number.parseFloat(style.strokeOpacity);
    const ink = parts(style.stroke);
    let bg = parts(getComputedStyle(row).backgroundColor);
    // An unselected row is transparent; the page behind it is the real backdrop.
    if ((bg[3] ?? 1) === 0) bg = parts(getComputedStyle(document.body).backgroundColor);
    const composited = [0, 1, 2].map((i) => (ink[i] ?? 0) * opacity + (bg[i] ?? 0) * (1 - opacity));
    const luminance = (c: number[]): number => {
      const lin = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0);
    };
    const a = luminance(composited);
    const b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

test('the dial stays visible on a selected row, in both themes (NEWS-153)', async ({ page }) => {
  // `--line` is mixed for the *page* background, so the ring was faint
  // everywhere — 1.18:1 in light against the page — and on a selected or hovered
  // row, filled with `--pine-soft`, it all but vanished: 1.01:1 in light and
  // 1.02:1 in dark, i.e. invisible, and precisely when the user had singled that
  // topic out. Both states are asserted because both were wrong; the selected
  // one is only where it became impossible to miss.
  await page.goto('/');
  await page.fill('.add-topic input', 'Dial Contrast');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Dial Contrast' });
  await expect(row).toBeVisible();

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });

    await page.locator('.topics-head').click();
    const unselected = await dialTrackContrast(page);
    expect(unselected, `${scheme} unselected`).not.toBeNull();
    expect(unselected ?? 0, `${scheme} unselected`).toBeGreaterThan(1.4);

    await row.click();
    const selected = await dialTrackContrast(page);
    // Asserted separately from the unselected reading rather than as a single
    // worst-of, so a regression that only affects the filled row still names
    // itself instead of hiding behind the page-background case.
    expect(selected ?? 0, `${scheme} selected`).toBeGreaterThan(1.4);
  }

  await page.emulateMedia({ colorScheme: 'light' });
  await topicAction(page, row, 'delete');
});

test('the dial tooltip counts down in real time, not in percent (NEWS-202)', async ({ page }) => {
  // It used to read "3% of the interval left before the next check", which asked
  // the reader to do arithmetic from a number the tooltip never gave them — the
  // interval. The ring already shows the proportion; the tooltip's job is the
  // duration, which the ring cannot express.
  //
  // Driven through the real UI because the string is assembled in the component,
  // not in the pure helper the unit tests cover: `dial.ts` could be perfect while
  // `dialJsx` still stitched a percentage into the title.
  await page.goto('/');
  await page.fill('.add-topic input', 'Dial Countdown');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Dial Countdown' });
  await expect(row).toBeVisible();

  const dial = row.locator('.dial');

  // Not asserting the "Waiting for first check" state here: a newly added topic
  // is checked automatically (FR, NEWS-54), so that state is gone before the row
  // can be inspected — this test first asserted it and found the tooltip already
  // reading "Next check in 23h". The unit tests cover the null-countdown branch
  // directly, which is the reliable place for it.
  await expect(row).toContainText('checked', { timeout: 15_000 });

  const title = await dial.getAttribute('title');
  expect(title, 'tooltip after a check').toMatch(
    /^Next check (due now|in under a minute|in \d+[mhd])$/,
  );
  // The requirement change, asserted where it is user-visible rather than only in
  // the formatter.
  expect(title ?? '').not.toContain('%');

  // Pausing stops the interval, so the countdown must give way rather than keep
  // ticking toward a check that will never fire.
  await topicAction(page, row, 'pause');
  await expect(dial).toHaveAttribute('title', 'Paused');

  await topicAction(page, row, 'delete');
});
