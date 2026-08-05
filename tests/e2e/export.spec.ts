import type { Page } from '@playwright/test';

import { closeSettings, expect, openSettingsTab, resetSharedState,seedCheckedTopic, test, topicAction } from './fixtures.js';

// Getting stories out: the export dialog, every scope × format combination, the
// single-topic export, and the HTTP surfaces the feed and exports are served on
// (NEWS-322 split this out of app.spec.ts).

test.describe.configure({ mode: 'serial' });

// Every attempt starts from a known server, including a serial retry — see
// `resetSharedState` (NEWS-101) and `seedCheckedTopic` (NEWS-322). No file
// inherits its precondition from another's leftovers (NEWS-313).
test.beforeAll(async () => {
  const baseURL = test.info().project.use.baseURL ?? '';
  await resetSharedState(baseURL);
  await seedCheckedTopic(baseURL, 'Export Topic');
});

test('the feed and exports are served over HTTP (NEWS-85)', async ({ page, request }) => {
  await page.goto('/');
  await openSettingsTab(page, 'Data');
  await expect(page.locator('.export-row')).toBeVisible();
  // Real hrefs, not blob URLs built in JS. That was originally justified here as
  // "so they work in the Tauri webview too" — which turned out to be false, and
  // is NEWS-157: `<a download>` is a no-op in the WKWebView. The href is still
  // right (it is what the system browser is handed), but the webview needs the
  // click handler too, not just a well-formed link.
  //
  // The link moved inside the export dialog in NEWS-158; the row now holds the
  // button that opens it.
  await page.locator('[data-action=open-export]').click();
  await expect(page.locator('.export-dialog a[data-export]')).toHaveAttribute('href', /export\.md/);
  await page.keyboard.press('Escape');
  await closeSettings(page);

  const feed = await request.get('/feed.xml');
  expect(feed.status()).toBe(200);
  expect(feed.headers()['content-type']).toContain('application/atom+xml');
  const xml = await feed.text();
  expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
  expect(xml).toContain('</feed>');

  const md = await request.get('/api/export.md?scope=all');
  expect(md.headers()['content-disposition']).toContain('attachment');
  expect(await md.text()).toContain('# All stories');
});

/** Open Settings → Data → Export stories. */
async function openExportDialog(page: Page): Promise<void> {
  await openSettingsTab(page, 'Data');
  await page.locator('[data-action=open-export]').click();
  await expect(page.locator('.dialog.export-dialog')).toBeVisible();
}

test('the export button is filled, and its icon says download (NEWS-161)', async ({ page }) => {
  await page.goto('/');
  await openSettingsTab(page, 'Data');
  const button = page.locator('.export-row .btn');
  await expect(button).toBeVisible();

  const m = await button.evaluate((el) => {
    const svg = el.querySelector('svg');
    const label = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim() !== '');
    if (!svg || !label) return null;
    const range = document.createRange();
    range.selectNode(label);
    const text = range.getBoundingClientRect();
    const glyph = svg.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      offset: Math.abs(glyph.top + glyph.height / 2 - (text.top + text.height / 2)),
      background: style.backgroundColor,
      // `download` is an arrow into a tray; `share-2` is three linked circles.
      // Asking what the glyph is *made of* survives a resize or a recolour, and
      // names the actual complaint: it was drawing the wrong action.
      circles: svg.querySelectorAll('circle').length,
      polylines: svg.querySelectorAll('polyline').length,
    };
  });
  expect(m).not.toBeNull();

  // The icon sits on the label's centre line, not on its baseline.
  expect(m?.offset ?? 99, 'icon vs label centre').toBeLessThan(1.5);

  // A download action, not a share action.
  expect(m?.circles, 'share-2 draws three circles; download draws none').toBe(0);
  expect(m?.polylines, 'the arrowhead').toBeGreaterThan(0);

  // Filled, not outlined — it is the only action on this tab and was reading as
  // an afterthought. Asserted as "not the plain button's panel fill" rather than
  // as a hex, so it holds in both themes.
  await expect(button).toHaveClass(/primary/);
  const panel = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--panel').trim());
  expect(m?.background).not.toBe(panel);

  await closeSettings(page);
});

test('an export link actually downloads in a browser (NEWS-157)', async ({ page }) => {
  // The link being well-formed was already asserted; that it *does* something
  // when clicked was not, which is how a dead button went unnoticed.
  await page.goto('/');
  await openExportDialog(page);

  const download = page.waitForEvent('download');
  await page.locator('.export-dialog a[data-export]').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.md$/);
  await closeSettings(page);
});

test('every scope and format combination can be exported (NEWS-158)', async ({ page }) => {
  // Three fixed buttons covered three of the four; "Saved only (.json)" simply
  // had no way to be asked for. The table below is the whole point of the
  // change, so it is walked rather than sampled.
  await page.goto('/');

  for (const scope of ['all', 'saved'] as const) {
    for (const format of ['md', 'json'] as const) {
      await openExportDialog(page);
      await page.locator(`[data-export-scope=${scope}]`).check();
      await page.locator(`[data-export-format=${format}]`).check();

      const link = page.locator('.export-dialog a[data-export]');
      await expect(link).toHaveAttribute('href', `/api/export.${format}?scope=${scope}`);

      const download = page.waitForEvent('download');
      await link.click();
      expect((await download).suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));

      // Exporting closes the dialog. (The close is deferred a tick so the
      // anchor outlives its own click handler; this asserts that it closes, not
      // the timing — Chromium tolerates either, see the handler's note.)
      await expect(page.locator('.dialog.export-dialog')).toHaveCount(0);
      await closeSettings(page);
    }
  }
});

test('a single topic can be exported (NEWS-160)', async ({ page }) => {
  // `scope=topic` has worked on all three endpoints since NEWS-85 and was
  // covered by unit tests, but nothing in the UI could ask for it.
  await page.goto('/');
  await page.fill('.add-topic input', 'Exportable Subject');
  await page.press('.add-topic input', 'Enter');
  await expect(page.locator('.topic', { hasText: 'Exportable Subject' })).toBeVisible();

  await openExportDialog(page);
  await page.locator('[data-export-scope=topic]').check();

  const picker = page.locator('[data-action=export-topic]');
  await expect(picker).toBeVisible();
  // Picking the scope lands on a topic rather than on nothing, so the option is
  // usable the moment it is chosen — asserted **before** touching the picker,
  // because that is where the two can disagree. A `<select>` with no `selected`
  // option shows its first one regardless, so the picker looks chosen while the
  // store still holds null and Export sits disabled beside it.
  await expect(picker).not.toHaveValue('');
  await expect(page.locator('.export-dialog a[data-export]')).toBeVisible();
  await expect(page.locator('.export-dialog button[disabled]')).toHaveCount(0);

  await picker.selectOption({ label: 'Exportable Subject' });
  const id = await picker.inputValue();
  await expect(page.locator('.export-dialog a[data-export]')).toHaveAttribute(
    'href',
    `/api/export.md?scope=topic&topic=${id}`,
  );

  // The filename is the server's slug of the topic name, so it doubles as proof
  // the right topic reached the route rather than a default.
  const download = page.waitForEvent('download');
  await page.locator('.export-dialog a[data-export]').click();
  expect((await download).suggestedFilename()).toBe('newsmonger-exportable-subject.md');

  await closeSettings(page);
  await topicAction(page, page.locator('.topic', { hasText: 'Exportable Subject' }), 'delete');
});

test('one-topic export is offered only when there are topics (NEWS-160)', async ({ page }) => {
  // With nothing to narrow to it could only ever produce an empty file, and an
  // enabled control that yields nothing is worse than a disabled one saying why.
  await resetSharedState(test.info().project.use.baseURL ?? '');
  await page.goto('/');
  await expect(page.locator('.topic')).toHaveCount(0);

  await openExportDialog(page);
  await expect(page.locator('[data-export-scope=topic]')).toBeDisabled();
  await expect(page.locator('.export-option:has([data-export-scope=topic])')).toContainText('No topics to export');
  // …and the Export control still works for the scopes that do apply.
  await expect(page.locator('.export-dialog a[data-export]')).toHaveAttribute('href', '/api/export.md?scope=all');

  await page.keyboard.press('Escape');
  await closeSettings(page);
});

test('the export dialog opens fresh and Escape leaves Settings standing (NEWS-158)', async ({ page }) => {
  await page.goto('/');
  await openExportDialog(page);

  await page.locator('[data-export-scope=saved]').check();
  await page.locator('[data-export-format=json]').check();
  await expect(page.locator('.export-dialog a[data-export]')).toHaveAttribute(
    'href',
    '/api/export.json?scope=saved',
  );

  // Escape closes the export dialog alone. Settings is underneath it, and
  // closing both would drop the user two levels for one keypress.
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog.export-dialog')).toHaveCount(0);
  await expect(page.locator('#settings-title')).toBeVisible();

  // Reopening starts over. A dialog that remembers the last choice exports
  // something different from what the last press did, for a reason nothing on
  // screen explains.
  await page.locator('[data-action=open-export]').click();
  await expect(page.locator('.export-dialog a[data-export]')).toHaveAttribute('href', '/api/export.md?scope=all');

  await page.keyboard.press('Escape');
  await closeSettings(page);
});

test('an export goes to the system browser inside Tauri (NEWS-157)', async ({ page }) => {
  // `openExternalUrl` keys off `window.__TAURI__`, so defining it is enough to
  // drive the desktop path in a normal browser — the same trick that makes the
  // WKWebView's no-op download testable at all, given no Tauri window here.
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>)['__TAURI__'] = {};
  });

  const opened: string[] = [];
  await page.route('**/api/open-external', async (route) => {
    const body = route.request().postDataJSON() as { url?: string };
    if (typeof body.url === 'string') opened.push(body.url);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.goto('/');
  await openSettingsTab(page, 'Data');
  await page.locator('[data-action=open-export]').click();
  await page.locator('.export-dialog a[data-export]').click();

  await expect.poll(() => opened.length).toBe(1);
  // Absolute, because `/api/open-external` parses what it is handed with
  // `new URL()` and rejects anything relative — reading `getAttribute('href')`
  // instead of the property would send "/api/export.md?scope=all" and 400.
  expect(opened[0]).toMatch(/^http:\/\/[^/]+\/api\/export\.md\?scope=all$/);

  await closeSettings(page);
});
