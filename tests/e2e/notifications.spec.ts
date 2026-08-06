import { expect, openSettingsTab, resetSharedState,seedCheckedTopic, test, topicAction, workerBaseURL } from './fixtures.js';

// Notifications and the banners beside them: the permission flow, the on-demand
// test notification, and dismissing an error or a repeated-failure warning
// (NEWS-322 split this out of app.spec.ts).
//
// One file because they are one subject from the reader's side — "how does the
// app tell me something went wrong, and how do I make it stop".

test.describe.configure({ mode: 'serial' });

// Every attempt starts from a known server, including a serial retry — see
// `resetSharedState` (NEWS-101) and `seedCheckedTopic` (NEWS-322). No file
// inherits its precondition from another's leftovers (NEWS-313).
test.beforeAll(async () => {
  const baseURL = workerBaseURL();
  await resetSharedState(baseURL);
  await seedCheckedTopic(baseURL, 'Notification Topic');
});

test('notification toggle persists when permission is granted (NEWS-38)', async ({ page, context }) => {
  await context.grantPermissions(['notifications']);
  await page.addInitScript(() => {
    class Rec {
      static permission = 'granted';
      static requestPermission = () => Promise.resolve('granted');
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = Rec;
  });
  await page.goto('/');
  await openSettingsTab(page, 'App');

  await page.check('[data-action=notify-toggle]');
  await expect(page.locator('[data-action=notify-toggle]')).toBeChecked();
  // Survives a reload — it's a real persisted setting.
  await page.reload();
  await openSettingsTab(page, 'App');
  await expect(page.locator('[data-action=notify-toggle]')).toBeChecked();
  await expect(page.locator('.notify-note .note')).toHaveCount(0);

  // Turn it back off so later tests see a clean app.
  await page.uncheck('[data-action=notify-toggle]');
  await expect(page.locator('[data-action=notify-toggle]')).not.toBeChecked();
});

test('a refused notification permission shows a note and leaves the toggle off (NEWS-38)', async ({ page }) => {
  await page.addInitScript(() => {
    class Rec {
      static permission = 'default';
      static requestPermission = () => Promise.resolve('denied');
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = Rec;
  });
  await page.goto('/');
  await openSettingsTab(page, 'App');

  await page.click('[data-action=notify-toggle]');
  await expect(page.locator('.notify-note .note')).toBeVisible();
  await expect(page.locator('[data-action=notify-toggle]')).not.toBeChecked();

  // The note has to say *where* to fix it, and in a browser that is the browser
  // (NEWS-40). The old wording — "your browser or system settings" — named both
  // and committed to neither, and cost a real search through macOS System
  // Settings for a "Newsmonger" entry that cannot exist there, because in a
  // browser the permission belongs to the browser.
  const note = page.locator('.notify-note .note');
  await expect(note).toContainText('browser');
  await expect(note).toContainText(new URL(page.url()).origin);
  await expect(note, 'must not send a browser user to macOS System Settings').toContainText(
    "won’t help",
  );

  // And nothing was persisted.
  const persisted = await page.evaluate(async () => {
    const r = await fetch('/api/state');
    return ((await r.json()) as { settings: { notifyOnNewItems: boolean } }).settings.notifyOnNewItems;
  });
  expect(persisted).toBe(false);
});

test('a test notification can be sent on demand, and says so (NEWS-260)', async ({ page, context }) => {
  // The button exists because the feature is otherwise unobservable: a real
  // notification needs a check to find new stories *while the window is
  // unfocused*, which a user cannot arrange on purpose. On macOS it is also the
  // only way to get the app listed in System Settings → Notifications, which
  // happens only once it has actually delivered one.
  await context.grantPermissions(['notifications']);
  await page.addInitScript(() => {
    class Rec {
      static permission = 'granted';
      static requestPermission = () => Promise.resolve('granted');
      static sent: string[] = [];
      constructor(title: string) {
        Rec.sent.push(title);
      }
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = Rec;
  });
  await page.goto('/');
  await openSettingsTab(page, 'App');

  // No result line before it is pressed — the slot is present but empty.
  await expect(page.locator('.test-notify-note .note')).toHaveCount(0);
  await page.click('[data-action=test-notification]');

  await expect(page.locator('.test-notify-note .note')).toContainText('Sent');
  const sent = await page.evaluate(
    () => (window as unknown as { Notification: { sent: string[] } }).Notification.sent,
  );
  expect(sent).toEqual(['Newsmonger test']);

  // It works with the toggle *off*: this asks "will the OS take one", which is a
  // different question from "do I want them on every new story".
  await expect(page.locator('[data-action=notify-toggle]')).not.toBeChecked();
});

test('a test notification reports refusal instead of claiming success (NEWS-260)', async ({ page }) => {
  await page.addInitScript(() => {
    class Rec {
      static permission = 'denied';
      static requestPermission = () => Promise.resolve('denied');
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = Rec;
  });
  await page.goto('/');
  await openSettingsTab(page, 'App');

  await page.click('[data-action=test-notification]');
  await expect(page.locator('.test-notify-note .note')).toContainText('Could not send');
});

test('the error banner can be dismissed (NEWS-41)', async ({ page }) => {
  await page.goto('/');
  // A duplicate topic raises the error banner.
  await page.fill('.add-topic input', 'Dismiss Error Probe');
  await page.press('.add-topic input', 'Enter');
  await expect(page.locator('.topic', { hasText: 'Dismiss Error Probe' })).toBeVisible();
  await page.fill('.add-topic input', 'Dismiss Error Probe');
  await page.press('.add-topic input', 'Enter');

  await expect(page.locator('.banner.error')).toBeVisible();
  await page.locator('.banner.error [data-action=dismiss-error]').click();
  await expect(page.locator('.banner.error')).toHaveCount(0);

  // Clean up the topic this test created (assert it's gone so a botched cleanup
  // can't leave residue for the count-sensitive earlier tests on a retry).
  await page.fill('.add-topic input', '');
  await topicAction(page, page.locator('.topic', { hasText: 'Dismiss Error Probe' }), 'delete');
  await expect(page.locator('.topic', { hasText: 'Dismiss Error Probe' })).toHaveCount(0);
});

test('the failure warning can be dismissed and stays dismissed, but a new failure reappears (NEWS-41)', async ({
  page,
}) => {
  // The mock provider throws for a topic whose name contains "fail".
  await page.goto('/');
  await page.fill('.add-topic input', 'fail banner probe');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'fail banner probe' });
  await expect(row).toBeVisible();

  // **No explicit check here** (NEWS-238). `POST /api/topics` already fires one
  // in the background — the user just added the topic and is watching for
  // results — so clicking Check now runs a *second* one. Two failing runs, and
  // the banner's dismiss button carries the run id that was rendered when it was
  // clicked: dismiss the first run's banner and the second run's banner replaces
  // it, which is correct behaviour and a failed assertion.
  //
  // It only shows under load, because on a fast machine the second run finishes
  // before the poll that first paints the banner, so the id being dismissed is
  // already the final one. That is the whole reason this read as flake for weeks.
  // Waiting for the automatic check is also closer to what a user actually does.
  await expect(page.locator('.banner.warn')).toBeVisible({ timeout: 15_000 });

  await page.locator('.banner.warn [data-action=dismiss-warn]').click();
  await expect(page.locator('.banner.warn')).toHaveCount(0);
  // Stays gone across poll cycles — the dismissal is remembered by run id.
  // Waits for the client's own polls to land rather than sleeping past them: a
  // fixed 4.5s sleep leaves 500ms of margin on a 4s poll, which is exactly the
  // budget a loaded machine eats (NEWS-101). Deliberately NOT triggering a
  // check to force the wait — a new check would be a new failure, which is the
  // one thing that legitimately brings this banner back.
  await page.waitForResponse((r) => r.url().includes('/api/state'), { timeout: 15_000 });
  await page.waitForResponse((r) => r.url().includes('/api/state'), { timeout: 15_000 });
  await expect(page.locator('.banner.warn')).toHaveCount(0);

  // A fresh failure is a new run id, so the banner comes back.
  await topicAction(page, row, 'check');
  await expect(page.locator('.banner.warn')).toBeVisible();

  // Clean up.
  await topicAction(page, row, 'delete');
  await expect(row).toHaveCount(0);
});

test('a dismissed failure warning stays dismissed after an app relaunch (NEWS-41)', async ({ page }) => {
  // The reopened bug: the warning is derived from server state that survives a
  // reload, and the dismissal used to live only in memory — so relaunching the
  // app resurrected a warning the user had already closed.
  await page.goto('/');
  await page.fill('.add-topic input', 'relaunch fail probe');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'relaunch fail probe' });
  await expect(row).toBeVisible();

  // **No explicit check here** (NEWS-238). `POST /api/topics` already fires one
  // in the background — the user just added the topic and is watching for
  // results — so clicking Check now runs a *second* one. Two failing runs, and
  // the banner's dismiss button carries the run id that was rendered when it was
  // clicked: dismiss the first run's banner and the second run's banner replaces
  // it, which is correct behaviour and a failed assertion.
  //
  // It only shows under load, because on a fast machine the second run finishes
  // before the poll that first paints the banner, so the id being dismissed is
  // already the final one. That is the whole reason this read as flake for weeks.
  // Waiting for the automatic check is also closer to what a user actually does.
  await expect(page.locator('.banner.warn')).toBeVisible({ timeout: 15_000 });
  await page.locator('.banner.warn [data-action=dismiss-warn]').click();
  await expect(page.locator('.banner.warn')).toHaveCount(0);

  // Relaunch = reload. The failed run is still in server state, but the
  // dismissal now persists, so the warning must not reappear.
  //
  // Wait for the poll to have actually happened rather than for the clock
  // (NEWS-228). This used to sleep 4500ms against a 4000ms poll — 500ms of
  // margin, which is fine on an idle laptop and not on a loaded CI runner; it
  // is what failed the suite on Linux while passing 3/3 in isolation. Counting
  // responses proves the same thing with no timing assumption: the second one
  // is the poll re-reading the still-failing server state.
  let statePolls = 0;
  page.on('response', (r) => {
    if (r.url().includes('/api/state')) statePolls += 1;
  });
  await page.reload();
  await expect(row).toBeVisible();
  await expect.poll(() => statePolls, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.banner.warn')).toHaveCount(0);

  // Clean up.
  await topicAction(page, row, 'delete');
  await expect(row).toHaveCount(0);
});
