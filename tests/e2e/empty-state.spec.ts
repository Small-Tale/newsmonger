import { expect, resetSharedState, test, workerBaseURL } from './fixtures.js';

// The main-content empty state (NEWS-433).
//
// The feed panel used to render *nothing* when there was nothing to show — a
// bare dark void beside a sidebar that carried the only message. To someone who
// skipped setup it looked broken, with no way back in. These assert the panel is
// filled, and that the two things the ticket asked for are actually there and
// wired: the setup guide (otherwise reachable only through Settings) and a
// one-click start.
//
// The fixture seeds the onboarding-seen flag, so the first-run wizard does not
// auto-open over the state under test (NEWS-421). Each test resets to a known
// topic count of its own, so order does not matter.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetSharedState(workerBaseURL());
});

test('with no topics, the feed panel offers a way to start (NEWS-433)', async ({ page }) => {
  await resetSharedState(workerBaseURL());
  await page.goto('/');

  const empty = page.locator('#feed .feed-empty');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('Nothing to watch yet');
  // The setup guide, in the main content area rather than only in Settings.
  await expect(empty.locator('[data-action=rerun-onboarding]')).toBeVisible();
  // And popular topics as one-click adds — the "I skipped setup, now what?" path.
  await expect(empty.locator('[data-foryou-topic]')).not.toHaveCount(0);
});

test('the setup-guide button in the empty state reopens the wizard (NEWS-433)', async ({ page }) => {
  await resetSharedState(workerBaseURL());
  await page.goto('/');

  await page.locator('#feed .feed-empty [data-action=rerun-onboarding]').click();
  await expect(page.locator('.onboarding-backdrop')).toBeVisible();
});

test('a popular-topic chip adds a topic and clears the no-topics hero (NEWS-433)', async ({ page }) => {
  await resetSharedState(workerBaseURL());
  await page.goto('/');

  const chip = page.locator('#feed .feed-empty [data-foryou-topic]').first();
  const name = ((await chip.textContent()) ?? '').trim();
  await chip.click();

  await expect(page.locator('.topic', { hasText: name })).toHaveCount(1);
  // The no-topics hero is gone — replaced by stories or by the has-topics state,
  // depending on how fast the check runs, but never the "watch nothing" prompt.
  await expect(page.locator('#feed')).not.toContainText('Nothing to watch yet');
});

test('with topics but no stories, the panel reassures and keeps the guide in reach (NEWS-433)', async ({ page }) => {
  await resetSharedState(workerBaseURL());
  // The mock returns no items for a topic whose name contains "empty", so this
  // topic stays storyless however the check goes (see CLAUDE.md, the mock keys
  // off the topic name).
  await page.request.post('/api/topics', { data: { name: 'an empty subject' } });
  await page.goto('/');

  const empty = page.locator('#feed .feed-empty');
  await expect(empty).toContainText('No stories yet');
  await expect(empty.locator('[data-action=rerun-onboarding]')).toBeVisible();
  await expect(empty.locator('[data-action=check-all]')).toBeVisible();
});
