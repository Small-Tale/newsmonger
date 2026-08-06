import { closeSettings, expect, openSettings, openSettingsTab, resetSharedState,seedCheckedTopic, test, workerBaseURL } from './fixtures.js';

// Settings as a *document*: tabs, group headings, field alignment, hints, the
// dialogs it opens, and what it does not talk about (NEWS-322 split this out of
// app.spec.ts).
//
// Almost all geometry. Seeds a checked topic because the Data tab describes a
// server that has actually run a check.

test.describe.configure({ mode: 'serial' });

// Every attempt starts from a known server, including a serial retry — see
// `resetSharedState` (NEWS-101) and `seedCheckedTopic` (NEWS-322). No file
// inherits its precondition from another's leftovers (NEWS-313).
test.beforeAll(async () => {
  const baseURL = workerBaseURL();
  await resetSharedState(baseURL);
  await seedCheckedTopic(baseURL, 'Settings Layout Topic');
});

test('settings offers nothing about money (NEWS-119)', async ({ page }) => {
  // Spend, the monthly budget and the price-manifest field are gone. Asserting
  // their absence is what stops one drifting back in unnoticed — the removal is
  // the requirement, so it needs a test like any other.
  await page.goto('/');
  await openSettings(page);

  await expect(page.locator('.spend')).toHaveCount(0);
  await expect(page.locator('[data-action=budget]')).toHaveCount(0);
  await expect(page.locator('[data-action=price-manifest]')).toHaveCount(0);
  await expect(page.locator('.dialog')).not.toContainText('Spending');
  await expect(page.locator('.dialog')).not.toContainText('budget');

  await closeSettings(page);
});

test('the first-run guide walks through setup and is re-openable (NEWS-78)', async ({ page }) => {
  // By this point the suite has topics and a working (mock) provider, so the
  // guide must NOT auto-open — that is the assertion protecting every existing
  // user from a wizard on every reload.
  await page.goto('/');
  await expect(page.locator('.dialog.onboarding')).toHaveCount(0);

  // Settings reopens it on demand.
  await openSettingsTab(page, 'App');
  await page.locator('[data-action=rerun-onboarding]').click();
  const wizard = page.locator('.dialog.onboarding');
  await expect(wizard).toBeVisible();
  await expect(page.locator('.dialog:not(.onboarding)')).toHaveCount(0);

  // Welcome → source → topics.
  await expect(wizard.locator('h2')).toHaveText('Newsmonger watches topics, not feeds.');
  await wizard.locator('[data-action=onboarding-next]').click();
  await expect(wizard.locator('h2')).toHaveText('Where should the news come from?');
  await wizard.locator('[data-action=onboarding-next]').click();
  await expect(wizard.locator('h2')).toHaveText('What should Newsmonger watch?');

  // Starter topics toggle, and the count reflects it.
  const first = wizard.locator('.chip.starter').first();
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(wizard.locator('.note')).toContainText('1 chosen');
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'false');

  // Schedule is the last step; skipping there closes without creating anything.
  await wizard.locator('[data-action=onboarding-next]').click();
  await expect(wizard.locator('h2')).toHaveText('How often should it check?');
  const before = await page.locator('.topic').count();
  await wizard.locator('[data-action=onboarding-skip]').click();
  await expect(wizard).toHaveCount(0);
  await expect(page.locator('.topic')).toHaveCount(before);
});

test('the privacy note discloses what leaves the machine (NEWS-91)', async ({ page }) => {
  // Moved out of Settings into its own footer-linked dialog (NEWS-121). The
  // claims it has to make are unchanged; only where you find it moved.
  await page.goto('/');
  await page.locator('[data-action=open-privacy]').click();
  const privacy = page.locator('.privacy');
  await expect(privacy).toBeVisible();
  // The three claims the note has to make, each load-bearing: what is sent,
  // what is stored locally, and that keys are not in the data file.
  await expect(privacy).toContainText('Sent on every check');
  await expect(privacy).toContainText('~/.newsmonger');
  await expect(privacy).toContainText('API keys are not stored there');
  await expect(privacy).toContainText('no telemetry');
  await page.keyboard.press('Escape');
});

test('settings is organised into tabs (NEWS-118)', async ({ page }) => {
  await page.goto('/');
  // Plain open, not `openSettingsTab`: this test is about the default tab.
  await openSettings(page);

  const tabs = page.locator('.settings-tab');
  await expect(tabs).toHaveText(['Schedule', 'Source', 'Data', 'App']);
  // Only one tab is in the tab order — the rest are reached with arrow keys,
  // which is what the ARIA tabs pattern requires and what makes it usable
  // without a mouse.
  await expect(page.locator('.settings-tab[tabindex="0"]')).toHaveCount(1);

  // Each tab shows its own controls and hides the others': the point of tabs is
  // that the panel actually changes, not that a strip appears above one column.
  // `schedule-mode`, not `interval`: the interval select is swapped for a list
  // of times in daily mode, and an earlier test may have left it there.
  await expect(page.locator('[data-action=schedule-mode]')).toBeVisible();
  await expect(page.locator('[data-action=provider]')).toHaveCount(0);

  await tabs.filter({ hasText: 'Source' }).click();
  await expect(page.locator('[data-action=provider]')).toBeVisible();
  await expect(page.locator('[data-action=schedule-mode]')).toHaveCount(0);

  await tabs.filter({ hasText: 'Data' }).click();
  await expect(page.locator('[data-action=retention]')).toBeVisible();

  // Arrow keys move selection, wrapping at the end.
  await page.locator('.settings-tab.active').press('ArrowRight');
  await expect(page.locator('.settings-tab.active')).toHaveText('App');
  await page.locator('.settings-tab.active').press('ArrowRight');
  await expect(page.locator('.settings-tab.active')).toHaveText('Schedule');

  await closeSettings(page);
  // Reopening starts from the first tab rather than wherever you left off.
  await openSettings(page);
  await expect(page.locator('.settings-tab.active')).toHaveText('Schedule');
  await closeSettings(page);
});

test('no settings tab opens with an unnamed group (NEWS-307)', async ({ page }) => {
  // Three tabs used to open with an anonymous cluster of controls and only
  // *start* labelling at the second group — saying "the first group is not a
  // group" about a group, and leaving the controls most people touch as the one
  // region of the dialog with no landmark. Schedule had no eyebrows at all, so
  // it was internally consistent and externally the odd one out.
  //
  // Asserted per tab rather than by counting headings: the defect is positional
  // — a heading exists, it is just not the *first* thing — so a count would have
  // passed on all four tabs while three of them opened anonymously.
  await page.goto('/');

  for (const tab of ['Schedule', 'Source', 'Data', 'App'] as const) {
    await openSettingsTab(page, tab);
    const first = await page.evaluate(() => {
      const panel = document.querySelector('#settings-panel > div');
      const el = panel?.firstElementChild;
      return el === null || el === undefined ? null : { tag: el.tagName, cls: el.className };
    });
    expect(first, `${tab}: panel renders`).not.toBeNull();
    expect(first?.tag, `${tab} must open with a section heading`).toBe('H3');
    expect(first?.cls, `${tab}'s heading is the mono eyebrow the other groups use`).toContain('eyebrow');

    // The first heading carries no rule above it; every later one does. The rule
    // separates groups, and there is nothing above the first to separate it from
    // — a border there sits a few pixels under the tab bar's own and reads as a
    // doubled line. Same correction as NEWS-154/183 made to the sidebar and day
    // headings.
    const borders = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('#settings-panel > div > h3.eyebrow')];
      return heads.map((h) => getComputedStyle(h).borderTopWidth);
    });
    expect(borders.length, `${tab} has at least two groups`).toBeGreaterThan(1);
    expect(borders[0], `${tab}: no rule above the first group`).toBe('0px');
    expect(borders[1], `${tab}: a rule above every later group`).not.toBe('0px');

    // Closed each time round: `openSettingsTab` presses the gear, and with the
    // dialog already open that press waits on a backdrop that never clears.
    await page.locator('.dialog [data-action=close-settings]').click();
  }
});

test('privacy is its own dialog, opened from the footer (NEWS-121)', async ({ page }) => {
  await page.goto('/');

  // Not in settings any more — nothing on it is settable.
  await openSettings(page);
  await expect(page.locator('.dialog')).not.toContainText('no servers');
  await closeSettings(page);

  await page.locator('[data-action=open-privacy]').click();
  const dialog = page.locator('.dialog.privacy-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Sent on every check');
  await expect(dialog).toContainText('no servers');

  // Escape closes it, like every other dialog.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // ...and so does the backdrop, but not a click inside the dialog itself.
  await page.locator('[data-action=open-privacy]').click();
  await expect(dialog).toBeVisible();
  await dialog.locator('h2').click();
  await expect(dialog).toBeVisible();
  await page.locator('[data-action=privacy-backdrop]').click({ position: { x: 5, y: 5 } });
  await expect(dialog).toHaveCount(0);
});

test('the high-priority label fits on one line (NEWS-117)', async ({ page }) => {
  // It read "High-priority topics every" and wrapped, restating the column it
  // sits in. Measured rather than eyeballed, with the usual guard against a
  // zero-height box passing vacuously.
  await page.goto('/');
  await openSettings(page);

  const label = page.locator('.field', { hasText: 'High-priority' }).locator('.field-label').first();
  const box = await label.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    lineHeight: parseFloat(getComputedStyle(el).lineHeight),
  }));
  expect(box.height, 'the label should have been measured, not mid-render').toBeGreaterThan(5);
  expect(box.height, 'the label should be a single line').toBeLessThan(box.lineHeight * 1.6);
  await expect(label).not.toContainText('topics every');

  await closeSettings(page);
});

// --- Settings field layout (NEWS-147, NEWS-148) ----------------------------

test('every settings field lines its label up with its control (NEWS-147)', async ({ page }) => {
  // The label used a hand-tuned `padding-top` to fake alignment against the
  // control's text. That number was correct for exactly one combination of font,
  // size and control height, and drifted the moment any of them moved. The row
  // now aligns on the text baseline, which is the property actually wanted.
  await page.goto('/');

  for (const tab of ['Schedule', 'Source', 'Data'] as const) {
    await openSettingsTab(page, tab);

    // `.field:not(.stacked)` — a stacked field puts its label *above* the
    // control on purpose (FR-27.13, NEWS-331), so "line the two up
    // horizontally" is not a property it has. Excluded by name rather than by
    // loosening the threshold: the rule below is exactly as strict as it was,
    // and the stacked ones get their own assertions underneath.
    const rows = await page.locator('.dialog .field:not(.stacked)').evaluateAll((els) =>
      els
        .map((el) => {
          const label = el.firstElementChild;
          const control = el.querySelector('select, input');
          if (!(label instanceof HTMLElement) || !(control instanceof HTMLElement)) return null;
          const range = document.createRange();
          range.selectNodeContents(label);
          const text = range.getBoundingClientRect();
          const box = control.getBoundingClientRect();
          return {
            label: label.textContent.trim(),
            alignItems: getComputedStyle(el).alignItems,
            offset: Math.abs(text.top + text.height / 2 - (box.top + box.height / 2)),
          };
        })
        .filter((row) => row !== null),
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // The declaration, because the *point* is that alignment no longer depends
      // on a number someone tuned by eye — reintroducing that fails here even on
      // a machine where the numbers happen to look right.
      expect(row.alignItems, `${tab} / ${row.label} alignment mode`).toBe('baseline');
      // And the outcome, which catches gross drift whatever the cause.
      expect(row.offset, `${tab} / ${row.label} label vs control`).toBeLessThan(3);
    }

    // A stacked field has the other alignment property: its label sits fully
    // above the control and their left edges agree. Untested, "stacked" would be
    // a way to opt out of alignment altogether.
    const stacked = await page.locator('.dialog .field.stacked').evaluateAll((els) =>
      els
        .map((el) => {
          const label = el.firstElementChild;
          const control = el.querySelector('select, input');
          if (!(label instanceof HTMLElement) || !(control instanceof HTMLElement)) return null;
          const l = label.getBoundingClientRect();
          const c = control.getBoundingClientRect();
          return { label: label.textContent.trim(), clears: c.top - l.bottom, indent: Math.abs(c.left - l.left) };
        })
        .filter((row) => row !== null),
    );
    for (const row of stacked) {
      expect(row.clears, `${tab} / ${row.label} label must clear the control`).toBeGreaterThanOrEqual(0);
      expect(row.indent, `${tab} / ${row.label} label must start where the control does`).toBeLessThan(2);
    }

    await page.locator('.dialog [data-action=close-settings]').click();
  }
});

test('a field hint sits below its field, not on top of it (NEWS-148)', async ({ page }) => {
  await page.goto('/');
  await openSettingsTab(page, 'Schedule');

  const gap = await page.evaluate(() => {
    const hint = document.querySelector('.dialog .field-hint');
    if (!(hint instanceof HTMLElement)) return null;
    const field = hint.previousElementSibling;
    if (!(field instanceof HTMLElement)) return null;
    return hint.getBoundingClientRect().top - field.getBoundingClientRect().bottom;
  });

  // It had a *negative* top margin, which pulled it up into the control above —
  // the measured gap was -4px, so this is the assertion that would have failed.
  expect(gap).not.toBeNull();
  expect(gap ?? 0).toBeGreaterThanOrEqual(4);

  await page.locator('.dialog [data-action=close-settings]').click();
});

/**
 * Backups end to end (NEWS-192): choose a folder, click the button, and a real
 * file with the real content lands there.
 *
 * The destination is a folder this test names, not the server's data directory
 * — the server runs on this machine, so a temp path the test creates is one
 * both sides can see, and it needs no plumbing to share the pid-scoped dir.
 */
test('the Data tab is scannable, not a document with widgets in it (NEWS-306)', async ({ page }) => {
  // The tab was four controls and twenty lines of prose, at roughly three times
  // the density of its sibling tabs. Every control was followed by a 2–4 line
  // paragraph, so the eye could not move control to control.
  //
  // Measured against **Schedule**, not against a constant. Schedule has the same
  // number of controls with one short hint each and was the review's own proof
  // that this is fixable without deleting the explanations — so it is the right
  // yardstick, and it moves if the app's whole prose register ever does.
  await page.goto('/');

  const prose = async (tab: 'Schedule' | 'Data'): Promise<number> => {
    await openSettingsTab(page, tab);
    const height = await page.evaluate(() =>
      [...document.querySelectorAll('#settings-panel p.note, #settings-panel p.field-hint')]
        // A closed `<details>` contributes nothing to read — that is the point
        // of putting the longest paragraph behind one.
        .filter((p) => p.closest('details')?.hasAttribute('open') !== false)
        // The restore block appears only when a backup exists, and whether one
        // does depends on where in the suite this runs. Measuring it would make
        // the number depend on a neighbouring test rather than on this tab.
        .filter((p) => p.closest('.restore-slot') === null)
        .reduce((sum, p) => sum + p.getBoundingClientRect().height, 0),
    );
    await page.locator('.dialog [data-action=close-settings]').click();
    return height;
  };

  const schedule = await prose('Schedule');
  const data = await prose('Data');

  expect(schedule, 'Schedule must have some prose, or this compares nothing').toBeGreaterThan(0);
  // Measured: **3.73× before this change, 2.41× after** — so the review's "three
  // times the density of its sibling tabs" was very nearly exact, and the
  // ceiling below fails on the build that was reported.
  //
  // It is not lower because Data legitimately has five groups to Schedule's two,
  // and the largest paragraph left is the Feed section's — which **NEWS-309 §2**
  // is open against, to replace with a read-only field and a copy button.
  // Tightening it here would have collided with that ticket for a number.
  expect(data / schedule, 'Data vs Schedule prose height').toBeLessThan(2.8);

  // The trust statement is not what got demoted. It answers "what am I about to
  // sync to someone else's computer", and it keeps note weight while the
  // explanations around it drop to hints.
  await openSettingsTab(page, 'Data');
  const trust = page.locator('#settings-panel p.note', { hasText: 'API keys are never included' });
  await expect(trust).toBeVisible();
  await expect(trust.locator('strong')).toHaveCount(1);

  // The long explanation is still reachable — demoted, not deleted.
  const why = page.locator('details.why');
  await expect(why.locator('.note')).not.toBeVisible();
  await why.locator('summary').click();
  await expect(why.locator('.note')).toContainText('corrupt it');

  await closeSettings(page);
});

test('the settings dialog scrolls its panel, not itself (NEWS-309)', async ({ page }) => {
  // The design review reported DIAGNOSTICS below the fold with no scroll cue, on
  // the App tab. **Measured, that had moved**: App now ends at ~464px in a 900px
  // window (NEWS-306 thinned the prose, NEWS-307 reorganised it), while **Data
  // measures ~982px** — so the finding was real and had outlived the tab it
  // named. Asserted by geometry for that reason: the symptom migrates, the
  // property does not.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await openSettingsTab(page, 'Data');

  const m = await page.evaluate(() => {
    const dialog = document.querySelector('.dialog.settings-dialog');
    const panel = document.querySelector('#settings-panel');
    const tabs = document.querySelector('.settings-tabs');
    if (!dialog || !panel || !tabs) throw new Error('settings dialog not rendered as expected');
    return {
      dialogBottom: dialog.getBoundingClientRect().bottom,
      viewport: window.innerHeight,
      panelScrolls: panel.scrollHeight > panel.clientHeight,
      tabsTop: tabs.getBoundingClientRect().top,
    };
  });

  // The dialog fits the window — that is what makes the header and tabs stay put
  // instead of scrolling away with the content.
  expect(m.dialogBottom, 'the dialog must fit the viewport').toBeLessThanOrEqual(m.viewport);
  // …and the overflow went somewhere: the panel scrolls, which is also the
  // affordance the review said was missing.
  expect(m.panelScrolls, 'the panel takes the overflow').toBe(true);

  // Scrolling the panel must not move the tab strip.
  await page.locator('#settings-panel').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const tabsAfter = await page.locator('.settings-tabs').evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(tabsAfter - m.tabsTop), 'the tabs stay put while the panel scrolls').toBeLessThan(1);

  await closeSettings(page);
});

test('the feed URL is a field you can copy (NEWS-309)', async ({ page, context }) => {
  // It was a bare paragraph under a section heading — the one string the whole
  // group exists to hand over, to be drag-selected out of a sentence.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await openSettingsTab(page, 'Data');

  const field = page.locator('[data-action=feed-url]');
  await expect(field).toHaveValue(/\/feed\.xml$/);
  // Read-only, **not disabled**: a disabled input cannot be focused or selected,
  // which would take the URL away from exactly the keyboard and screen-reader
  // users this field exists to serve.
  await expect(field).toHaveAttribute('readonly', '');
  await expect(field).toBeEnabled();

  await page.locator('[data-action=copy-feed-url]').click();
  await expect(page.locator('.toast')).toContainText('Feed URL copied');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip, 'the clipboard holds what the field shows').toBe(await field.inputValue());

  await closeSettings(page);
});

test('the settings scrollbar rides the dialog edge, and a focus ring is not clipped (NEWS-326)', async ({ page }) => {
  // Two symptoms, one cause: the scrolling panel sat *inside* `.dialog`'s 24px
  // padding and carried no horizontal padding of its own.
  //
  // So its scrollbar floated ~28px in from the dialog's edge, reading as a
  // scrollbar for some inner box rather than for the dialog — and a focused
  // field's ring, drawn *outside* its own box by `outline-offset`, was sliced
  // off flush against the scroll container, which clips on both axes.
  //
  // Measured as geometry rather than asserted as a class, because both
  // complaints are about pixels: "inset too much" and "looks cut off" are not
  // properties any selector can carry.
  await page.goto('/');
  await openSettingsTab(page, 'Data');

  const edges = await page.evaluate(() => {
    const dialog = document.querySelector('.settings-dialog');
    const panel = document.querySelector('.settings-panel');
    if (!dialog || !panel) return null;
    const d = dialog.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    return {
      scrolls: panel.scrollHeight > panel.clientHeight,
      rightGap: d.right - p.right,
      leftGap: p.left - d.left,
    };
  });
  expect(edges, 'the settings dialog and its panel must both be present').not.toBeNull();
  if (edges === null) return;

  // The Data tab is the one that overflows (NEWS-309); if it stopped, this test
  // would be asserting nothing about a scrollbar.
  expect(edges.scrolls, 'the Data tab should overflow, or there is no scrollbar to place').toBe(true);
  // Flush to the dialog, give or take its 1px border.
  expect(edges.rightGap, 'the scroll container must reach the dialog edge').toBeLessThanOrEqual(2);
  expect(edges.leftGap, 'and be symmetric on the other side').toBeLessThanOrEqual(2);

  // The focus ring, on the field the report named.
  const feed = page.locator('.settings-panel input[readonly]').first();
  await expect(feed).toBeVisible();
  await feed.focus();
  const ring = await page.evaluate(() => {
    const panel = document.querySelector('.settings-panel');
    const el = document.activeElement;
    if (!panel || !(el instanceof HTMLElement)) return null;
    const cs = getComputedStyle(el);
    // How far the ring is drawn outside the element's own box.
    const extent = Number.parseFloat(cs.outlineWidth) + Number.parseFloat(cs.outlineOffset);
    const e = el.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    return { extent, slackLeft: e.left - extent - p.left, slackRight: p.right - (e.right + extent) };
  });
  expect(ring, 'a field must be focused for there to be a ring').not.toBeNull();
  if (ring === null) return;

  expect(ring.extent, 'the ring must actually be drawn outside the box, or this proves nothing').toBeGreaterThan(0);
  // Measured at -3px before the fix — the ring's left edge fell outside the
  // container's clip box by exactly its own extent.
  expect(ring.slackLeft, 'the focus ring is clipped on the left').toBeGreaterThanOrEqual(0);
  expect(ring.slackRight, 'the focus ring is clipped on the right').toBeGreaterThanOrEqual(0);

  await closeSettings(page);
});

test('import and export sit as equal halves, in matching rows (NEWS-327)', async ({ page }) => {
  // The Data tab grew an import beside each export and they drifted: different
  // button heights, no gap at all, and widths sized off their own labels so the
  // two pairs did not line up with each other. They are the same control twice
  // and now share one class, which is the thing this pins.
  await page.goto('/');
  await openSettingsTab(page, 'Data');

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.io-row')].map((row) => {
      const r = row.getBoundingClientRect();
      const btns = [...row.querySelectorAll('.btn')].map((b) => {
        const x = b.getBoundingClientRect();
        return { w: x.width, h: x.height, left: x.left, right: x.right };
      });
      return { width: r.width, left: r.left, right: r.right, btns };
    }),
  );

  expect(rows, 'both the Topics and the Stories pair').toHaveLength(2);
  const heights: number[] = [];
  for (const row of rows) {
    expect(row.btns, 'an export and an import').toHaveLength(2);
    const [first, second] = row.btns;

    // Equal halves. Sized off their labels they are not, and two ragged rows
    // read as two unrelated pairs rather than as the same control twice.
    expect(Math.abs(first.w - second.w), 'the two buttons must be the same width').toBeLessThanOrEqual(1);
    // Together they fill the row, less exactly one gap.
    const gap = second.left - first.right;
    expect(gap, 'a visible gap, not two buttons touching').toBeGreaterThanOrEqual(6);
    expect(first.w + second.w + gap, 'the pair should fill the row').toBeCloseTo(row.width, 0);
    // A `<button>` and a `<label>` only match if `.btn` states its line-height —
    // the UA gives `<button>` `normal` and lets the others inherit the body's.
    expect(Math.abs(first.h - second.h), 'export and import must be the same height').toBeLessThanOrEqual(1);
    heights.push(first.h);
  }
  // And the two rows match each other, not just themselves.
  expect(Math.abs(heights[0] - heights[1]), 'both rows must share a button height').toBeLessThanOrEqual(1);
  expect(Math.abs(rows[0].left - rows[1].left), 'and start at the same place').toBeLessThanOrEqual(1);

  // Topics above Stories: a topic is the thing you own, a story is what it
  // produced. And the group that moves stories in and out is now called what it
  // holds, rather than "Export" while carrying an import too.
  const headings = await page
    .locator('#settings-panel h3.eyebrow')
    .allTextContents()
    .then((all) => all.map((h) => h.trim()));
  expect(headings.slice(0, 3)).toEqual(['Retention', 'Topics', 'Stories']);
  expect(headings, 'nothing may still be called Export').not.toContain('Export');

  await closeSettings(page);
});

test('the backup folder gets its own line, and Back up now the one below (NEWS-331)', async ({ page }) => {
  // A backup path is long — `/Users/…/Mobile Documents/com~apple~CloudDocs/…` —
  // and `.field` puts the label *beside* the control, so the one value this
  // field exists to display had half a dialog to show itself in and was always
  // scrolled out of view.
  await page.goto('/');
  await openSettingsTab(page, 'Data');

  const m = await page.evaluate(() => {
    const input = document.querySelector('[data-action=backup-dir]');
    const btn = document.querySelector('[data-action=backup-now]');
    const field = input?.closest('.field');
    const label = field?.querySelector('span');
    if (!(input instanceof HTMLElement) || !(btn instanceof HTMLElement) || !(label instanceof HTMLElement)) return null;
    const r = (el: HTMLElement) => el.getBoundingClientRect();
    return {
      labelBottom: r(label).bottom,
      inputTop: r(input).top,
      inputLeft: r(input).left,
      inputWidth: r(input).width,
      inputBottom: r(input).bottom,
      btnTop: r(btn).top,
      btnLeft: r(btn).left,
      btnWidth: r(btn).width,
      rowWidth: field === null ? 0 : r(field as HTMLElement).width,
    };
  });
  expect(m, 'the backup controls must be present').not.toBeNull();
  if (m === null) return;

  // Stacked: the label sits entirely above the input rather than beside it.
  expect(m.inputTop, 'the label must be on its own line above the field').toBeGreaterThanOrEqual(m.labelBottom);
  // And the field takes the whole line, which is the point — it is what makes a
  // long path readable.
  expect(m.inputWidth).toBeCloseTo(m.rowWidth, 0);

  // The button below it, full width, with the same gap every other control on
  // this tab gets from the one above it.
  expect(m.btnTop, 'the button belongs on the line below the field').toBeGreaterThanOrEqual(m.inputBottom);
  expect(m.btnTop - m.inputBottom, 'usual spacing above the button').toBeGreaterThanOrEqual(10);
  expect(m.btnWidth).toBeCloseTo(m.rowWidth, 0);
  expect(m.btnLeft).toBeCloseTo(m.inputLeft, 0);

  await closeSettings(page);
});
