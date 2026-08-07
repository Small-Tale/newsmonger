import type { Page } from '@playwright/test';

import { activeCategories, BUILTIN_CATEGORIES } from '../../src/categories.js';
import { acceptConfirm, expect, openSettingsTab, resetSharedState, test, topicAction, workerBaseURL } from './fixtures.js';

/**
 * The grid shows the whole taxonomy, so this follows the table rather than a
 * literal — widening it (NEWS-388 took it from 11 sections to 20) is a data
 * edit, and it should not also be a test edit.
 */
const SECTION_TILE_COUNT = activeCategories(BUILTIN_CATEGORIES).length;

// Topic discovery — both doors and the result list (NEWS-126, FR-24.1–24.4, 24.17).
//
// The mock provider names its suggestions after the request seed, which for a
// section request is the subcategory slug: browsing Sports ▸ Motorsport returns
// "motorsport topic 2", "motorsport topic 3", … Those names then classify back
// into Sports · Motorsport, so the grouping is exercised too.
//
// It also deliberately suggests the *first already-followed topic* whenever the
// exclusion list is non-empty (NEWS-124), which is what makes FR-24.11's
// second layer observable from the outside.

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetSharedState(workerBaseURL());
});

test('the discover dialog opens from beside the add-topic field', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.dialog.discover')).toHaveCount(0);

  await page.click('[data-action=open-discover]');
  await expect(page.locator('.dialog.discover h2')).toHaveText('Discover topics');
});

test('it opens on the section grid, showing the whole taxonomy', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');

  await expect(page.locator('.section-tile')).toHaveCount(SECTION_TILE_COUNT);
  await expect(page.locator('.section-tile', { hasText: 'Sports' })).toBeVisible();
  // Both doors are present at once — neither is primary (FR-24.1).
  await expect(page.locator('.discover-search input')).toBeVisible();
});

test('a section drills into its subcategories, with an escape for the whole section', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');
  await page.click('.section-tile:has-text("Sports")');

  await expect(page.locator('.section-chips .chip', { hasText: 'Motorsport' })).toBeVisible();
  // For the user who recognises none of the subcategory names (FR-24.2).
  await expect(page.locator('.chip.anything')).toHaveText('Anything in Sports');
});

test('drilling to a subcategory returns grouped, labelled suggestions', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');
  await page.click('.section-tile:has-text("Sports")');
  await page.click('.section-chips .chip:has-text("Motorsport")');

  await expect(page.locator('.suggestion').first()).toBeVisible();
  await expect(page.locator('.discover-results-head h3')).toHaveText('Sports · Motorsport');
  // The grouping doubles as a preview of where the topic will file itself.
  // The DOM text — the uppercasing is CSS, which `toHaveText` does not see.
  await expect(page.locator('.suggestion-group-label').first()).toHaveText('Sports · Motorsport');
  // Ongoing vs evergreen is on the card, not hidden (FR-24.10). The mock
  // alternates, so both must appear.
  await expect(page.locator('.suggestion-kind.evergreen').first()).toBeVisible();
  await expect(page.locator('.suggestion-kind.ongoing').first()).toBeVisible();
});

test('adding a suggestion creates the topic and leaves the card in place', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');
  await page.click('.section-tile:has-text("Sports")');
  await page.click('.section-chips .chip:has-text("Motorsport")');

  const first = page.locator('.suggestion').first();
  const name = (await first.locator('.suggestion-name').textContent()) ?? '';
  expect(name).not.toBe('');
  await first.locator('[data-add-suggestion]').click();

  // The card stays put and marks itself — a row vanishing under the cursor is
  // how the *next* one gets clicked by accident.
  await expect(first.locator('.suggestion-added')).toBeVisible();
  await expect(first.locator('[data-add-suggestion]')).toHaveCount(0);

  await page.click('[data-action=close-discover]');
  await expect(page.locator('.topic', { hasText: name })).toBeVisible();
});

test('the added topic carries the suggestion’s guidance (FR-24.12)', async ({ page }) => {
  // The steer is what makes the *first* check narrowed rather than a bare name,
  // so it has to arrive with the topic rather than after it.
  await page.goto('/');
  const topic = page.locator('.topic').first();
  await topicAction(page, topic, 'guidance');
  await expect(page.locator('.dialog.guidance textarea')).not.toBeEmpty();
  await page.click('[data-action=close-guidance]');
});

test('a topic already followed is never suggested again (FR-24.11)', async ({ page }) => {
  // The mock plants the first excluded name at the top of its list on purpose,
  // so this fails loudly if the server-side filter stops running.
  await page.goto('/');
  const followed = (await page.locator('.topic .topic-name').first().textContent())?.trim() ?? '';
  expect(followed).not.toBe('');

  await page.click('[data-action=open-discover]');
  await page.click('.section-tile:has-text("Sports")');
  await page.click('.section-chips .chip:has-text("Motorsport")');

  await expect(page.locator('.suggestion').first()).toBeVisible();
  await expect(page.locator('.suggestion-name', { hasText: followed })).toHaveCount(0);
});

test('the free-text box is the other door to the same list', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');

  await page.fill('.discover-search input', 'cycling');
  await page.press('.discover-search input', 'Enter');

  await expect(page.locator('.suggestion').first()).toBeVisible();
  await expect(page.locator('.discover-results-head h3')).toContainText('cycling');
});

test('an empty box is “surprise me”, not an error (FR-24.3)', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');

  await page.fill('.discover-search input', '');
  await page.click('.discover-search button[type=submit]');

  await expect(page.locator('.discover-results-head h3')).toHaveText('A bit of everything');
  await expect(page.locator('.suggestion').first()).toBeVisible();
  await expect(page.locator('.discover-status.error')).toHaveCount(0);
});

test('Back returns to the section that produced the results', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');
  await page.click('.section-tile:has-text("Sports")');
  await page.click('.section-chips .chip:has-text("Motorsport")');
  await expect(page.locator('.suggestion').first()).toBeVisible();

  await page.click('[data-action=discover-back]');
  // Back to Sports' subcategories, not all the way out to the grid — the user
  // was browsing one section and most likely wants its neighbour.
  await expect(page.locator('.chip.anything')).toHaveText('Anything in Sports');

  await page.click('[data-action=discover-back]');
  await expect(page.locator('.section-tile')).toHaveCount(SECTION_TILE_COUNT);
});

test('a provider failure is shown in the dialog with a retry, not as a dead end', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');

  // The mock throws on a seed containing "fail" (NEWS-124).
  await page.fill('.discover-search input', 'fail please');
  await page.press('.discover-search input', 'Enter');

  await expect(page.locator('.discover-status.error')).toBeVisible();
  await expect(page.locator('[data-action=discover-retry]')).toBeVisible();
  // The dialog stays open: the user is mid-task, and the error is about this
  // request rather than the app.
  await expect(page.locator('.dialog.discover')).toBeVisible();
});

test('closing works from the ✕ and from the backdrop, but not from inside', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');

  await page.locator('.dialog.discover h2').click();
  await expect(page.locator('.dialog.discover')).toBeVisible();

  await page.locator('[data-action=discover-backdrop]').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.dialog.discover')).toHaveCount(0);

  await page.click('[data-action=open-discover]');
  await page.click('[data-action=close-discover]');
  await expect(page.locator('.dialog.discover')).toHaveCount(0);
});

test('the topics list survives the dialog opening and closing', async ({ page }) => {
  // The kerf structural rule (docs/3-ui.md): a conditional sibling appearing
  // and disappearing must not disturb the keyed topics list beside it.
  await page.goto('/');
  const before = await page.locator('.topic').count();
  expect(before).toBeGreaterThan(0);

  for (let i = 0; i < 3; i++) {
    await page.click('[data-action=open-discover]');
    await page.click('[data-action=close-discover]');
    await expect(page.locator('.dialog.discover')).toHaveCount(0);
  }
  await expect(page.locator('.topic')).toHaveCount(before);
});


// --- The keep/skip tuner (NEWS-127, FR-24.5–24.9) --------------------------
//
// Sequences, not single operations: the interesting failures here are all
// orderings. The mock's tuner names encode the round and direction, so a round
// that failed to advance is visible rather than silent (NEWS-124).

async function openMotorsportResults(page: Page): Promise<void> {
  await page.goto('/');
  await page.click('[data-action=open-discover]');
  await page.click('.section-tile:has-text("Sports")');
  await page.click('.section-chips .chip:has-text("Motorsport")');
  await expect(page.locator('.suggestion').first()).toBeVisible();
}

test('a card offers both depth directions, and so does the whole set (FR-24.5)', async ({ page }) => {
  await openMotorsportResults(page);
  await expect(page.locator('.suggestion .link-btn', { hasText: 'narrower' }).first()).toBeVisible();
  await expect(page.locator('.suggestion .link-btn', { hasText: 'similar' }).first()).toBeVisible();
  await expect(page.locator('.results-depth .link-btn', { hasText: 'narrow these' })).toBeVisible();
});

test('the two depth scopes do not read as the same control (NEWS-265)', async ({ page }) => {
  // They were byte-identical — same class, same icon, same word — 470px apart
  // with a heading and a group label between them, so the only cue for which
  // anchor a click committed to was position. Both start a six-round, billable
  // tuner (FR-24.6), so guessing is expensive. This asserts the three things
  // that now distinguish them; any one of them silently reverting is the bug.
  await openMotorsportResults(page);

  const section = page.locator('.results-depth .link-btn');
  const row = page.locator('.suggestion-depth .link-btn');

  // 1. Different words. Plural for the set, singular for the one row.
  await expect(section.first()).toHaveText(/narrow these/);
  await expect(section.nth(1)).toHaveText(/more like these/);
  await expect(row.first()).toHaveText(/narrower/);

  // The set-level labels must not merely *contain* the row-level ones, which is
  // what "narrower" / "narrower than these" would have been.
  const sectionText = (await section.first().innerText()).trim();
  const rowText = (await row.first().innerText()).trim();
  expect(sectionText, 'the two labels must be tellable apart at a glance').not.toBe(rowText);

  // 2. Both scopes name their anchor on hover. The set-level pair had no title
  //    at all, which inverted the help: the *less* obvious control was the one
  //    with no explanation.
  await expect(section.first()).toHaveAttribute('title', /More specific than/);
  await expect(section.nth(1)).toHaveAttribute('title', /Adjacent to/);
  await expect(row.first()).toHaveAttribute('title', /More specific than this/);

  // 3. The set-level pair sits beside the heading it acts on, not flung to the
  //    far edge. `margin-left: auto` used to put ~470px between them.
  const gap = await page.evaluate(() => {
    const h3 = document.querySelector('.discover-results-head h3');
    const depth = document.querySelector('.results-depth');
    if (h3 === null || depth === null) throw new Error('results head not rendered');
    return Math.round(depth.getBoundingClientRect().left - h3.getBoundingClientRect().right);
  });
  expect(gap, 'the set-level controls belong next to their heading').toBeLessThan(60);
});

test('the heading never contradicts the group labels beneath it (NEWS-269)', async ({ page }) => {
  // The observed bug was a "Business · Markets" heading over a lone result
  // grouped under "Business · Other" — both true, presented as peers, and the
  // honest reading is that the filter failed.
  //
  // Asserted as an invariant rather than against a fixed string, because what the
  // mock classifies things as is not this test's business: *if* any group differs
  // from the section asked for, the qualifier must be there to explain it; if
  // none do, it must stay silent rather than hedge an exact match.
  await openMotorsportResults(page);

  const heading = (await page.locator('.discover-results-head h3').innerText()).trim();
  const labels = await page.locator('.suggestion-group-label').allInnerTexts();
  const qualifier = (await page.locator('.results-qualifier').innerText()).trim();

  expect(labels.length, 'need at least one group to compare against').toBeGreaterThan(0);
  const allMatch = labels.every((l) => l.trim().toLowerCase() === heading.toLowerCase());

  if (allMatch) {
    expect(qualifier, 'an exact match must not be hedged').toBe('');
  } else {
    expect(qualifier, `heading “${heading}” vs groups ${JSON.stringify(labels)} needs explaining`).toBe(
      'closest matches',
    );
  }
});

test('entering the tuner shows one candidate, the round count and a way out', async ({ page }) => {
  await openMotorsportResults(page);
  await page.locator('.suggestion .link-btn', { hasText: 'narrower' }).first().click();

  await expect(page.locator('.tuner-card')).toBeVisible();
  // Exactly one at a time (FR-24.6) — not a list with extra steps.
  await expect(page.locator('.tuner-card')).toHaveCount(1);
  await expect(page.locator('.tuner-round')).toContainText('Round 1 of');
  // Endable at any point (FR-24.9), never hidden behind another state.
  await expect(page.locator('[data-tuner=done]')).toBeVisible();
  // Round one has nothing kept to cite, so it names the anchor instead.
  await expect(page.locator('.tuner-why')).toContainText('narrower than');
});

test('keeping cites the keeps on the next candidate (FR-24.8)', async ({ page }) => {
  await openMotorsportResults(page);
  await page.locator('.suggestion .link-btn', { hasText: 'narrower' }).first().click();
  await expect(page.locator('.tuner-card')).toBeVisible();

  const first = (await page.locator('.tuner-card .suggestion-name').textContent()) ?? '';
  await page.click('[data-tuner=keep]');

  await expect(page.locator('.tuner-why')).toContainText('because you kept');
  await expect(page.locator('.tuner-why')).toContainText(first);
  await expect(page.locator('.tuner-kept')).toContainText(first);
});

test('a drained round advances to the next one rather than stalling', async ({ page }) => {
  await openMotorsportResults(page);
  await page.locator('.suggestion .link-btn', { hasText: 'similar' }).first().click();
  await expect(page.locator('.tuner-card')).toBeVisible();
  await expect(page.locator('.tuner-round')).toContainText('Round 1 of');

  // The mock returns a fixed-size round, so judging that many drains it.
  for (let i = 0; i < 4; i++) await page.click('[data-tuner=skip]');

  await expect(page.locator('.tuner-round')).toContainText('Round 2 of');
  await expect(page.locator('.tuner-card')).toBeVisible();
});

test('skipping everything still advances and keeps nothing', async ({ page }) => {
  await openMotorsportResults(page);
  await page.locator('.suggestion .link-btn', { hasText: 'narrower' }).first().click();
  await expect(page.locator('.tuner-card')).toBeVisible();

  for (let i = 0; i < 4; i++) await page.click('[data-tuner=skip]');
  await expect(page.locator('.tuner-kept')).toContainText('Nothing kept yet');
});

test('Done returns to the list with the keeps waiting there, uncreated (FR-24.7)', async ({ page }) => {
  await openMotorsportResults(page);
  const before = await page.locator('.suggestion').count();

  await page.locator('.suggestion .link-btn', { hasText: 'narrower' }).first().click();
  await expect(page.locator('.tuner-card')).toBeVisible();
  const kept = (await page.locator('.tuner-card .suggestion-name').textContent()) ?? '';
  await page.click('[data-tuner=keep]');
  await page.click('[data-tuner=done]');

  // Back on the list, with the kept candidate now in it…
  await expect(page.locator('.tuner-card')).toHaveCount(0);
  await expect(page.locator('.suggestion')).toHaveCount(before + 1);
  await expect(page.locator('.suggestion-name', { hasText: kept })).toBeVisible();
  // …and offering an Add, because keeping is not creating.
  await expect(page.locator('.suggestion', { hasText: kept }).locator('[data-add-suggestion]')).toBeVisible();
});

test('finishing the tuner does not create a topic behind the user’s back', async ({ page }) => {
  // FR-24.7 end to end: keeping is not creating, and the click that ends the
  // session must not create anything either. Checked against the *topic list*
  // rather than the dialog, because that is where a phantom creation would show.
  //
  // Not a guard against the delegate/morph collision that bit NEWS-126 — that is
  // prevented structurally, by each delegate family owning one attribute
  // (`data-tuner`, `data-tune`, `data-discover-nav`). Verified by re-registering
  // the delegates in the dangerous order: this test still passed, so it is not
  // what would catch a regression there.
  await page.goto('/');
  const topicsBefore = await page.locator('.topic').count();

  await openMotorsportResults(page);
  await page.locator('.suggestion .link-btn', { hasText: 'narrower' }).first().click();
  await expect(page.locator('.tuner-card')).toBeVisible();
  await page.click('[data-tuner=keep]');
  await page.click('[data-tuner=done]');
  await expect(page.locator('.suggestion').first()).toBeVisible();

  await page.click('[data-action=close-discover]');
  await expect(page.locator('.topic')).toHaveCount(topicsBefore);
});

test('exiting mid-round and re-entering starts a fresh session', async ({ page }) => {
  await openMotorsportResults(page);
  await page.locator('.suggestion .link-btn', { hasText: 'narrower' }).first().click();
  await expect(page.locator('.tuner-card')).toBeVisible();
  await page.click('[data-tuner=keep]');
  await page.click('[data-tuner=done]');

  // Re-entering must not resume the old round or carry its keeps forward.
  await page.locator('.suggestion .link-btn', { hasText: 'similar' }).first().click();
  await expect(page.locator('.tuner-round')).toContainText('Round 1 of');
  await expect(page.locator('.tuner-kept')).toContainText('Nothing kept yet');
});

test('entering from a card and then from the set works without a reload', async ({ page }) => {
  await openMotorsportResults(page);
  await page.locator('.suggestion .link-btn', { hasText: 'narrower' }).first().click();
  await expect(page.locator('.tuner-card')).toBeVisible();
  await page.click('[data-tuner=done]');

  // "more like these" since NEWS-265 — the set-level pair is deliberately worded
  // differently from the row-level "similar" so the two scopes are tellable apart.
  await page.locator('.results-depth .link-btn', { hasText: 'more like these' }).click();
  await expect(page.locator('.tuner-card')).toBeVisible();
  await expect(page.locator('.tuner-why')).toContainText('similar to');
});

test('closing the dialog mid-tune ends the session', async ({ page }) => {
  await openMotorsportResults(page);
  await page.locator('.suggestion .link-btn', { hasText: 'narrower' }).first().click();
  await expect(page.locator('.tuner-card')).toBeVisible();

  await page.click('[data-action=close-discover]');
  await expect(page.locator('.dialog.discover')).toHaveCount(0);

  await page.click('[data-action=open-discover]');
  // A tuner that outlived the list it came from would reopen here.
  await expect(page.locator('.tuner-card')).toHaveCount(0);
  await expect(page.locator('.section-tile')).toHaveCount(SECTION_TILE_COUNT);
});

// --- Discovery inside onboarding (NEWS-128, FR-24.18) ----------------------
//
// The suggestion block is gated on a *real* provider being available — mock is
// excluded, exactly as the auto-open decision excludes it, or the app would
// always look configured. So these tests configure one through the UI, which
// means the gate itself is exercised rather than stepped around. Under
// `--ai-test` the request is still served by the mock, so the answer is
// deterministic.

async function openSetupGuide(page: Page): Promise<void> {
  await openSettingsTab(page, 'App');
  await page.locator('[data-action=rerun-onboarding]').click();
  await expect(page.locator('.dialog.onboarding')).toBeVisible();
}

async function stepToTopics(page: Page): Promise<void> {
  const wizard = page.locator('.dialog.onboarding');
  await wizard.locator('[data-action=onboarding-next]').click();
  await wizard.locator('[data-action=onboarding-next]').click();
  await expect(wizard.locator('h2')).toHaveText('What should Newsmonger watch?');
}

test('with no usable provider, the Topics step falls back to the starter chips', async ({ page }) => {
  // Selecting OpenAI with no key is the deterministic way to make the gate say
  // "no": `auto` would otherwise pick up whatever CLI happens to be signed in on
  // the machine running the suite, which is exactly the environment dependence
  // the rule was rewritten to avoid (it mirrors `resolveProvider`).
  await page.goto('/');
  await openSettingsTab(page, 'Source');
  await page.selectOption('[data-action=provider]', 'openai');
  await page.locator('.dialog [data-action=close-settings]').click();

  await openSetupGuide(page);
  await stepToTopics(page);

  // The static starters are still there and still usable — a skipped Source
  // must not leave this step empty.
  await expect(page.locator('.chip.starter').first()).toBeVisible();
  await expect(page.locator('.suggest-note')).toContainText('Set up a source');
  await expect(page.locator('.onboarding-suggest [data-action=open-discover]')).toHaveCount(0);
  await page.locator('[data-action=onboarding-skip]').click();

  await openSettingsTab(page, 'Source');
  await page.selectOption('[data-action=provider]', 'auto');
  await page.locator('.dialog [data-action=close-settings]').click();
});

test('the Topics step opens the real discovery dialog (NEWS-146)', async ({ page }) => {
  await page.goto('/');
  await openSettingsTab(page, 'Source');
  await page.fill('.key-row:has-text("Anthropic") .key-input', 'sk-ant-e2e-onboarding');
  await page.locator('.key-row:has-text("Anthropic") .key-input').blur();
  await expect(page.locator('.key-row:has-text("Anthropic") .key-state')).toContainText('stored in');
  await page.selectOption('[data-action=provider]', 'anthropic');
  await page.locator('.dialog [data-action=close-settings]').click();

  await openSetupGuide(page);
  await stepToTopics(page);

  const wizard = page.locator('.dialog.onboarding');
  await expect(wizard.locator('.note')).toContainText('None yet');

  // Onboarding used to carry its own reduced discovery. It now opens the same
  // dialog the sidebar does, with both doors — the section grid is the half a new
  // user most needs, and was the half the reduced copy didn't have.
  await wizard.locator('[data-action=open-discover]').click();
  const dialog = page.locator('.dialog.discover');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.section-grid .section-tile').first()).toBeVisible();

  // Escape closes discovery and leaves the wizard standing. Before NEWS-146 the
  // Escape ladder had no rung for discovery at all, so this closed the wizard
  // *underneath* it.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(wizard).toBeVisible();

  await wizard.locator('[data-action=open-discover]').click();
  await dialog.locator('input[name=discover-query]').fill('cycling');
  await dialog.locator('[data-action=discover-search] button[type=submit]').click();
  // The first suggestion that can actually be *added*, not simply the first
  // (NEWS-321). The mock plants a topic you already follow at the **head** of
  // every batch on purpose — "the planted duplicate goes first, where a filter
  // that only checks the tail of the list would miss it" — and the UI renders an
  // already-followed suggestion as "Added" with no button at all. So whenever a
  // topic exists when this search runs, `.first()` is a card whose
  // `[data-add-suggestion]` never appears, and the click waits out the whole
  // timeout.
  //
  // Latent for as long as this test has existed, and intermittent because
  // whether a topic exists here depends on what the tests above it left behind.
  // It surfaced when sharding raised the load enough to change that timing.
  //
  // Resolved to a name-based locator before the click: filtering on the button
  // would stop matching the moment the button is replaced by "Added".
  const addable = dialog.locator('.suggestion', { has: page.locator('[data-add-suggestion]') }).first();
  await expect(addable).toBeVisible();
  const addedName = ((await addable.locator('.suggestion-name').textContent()) ?? '').trim();
  expect(addedName).not.toBe('');
  const card = dialog.locator('.suggestion', { hasText: addedName });

  // Adding creates the topic there and then (FR-24.26) — the wizard's
  // "nothing until Finish" rule covers the starter chips, not this.
  await card.locator('[data-add-suggestion]').click();
  await expect(card).toContainText('Added');
  await page.locator('[data-action=close-discover]').click();

  // So the count line has to name both, because only one of them is still
  // reversible from this step.
  await expect(wizard.locator('.note')).toContainText('1 added already');
  await wizard.locator('.chip.starter').first().click();
  await expect(wizard.locator('.note')).toContainText('1 chosen, created when you finish');
  await expect(wizard.locator('.note')).toContainText('1 added already');

  // The step's own content must not run into the footer rule. It measured a 0px
  // gap — the rule flush against the count's descenders — because the footer's
  // padding is below its border, not above it (NEWS-146).
  const footGap = await page.evaluate(() => {
    const note = document.querySelector('.onboarding-body .note');
    const foot = document.querySelector('.onboarding-foot');
    if (!note || !foot) return null;
    return foot.getBoundingClientRect().top - note.getBoundingClientRect().bottom;
  });
  expect(footGap).not.toBeNull();
  expect(footGap ?? 0).toBeGreaterThanOrEqual(8);

  await wizard.locator('[data-action=onboarding-next]').click();
  await wizard.locator('[data-action=onboarding-next]').click();
  await expect(wizard).toHaveCount(0);

  // The discovered topic arrived with its guidance (FR-24.12), which is what
  // makes its first check narrowed rather than a bare-name search.
  const row = page.locator('.topic', { hasText: addedName });
  await expect(row).toBeVisible();
  await topicAction(page, row, 'guidance');
  await expect(page.locator('.dialog.guidance textarea')).not.toBeEmpty();
  await page.click('[data-action=close-guidance]');

  // Leave the app as the rest of the suite expects it: auto, no key configured.
  await openSettingsTab(page, 'Source');
  await page.click('.key-row:has-text("Anthropic") [data-remove-key]');
  await acceptConfirm(page);
  await page.selectOption('[data-action=provider]', 'auto');
  await page.locator('.dialog [data-action=close-settings]').click();
});

test('clean up the topics this spec created', async ({ page }) => {
  await page.goto('/');
  const names = await page.locator('.topic .topic-name').allTextContents();
  for (const name of names) {
    const row = page.locator('.topic', { hasText: name.trim() }).first();
    await topicAction(page, row, 'delete');
  }
  await expect(page.locator('.topic')).toHaveCount(0);
});

// --- Dark mode and icons (NEWS-133/134/135) --------------------------------
//
// All three shipped as the same underlying mistake: the discovery dialog used
// classes and markup that don't exist elsewhere in the app instead of the
// established ones. `icon-btn` was never a class (every other dialog's close
// button is `btn icon`), the search field was never given the text-field style
// every other input has, and the depth controls used "⌄" and "≈" as icons.
//
// The dark-mode assertions below are the general guard: any control in this
// dialog that renders near-white on the dark panel fails, whatever caused it.

/** Perceived lightness of an element's own background, 0 (black) – 1 (white). */
async function backgroundLightness(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const parts = window.getComputedStyle(el).backgroundColor.match(/[\d.]+/g) ?? ['0', '0', '0'];
    const [r, g, b] = parts.map(Number);
    // Rec. 601 luma — good enough to tell "dark panel" from "white box".
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  });
}

test('no control in the dialog renders light-on-dark in dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await page.click('[data-action=open-discover]');

  // The dialog itself establishes what "dark" means here, so the controls are
  // compared against it rather than against an absolute threshold.
  const panel = await backgroundLightness(page, '.dialog.discover');
  expect(panel).toBeLessThan(0.5);

  // The search field: browser-default white was the NEWS-134 bug.
  expect(await backgroundLightness(page, '.discover-search input')).toBeLessThan(0.5);
  // The close button: a white chip floating on the panel was NEWS-133.
  expect(await backgroundLightness(page, '[data-action=close-discover]')).toBeLessThan(0.5);

  await page.emulateMedia({ colorScheme: 'light' });
});

test('the depth controls use real icons, not text glyphs (NEWS-135)', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');
  await page.click('.section-tile:has-text("Sports")');
  await page.click('.section-chips .chip:has-text("Motorsport")');
  await expect(page.locator('.suggestion').first()).toBeVisible();

  const narrower = page.locator('.suggestion .link-btn', { hasText: 'narrower' }).first();
  await expect(narrower.locator('svg')).toHaveCount(1);
  await expect(page.locator('.suggestion .link-btn', { hasText: 'similar' }).first().locator('svg')).toHaveCount(1);
  // And the glyphs they replaced are gone from the label.
  expect(await narrower.textContent()).not.toContain('⌄');
});

// --- More suggestions (NEWS-136) -------------------------------------------

test('More appends to the list rather than replacing it', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');
  await page.fill('.discover-search input', 'cycling');
  await page.press('.discover-search input', 'Enter');
  await expect(page.locator('.suggestion').first()).toBeVisible();

  const before = await page.locator('.suggestion').count();
  const firstName = await page.locator('.suggestion-name').first().textContent();

  await page.click('[data-action=discover-more]');

  // The list the user was reading stays put and grows underneath.
  await expect(page.locator('.suggestion')).not.toHaveCount(before);
  expect(await page.locator('.suggestion-name').first().textContent()).toBe(firstName);
});

test('More stops offering itself once nothing new comes back', async ({ page }) => {
  // "repeat" makes the mock keep answering with the same batch (NEWS-136) —
  // a model that has run out of ideas. Every press is a billable call, so an
  // exhausted seam must be visible rather than discovered by pressing again.
  await page.goto('/');
  await page.click('[data-action=open-discover]');
  await page.fill('.discover-search input', 'repeat');
  await page.press('.discover-search input', 'Enter');
  await expect(page.locator('.suggestion').first()).toBeVisible();

  await page.click('[data-action=discover-more]');

  await expect(page.locator('.discover-more-note')).toContainText('everything for this search');
  await expect(page.locator('[data-action=discover-more]')).toHaveCount(0);
});

// --- Progress bar (NEWS-137) and the privacy link (NEWS-138) ---------------

test('a discovery call shows a paced progress bar, not just “Asking…”', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-action=open-discover]');

  // Hold the request open so the waiting state is observable — the mock is
  // otherwise fast enough that this is a race.
  await page.route('**/api/discover', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.fill('.discover-search input', 'cycling');
  await page.press('.discover-search input', 'Enter');

  const bar = page.locator('.discover-bar');
  await expect(bar).toBeVisible();
  // Paced by CSS from an estimated duration, so there is no timer to test —
  // what matters is that a duration was actually handed over.
  const duration = await bar.evaluate((el) => getComputedStyle(el).getPropertyValue('--discover-duration').trim());
  expect(duration).toMatch(/^\d+ms$/);
  expect(Number.parseInt(duration, 10)).toBeGreaterThan(0);
  // And that it is telling the user something about the wait.
  await expect(page.locator('.discover-bar-note')).toContainText(/takes|took/);

  await page.unroute('**/api/discover');
  await expect(page.locator('.suggestion').first()).toBeVisible();
  await expect(bar).toHaveCount(0);
});

test('the privacy link sits at the foot of the sidebar, in reach (NEWS-138)', async ({ page }) => {
  await page.goto('/');

  const link = page.locator('.rail-foot [data-action=open-privacy]');
  await expect(link).toBeVisible();
  // The point of the move: reachable without scrolling past the whole feed.
  // The rail is sticky, so the link stays within the viewport.
  const box = await link.boundingBox();
  const viewport = page.viewportSize();
  expect(box?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(viewport?.height ?? 0);

  // And the page footer no longer carries a second copy.
  await expect(page.locator('.app-footer [data-action=open-privacy]')).toHaveCount(0);

  await link.click();
  await expect(page.locator('.dialog.privacy-dialog')).toBeVisible();
  await page.click('[data-action=close-privacy]');
});

test('collapsing the sidebar keeps privacy reachable via the footer', async ({ page }) => {
  // The rail is `display: none` when collapsed, so the footer is the fallback —
  // one entry point on screen at a time, never zero.
  await page.goto('/');
  await page.click('[data-action=toggle-sidebar]');

  await expect(page.locator('.rail-foot [data-action=open-privacy]')).toBeHidden();
  await expect(page.locator('.app-footer [data-action=open-privacy]')).toBeVisible();

  await page.click('[data-action=toggle-sidebar]');
});

test('a search in flight cannot be raced by a second one (NEWS-324)', async ({ page }) => {
  // What actually stops two discovery responses arriving out of order, which is
  // worth pinning because it is *incidental*: while a request is in flight the
  // submit button is disabled and the whole results body is replaced by the
  // waiting state, so no control on screen can issue a second one.
  //
  // Written after trying to demonstrate the opposite. `runDiscovery` carries the
  // issue-order guard `refreshState` and `refreshFeed` have (NEWS-104), and the
  // race it defends against turned out to be unreachable through the UI — the
  // second search simply never fires. This test is the reason that guard is
  // documented as defence in depth rather than as a fix: if a future change
  // keeps results on screen during a re-search, this fails and says so, which is
  // exactly the moment the guard starts earning its keep.
  await page.goto('/');
  await page.click('[data-action=open-discover]');

  let seen = 0;
  await page.route('**/api/discover', async (route) => {
    seen += 1;
    if (seen === 1) await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });

  await page.fill('.discover-search input', 'sailing');
  await page.press('.discover-search input', 'Enter');

  // Mid-flight: the waiting state owns the body, and the submit is disabled.
  await expect(page.locator('.discover-bar')).toBeVisible();
  await expect(page.locator('.discover-search button[type=submit]')).toBeDisabled();
  await expect(page.locator('.suggestion')).toHaveCount(0);

  // So a second Enter cannot start anything.
  await page.fill('.discover-search input', 'climbing');
  await page.press('.discover-search input', 'Enter');
  expect(seen, 'a second search must not be issuable while one is in flight').toBe(1);

  await page.unroute('**/api/discover');
  await expect(page.locator('.suggestion').first()).toBeVisible();
  await expect(page.locator('.discover-results-head h3')).toContainText('sailing');

  await page.click('[data-action=close-discover]');
});
