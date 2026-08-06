import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeSettings, expect, openSettingsTab, resetSharedState, seedCheckedTopic, test, topicAction, workerBaseURL } from './fixtures.js';

// Backup, restore, and clearing stories — Settings → Data's destructive half
// (NEWS-322 split this out of app.spec.ts).
//
// Distinct from `backup-prompt.spec.ts`, which is about the *offer* that appears
// on a third topic. This is about the buttons.

test.describe.configure({ mode: 'serial' });

// Every attempt starts from a known server, including a serial retry — see
// `resetSharedState` (NEWS-101) and `seedCheckedTopic` (NEWS-322). No file
// inherits its precondition from another's leftovers (NEWS-313).
test.beforeAll(async () => {
  const baseURL = workerBaseURL();
  await resetSharedState(baseURL);
  await seedCheckedTopic(baseURL, 'Backup Topic');
});

test('backs up to a chosen folder, without the API keys (NEWS-192)', async ({ page }) => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-backup-e2e-'));
  await page.goto('/');
  await openSettingsTab(page, 'Data');

  // The button is unavailable until a folder is named — backing up to nowhere
  // is not a thing the UI should let you ask for.
  await expect(page.locator('[data-action=backup-now]')).toBeDisabled();

  await page.fill('[data-action=backup-dir]', dest);
  await page.locator('[data-action=backup-dir]').blur();
  await expect(page.locator('[data-action=backup-now]')).toBeEnabled();

  await page.locator('[data-action=backup-now]').click();
  await expect(page.locator('.toast')).toContainText('Backed up to');

  const at = path.join(dest, 'newsmonger-backup.json');
  expect(fs.existsSync(at)).toBe(true);
  const backup = JSON.parse(fs.readFileSync(at, 'utf8')) as {
    topics: unknown[];
    settings: Record<string, unknown>;
  };
  // Config is in there (the folder we just set is itself part of it)...
  expect(backup.settings['backupDir']).toBe(dest);
  expect(Array.isArray(backup.topics)).toBe(true);
  // ...and nothing key-shaped is, which is the promise the settings copy makes.
  expect(fs.readFileSync(at, 'utf8')).not.toMatch(/"(apiKey|api_key|secret|token)"/i);

  // Turn it back off so later tests (and reruns) start from the default.
  await page.fill('[data-action=backup-dir]', '');
  await page.locator('[data-action=backup-dir]').blur();
  await expect(page.locator('[data-action=backup-now]')).toBeDisabled();

  await page.locator('.dialog [data-action=close-settings]').click();
  fs.rmSync(dest, { recursive: true, force: true });
});

test('clear all stories, keeping topics and settings (NEWS-255)', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'Clear Probe');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Clear Probe' });
  await expect(row).toBeVisible();
  // Adding checks it (NEWS-54); wait for the mock's stories to land.
  await expect(page.locator('.item').first()).toBeVisible({ timeout: 15_000 });

  await openSettingsTab(page, 'Data');

  // Where it lives and what it looks like, before what it does (NEWS-304).
  //
  // It used to sit inside the Backup group, between two paragraphs about backup,
  // styled `class="btn"` — identical to `Back up now` directly above it. Both
  // halves are asserted here because either one alone leaves the bug: a correctly
  // sectioned button that looks benign is still stumbled into, and a red button
  // filed under BACKUP is still unfindable.
  const clear = page.locator('[data-action=clear-stories]');
  // The heading immediately above it is its own, not Backup's or Feed's…
  await expect(page.locator('.clear-row').locator('xpath=preceding-sibling::h3[1]')).toHaveText('Reset');
  // …and it is the last group on the tab, which is where a destructive action
  // belongs and, more to the point, is not somewhere a reader passes through.
  await expect(page.locator('.dialog h3.eyebrow').last()).toHaveText('Reset');
  // Marked, and distinct from the neutral button it used to be a twin of.
  // Computed colour rather than class name, for the NEWS-266 reason: the class
  // `danger` was on the restore control for a release *without the stylesheet
  // ever defining `.btn.danger`*, so asserting the class proves nothing.
  const inks = await page.evaluate(() => {
    const read = (sel: string): string => {
      const el = document.querySelector(sel);
      if (el === null) throw new Error(`${sel} not rendered`);
      return getComputedStyle(el).color;
    };
    return { clear: read('[data-action=clear-stories]'), backup: read('[data-action=backup-now]') };
  });
  expect(inks.clear, 'the destructive button must not share the neutral ink').not.toBe(inks.backup);

  await clear.click();
  // Names what survives, because the fear this dialog answers is "am I about to
  // lose my topics too".
  const confirmDialog = page.locator('.dialog.confirm');
  await expect(confirmDialog).toContainText('topics, settings and API keys are not touched');
  await page.locator('[data-action=confirm-ok]').click();

  await expect(page.locator('.toast')).toContainText('Cleared', { timeout: 15_000 });
  await page.locator('.dialog [data-action=close-settings]').click();
  await expect(page.locator('.dialog')).toHaveCount(0);

  // Stories gone, topic still there — the whole point of the narrowing.
  await expect(page.locator('.item')).toHaveCount(0);
  const cleared = page.locator('.topic', { hasText: 'Clear Probe' });
  await expect(cleared).toBeVisible();

  // And the row must read as a topic we have never checked (NEWS-273/NEWS-291).
  //
  // The first attempt at this qualified the sentence instead — "checked just now
  // · no stories" — and that was rejected: a clear resets the topic, so the row
  // should say what a brand-new topic's row says. `lastCheckedAt` really is null
  // now, and `clearedAt` is what keeps the scheduler from treating that as due.
  await expect(cleared.locator('.topic-meta')).toHaveText('not checked yet');
  // Belt and braces on the exact phrasing the owner objected to: no "checked 5m
  // ago" anywhere on the row. ("not checked yet" contains the word "checked", so
  // this has to match the relative-time shape rather than the bare word.)
  await expect(cleared.locator('.topic-meta')).not.toContainText(/checked\s+\S+\s+ago/);

  await topicAction(page, cleared, 'delete');
});

test('after a clear no topic says "checked N ago", and none starts checking itself (NEWS-273)', async ({ page }) => {
  // The owner's complaint was "labels like 'checked N minutes ago' **per item**",
  // so this sweeps every row rather than the one row a single-topic test would
  // create — a fix that only reached the selected topic would pass that and fail
  // this.
  await page.goto('/');
  for (const name of ['Reset One', 'Reset Two']) {
    await page.fill('.add-topic input', name);
    await page.press('.add-topic input', 'Enter');
    await expect(page.locator('.topic', { hasText: name })).toBeVisible();
  }
  // Adding checks a topic immediately (NEWS-54), so wait until both rows really
  // do claim a check — otherwise the assertions below could pass on timing.
  //
  // **`just now` counts as claiming a check**, and leaving it out is how this
  // test came to depend on a bug. It used to require `checked <N> ago`, which a
  // topic checked seconds ago never says — `relativeTime` returns "just now"
  // under a minute — so the precondition was unreachable inside its 15s window
  // with a real clock. It passed anyway because `page.clock.install()` is
  // *context*-scoped and two tests above fast-forward 10 hours between them,
  // which leaked into every later test and aged these rows artificially. The
  // fixture now restores the clock, so the assertion has to say what it means.
  const CLAIMS_A_CHECK = /checked\s+(just now|.+\s+ago)/;
  const rows = page.locator('.topic');
  for (const name of ['Reset One', 'Reset Two']) {
    await expect(page.locator('.topic', { hasText: name }).locator('.topic-meta')).toContainText(CLAIMS_A_CHECK, {
      timeout: 15_000,
    });
  }

  await openSettingsTab(page, 'Data');
  await page.locator('[data-action=clear-stories]').click();
  await page.locator('[data-action=confirm-ok]').click();
  await expect(page.locator('.toast')).toContainText('Cleared', { timeout: 15_000 });
  await page.locator('.dialog [data-action=close-settings]').click();
  await expect(page.locator('.dialog')).toHaveCount(0);

  // Not one row anywhere may still claim a check.
  //
  // The same pattern, which makes this *stricter* than it was: a row reading
  // "checked just now" after a clear is as wrong as one reading "checked 1d
  // ago", and the old pattern let the first through. "not checked yet" — what a
  // reset row must say — matches neither.
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < count; i++) {
    await expect(rows.nth(i).locator('.topic-meta')).not.toContainText(CLAIMS_A_CHECK);
  }

  // The dial is the other surface that speaks about checking, and it must not
  // read "Waiting for first check" — a check *is* coming, one interval after the
  // clear. This is also the user-visible proxy for the scheduling half: the
  // tooltip naming a wait is what a `clearedAt` baseline produces, where nulling
  // `lastCheckedAt` on its own would leave the topic due immediately.
  const dial = page.locator('.topic', { hasText: 'Reset One' }).locator('.dial');
  await expect(dial).toHaveAttribute('title', /^Next check in /);

  // …and nothing may start checking on its own afterwards. Note the scheduler's
  // tick is pinned to 24h for the E2E run (`playwright.config.ts`), so this is
  // not a test of the minute tick — the unit suite owns that, where a clear
  // followed by `checkDue` must check nothing. What this does catch is the class
  // of bug that repopulates the feed without the scheduler: a queued reissue, a
  // cancelled check's results landing late, or the client re-firing a check.
  await page.waitForTimeout(3_000);
  await expect(page.locator('.item')).toHaveCount(0);
  await expect(page.locator('.dial.checking')).toHaveCount(0);
  await expect(page.locator('.topic-meta', { hasText: /checked\s+\S+\s+ago/ })).toHaveCount(0);

  for (const name of ['Reset One', 'Reset Two']) {
    await topicAction(page, page.locator('.topic', { hasText: name }), 'delete');
  }
});

test('back up, then restore from that folder without moving files (NEWS-252)', async ({ page }) => {
  // The workflow this replaces was: find the backup file, rename it to
  // `data.json`, put it in a data directory you have never seen, and only if
  // you have not opened the app yet. The user's verdict was "we shouldn't have
  // to move data around", and they were right — so this drives the whole thing
  // through the UI, which is the only way to know the workflow exists.
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-restore-e2e-'));
  await page.goto('/');

  // A topic worth losing, so "did it restore" has a visible answer.
  await page.fill('.add-topic input', 'Restore Probe empty');
  await page.press('.add-topic input', 'Enter');
  await expect(page.locator('.topic', { hasText: 'Restore Probe' })).toBeVisible();

  await openSettingsTab(page, 'Data');
  // Nothing to restore from a folder that has no backup: the control is absent
  // rather than present-and-disabled, which would raise a question it can't
  // answer.
  await expect(page.locator('[data-action=restore-backup]')).toHaveCount(0);

  await page.fill('[data-action=backup-dir]', dest);
  await page.locator('[data-action=backup-dir]').blur();
  await page.locator('[data-action=backup-now]').click();
  await expect(page.locator('.toast')).toContainText('Backed up to');

  // The folder now has a backup, so the restore path appears in place — no
  // reopening the dialog — and says what is in it, which is what makes the
  // confirmation a decision rather than a leap.
  const found = page.locator('.restore-found');
  await expect(found).toContainText('Backup found', { timeout: 15_000 });
  await expect(found).toContainText('topic');

  // Now diverge from the snapshot, so a successful restore is provable rather
  // than merely plausible.
  await page.locator('.dialog [data-action=close-settings]').click();
  await page.fill('.add-topic input', 'Added After Backup empty');
  await page.press('.add-topic input', 'Enter');
  await expect(page.locator('.topic', { hasText: 'Added After Backup' })).toBeVisible();

  await openSettingsTab(page, 'Data');
  await page.locator('[data-action=restore-backup]').click();
  // Destructive, so it confirms — and the message names what replaces what.
  await expect(page.locator('.dialog.confirm')).toContainText('Replace everything');
  await page.locator('[data-action=confirm-ok]').click();

  await expect(page.locator('.toast')).toContainText('Restored', { timeout: 15_000 });
  // The snapshot's topic is back and the later one is gone — a restore, not a
  // merge.
  await expect(page.locator('.topic', { hasText: 'Restore Probe' })).toBeVisible();
  await expect(page.locator('.topic', { hasText: 'Added After Backup' })).toHaveCount(0);

  // Clean up. Backups off first, while the dialog is already open — the topic
  // delete needs the settings backdrop gone or it swallows the right-click.
  await page.fill('[data-action=backup-dir]', '');
  await page.locator('[data-action=backup-dir]').blur();
  await page.locator('.dialog [data-action=close-settings]').click();
  await expect(page.locator('.dialog')).toHaveCount(0);
  await topicAction(page, page.locator('.topic', { hasText: 'Restore Probe' }), 'delete');
  fs.rmSync(dest, { recursive: true, force: true });
});

test('the restore button fills the box it sits in (NEWS-332)', async ({ page }) => {
  // The only control on its line, and it was sized to its label — a short button
  // floating at the left of a bordered panel, which reads as unfinished rather
  // than as restrained. `Back up now` above it (FR-27.13) and the import/export
  // pairs (FR-3.72) both fill their rows; this now matches them.
  await page.goto('/');

  // The restore block only exists once a backup does, so make one.
  const dir = test.info().outputPath('restore-width-backup');
  fs.mkdirSync(dir, { recursive: true });
  await page.request.patch('/api/settings', { data: { backupDir: dir } });
  await page.request.post('/api/backup');

  await openSettingsTab(page, 'Data');
  const button = page.locator('[data-action=restore-backup]');
  await expect(button).toBeVisible({ timeout: 15_000 });

  const m = await page.evaluate(() => {
    const btn = document.querySelector('[data-action=restore-backup]');
    const row = btn?.closest('.restore-row');
    if (!(btn instanceof HTMLElement) || !(row instanceof HTMLElement)) return null;
    const cs = getComputedStyle(row);
    // `clientWidth` excludes the border and includes the padding, so taking the
    // padding off it is the row's content width — what a 100%-wide child fills.
    const content = row.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight);
    return { buttonWidth: btn.getBoundingClientRect().width, content };
  });
  expect(m, 'the restore row must be present').not.toBeNull();
  if (m === null) return;

  expect(m.content, 'the row must have a width to fill').toBeGreaterThan(100);
  expect(m.buttonWidth).toBeCloseTo(m.content, 0);

  // Put the setting back so the next spec on this worker starts clean.
  await page.request.patch('/api/settings', { data: { backupDir: '' } });
  await closeSettings(page);
});
