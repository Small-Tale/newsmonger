import type { Page } from '@playwright/test';

import { expect, openSettingsTab, resetSharedState, test, topicAction, workerBaseURL } from './fixtures.js';

// Wide-window layout (NEWS-96). The shell used to be capped at 1060px and
// centred, which left the feed at a fixed ~650px no matter how much room the
// window had. These tests assert the two halves of the fix: the shell fills the
// window, and the extra room becomes extra story columns.
//
// This is a CSS-only feature, so there is nothing to unit test — a rendered
// layout is the only place the behaviour exists. Measuring it here is also the
// only way it can regress *noisily*: a stray `max-width` would otherwise sail
// through every other test in the suite.

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetSharedState(workerBaseURL());
});

const TOPICS = ['Layout One', 'Layout Two', 'Layout Three', 'Layout Four'];

/**
 * Story cards on the topmost row of the first day group — i.e. the column
 * count. Read from the live geometry rather than from the CSS, so it reflects
 * what a reader would actually see.
 */
async function measure(page: Page): Promise<{
  shellLeft: number;
  shellWidth: number;
  columns: number;
  scrollWidth: number;
}> {
  return page.evaluate(() => {
    const shell = document.querySelector('.shell');
    const rect = shell?.getBoundingClientRect();
    const cards = [...(document.querySelector('.day')?.querySelectorAll(':scope > .item') ?? [])];
    const tops = cards.map((c) => Math.round(c.getBoundingClientRect().top));
    const first = tops.length > 0 ? Math.min(...tops) : 0;
    return {
      shellLeft: Math.round(rect?.left ?? -1),
      shellWidth: Math.round(rect?.width ?? -1),
      columns: tops.filter((t) => t === first).length,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
}

test('set up topics with stories to lay out', async ({ page }) => {
  await page.goto('/');
  for (const name of TOPICS) {
    await page.fill('.add-topic input', name);
    await page.press('.add-topic input', 'Enter');
    await expect(page.locator('.topic', { hasText: name })).toBeVisible();
  }
  // The mock provider files two stories per topic on the check that a new topic
  // triggers; the column assertions below need enough cards to fill a row.
  await expect.poll(async () => page.locator('.day > .item').count()).toBeGreaterThanOrEqual(8);
});

test('the shell fills the window instead of centring (NEWS-96)', async ({ page }) => {
  for (const width of [1280, 1920, 2560]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await expect(page.locator('.day > .item').first()).toBeVisible();

    const m = await measure(page);
    expect(m.shellLeft, `flush left at ${width}px`).toBe(0);
    expect(m.shellWidth, `full width at ${width}px`).toBe(width);
    // Filling the width must not mean overflowing it.
    expect(m.scrollWidth, `no horizontal overflow at ${width}px`).toBe(width);
  }
});

test('extra window width becomes extra story columns (NEWS-96)', async ({ page }) => {
  const columnsAt = async (width: number): Promise<number> => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await expect(page.locator('.day > .item').first()).toBeVisible();
    return (await measure(page)).columns;
  };

  // The exact thresholds are a styling decision and may be tuned; what must
  // hold is that more room never means fewer columns, and that a wide monitor
  // genuinely gets more than a laptop.
  const narrow = await columnsAt(1100);
  const laptop = await columnsAt(1440);
  const wide = await columnsAt(2560);

  expect(narrow).toBe(1);
  expect(laptop).toBeGreaterThan(narrow);
  expect(wide).toBeGreaterThan(laptop);
});

test('clean up the layout topics', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await resetSharedState(workerBaseURL());
  await page.goto('/');
  for (const name of TOPICS) {
    await expect(page.locator('.topic', { hasText: name })).toHaveCount(0);
  }
});

// Mode exits look pressable (NEWS-266).
//
// All four were `btn subtle`, which was then `background: none; border-color:
// transparent` — indistinguishable from the sentence beside it until you hover.
// That put the weight backwards: the reversible in-mode actions read as buttons
// while the **only way out** read as a caption. (NEWS-305 later gave the variant
// its own resting edge; these four stay promoted on the weight argument.)
//
// Asserted by computed style rather than by class name: `class="btn"` passing is
// not the point, a visible edge is, and a future change to `.btn` that removed
// its border would otherwise pass a class assertion while reintroducing the bug.

/** Whether a control has an edge a reader could take for pressable. */
async function hasVisibleEdge(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`${sel} not rendered`);
    const cs = getComputedStyle(el);
    const transparent = (c: string): boolean => c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c);
    return !transparent(cs.borderTopColor) && cs.borderTopWidth !== '0px';
  }, selector);
}

// Review mode's exit is asserted in `app.spec.ts`, beside the flow that already
// produces a flagged story — reaching that state needs a topic menu and a
// confirm dialog, and duplicating it here to check one border would be a second
// copy of a setup that exists.
test('leaving the saved filter is a button, not a caption (NEWS-266)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/');
  await page.click('[data-action=toggle-saved-filter]');
  await expect(page.locator('.banner.saved')).toBeVisible();
  expect(await hasVisibleEdge(page, '[data-action=clear-saved-filter]')).toBe(true);
  await page.click('[data-action=clear-saved-filter]');
});

// The `subtle` variant itself, one level below NEWS-266 (NEWS-305).
//
// NEWS-266 moved four mode exits *out* of `btn subtle` because the variant had
// no resting edge. The variant kept the bug for everyone still on it: Settings →
// App's two actions were unbordered, unfilled `--ink-soft` text sitting among
// unbordered, unfilled `--ink-soft` prose. Promoting call sites one at a time is
// how a variant nobody can press survives, so the edge now lives on `.btn.subtle`
// and this asserts it where the review found it missing.
test('the quiet button variant has a resting edge (NEWS-305)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/');
  await openSettingsTab(page, 'App');

  // One subject since NEWS-329 removed `test-notification`, which was the other.
  // The property is per *variant*, not per button, so one call site still proves
  // it — and `.btn.subtle` is worn widely enough elsewhere (discovery's Back,
  // the backup offer's two exits, onboarding's Skip, the key rows' Remove) that
  // a regression here would be a regression everywhere.
  for (const action of ['rerun-onboarding']) {
    expect(await hasVisibleEdge(page, `[data-action=${action}]`), action).toBe(true);
  }

  // …and it is a *quiet* button, not a promoted one: no fill, so it still reads
  // as secondary beside the primary actions elsewhere in the dialog. Without
  // this the fix could drift into "make it a normal button", which loses the
  // hierarchy the variant exists for.
  const filled = await page.evaluate(() => {
    const el = document.querySelector('[data-action=rerun-onboarding]');
    if (el === null) throw new Error('rerun-onboarding not rendered');
    const bg = getComputedStyle(el).backgroundColor;
    return !(bg === 'transparent' || /rgba\(.*,\s*0\)$/.test(bg));
  });
  expect(filled, 'subtle stays unfilled').toBe(false);

  await page.click('[data-action=close-settings]');
});

// The search field across the one-column collapse (NEWS-267).
//
// It shrank to a fixed 110px pill below 720px, leaving the input **62px** — about
// four characters, so "Search stories" rendered as "Search st" and you could not
// read your own query. Nothing caught it: the field was present, focusable,
// named, and contrast-correct, so axe and every functional test passed while the
// control was unusable. Size *is* the bug, which means measuring is the only way
// to see it — the same reasoning as the column tests above.

/** The pill and the text input inside it, as a reader would see them. */
async function searchWidths(page: Page): Promise<{ pill: number; input: number }> {
  return page.evaluate(() => {
    const pill = document.querySelector('.search');
    const input = document.querySelector('.search-input');
    if (pill === null || input === null) throw new Error('search not rendered');
    return {
      pill: Math.round(pill.getBoundingClientRect().width),
      input: Math.round(input.getBoundingClientRect().width),
    };
  });
}

test('below the one-column collapse the search is an icon, not a stub (NEWS-267)', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 1000 });
  await page.goto('/');
  await expect(page.locator('.search')).toBeVisible();

  // At rest: a circle the size of its sibling icon buttons, with no clipped
  // placeholder behind it. The old bug lived precisely here — a pill wide enough
  // to look like a field and too narrow to be one.
  const rest = await searchWidths(page);
  expect(rest.pill, 'collapsed to an icon-sized circle').toBeLessThanOrEqual(40);
  expect(rest.input, 'no half-visible input at rest').toBeLessThanOrEqual(1);

  // Clicking the icon must focus the input — a collapsed pill that cannot be
  // opened by pointer is worse than the stub it replaced. This works through the
  // `<label for>`, so it is also the assertion that catches that being dropped.
  await page.click('.search-icon');
  await expect(page.locator('.search-input')).toBeFocused();

  // Polled, not measured once: `.search` animates its width over 200ms, so an
  // immediate read catches the field mid-open (26px on the first attempt at
  // writing this) and would fail for a reason that has nothing to do with the
  // rule being tested.
  await expect
    .poll(async () => (await searchWidths(page)).input, { message: 'wide enough to read a query' })
    .toBeGreaterThan(200);

  // Opening it must not push the primary action off the row, which is the
  // reason the field was pinned small in the first place.
  await expect(page.locator('[data-action=check-all]')).toBeInViewport();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no horizontal overflow with the search open').toBeLessThanOrEqual(0);

  await page.fill('.search-input', '');
});

test('the wide layout keeps the field it always had (NEWS-267)', async ({ page }) => {
  // The fix is scoped to the narrow layout; a regression that collapsed the
  // desktop search to an icon would be a different bug with the same shape.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/');
  const rest = await searchWidths(page);
  expect(rest.input, 'a real field at desktop width').toBeGreaterThan(80);
});

// Card and sidebar text layout (NEWS-112, NEWS-113). Both are CSS-only, both
// only misbehave once text is long enough to wrap, and neither is visible to any
// other test — so they are measured here.
//
// Every measurement below guards against its own vacuous pass by requiring a
// real height first. A row re-rendered by the 4 s poll reports a zero-size box
// for an instant, and an assertion like "height <= one line" is trivially true
// of zero (see NEWS-111, where exactly that shipped a test that guarded nothing).

const LONG_TOPIC = 'Apple (the company and their products, not the fruit)';

test('a relative timestamp never wraps (NEWS-112)', async ({ page }) => {
  // A long topic pill beside the timestamp squeezed it until "57m ago" broke
  // across two lines, reading as two facts rather than one.
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto('/');
  await page.fill('.add-topic input', LONG_TOPIC);
  await page.press('.add-topic input', 'Enter');
  await expect(page.locator('.item').first()).toBeVisible({ timeout: 15_000 });

  const time = page.locator('.item .item-time').first();
  const box = await time.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    lineHeight: parseFloat(getComputedStyle(el).lineHeight),
    // The pill next to it really is long enough to have caused the squeeze —
    // otherwise this test would pass on a card that never had the problem.
    pillWidth: el.parentElement?.querySelector('.item-topic')?.getBoundingClientRect().width ?? 0,
  }));

  expect(box.height, 'the timestamp should have been measured, not mid-render').toBeGreaterThan(5);
  expect(box.pillWidth, 'the topic pill should be long enough to crowd the timestamp').toBeGreaterThan(200);
  expect(box.height, 'the timestamp should be a single line').toBeLessThan(box.lineHeight * 1.6);
});

test('a source link’s arrow aligns with the first line, not the middle (NEWS-113)', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto('/');
  await expect(page.locator('.sources a').first()).toBeVisible({ timeout: 15_000 });

  // The mock's source titles are short, so the wrap is forced here rather than
  // faked in the app: the rule under test is where the arrow sits *once* a link
  // wraps, and this is the cheapest way to produce that condition honestly.
  await page.addStyleTag({ content: '.sources a { max-width: 60px; }' });

  const link = page.locator('.sources a').first();
  const m = await link.evaluate((el) => {
    const icon = el.querySelector('.icon');
    const linkBox = el.getBoundingClientRect();
    const iconBox = icon?.getBoundingClientRect();
    return {
      linkHeight: linkBox.height,
      iconHeight: iconBox?.height ?? 0,
      offsetFromTop: (iconBox?.top ?? 0) - linkBox.top,
    };
  });

  expect(m.iconHeight, 'the arrow should have been measured, not mid-render').toBeGreaterThan(5);
  expect(m.linkHeight, 'the link should have wrapped, or this asserts nothing').toBeGreaterThan(m.iconHeight * 2);

  // Compared against where *centring* would put it, rather than against a fixed
  // number of pixels. A fixed bound looked fine and wasn't: with a two-line
  // wrap, centred sits ~11px down and "less than the icon's 13px height" was
  // true of both layouts, so the test passed against the bug it was written for.
  const centred = (m.linkHeight - m.iconHeight) / 2;
  expect(m.offsetFromTop, 'the arrow should sit on the first line, not centred').toBeLessThan(centred * 0.6);
});

test('clean up the card-layout topic', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await resetSharedState(workerBaseURL());
  await page.goto('/');
  await expect(page.locator('.topic', { hasText: LONG_TOPIC })).toHaveCount(0);
});

// --- Sidebar chrome (NEWS-151) ---------------------------------------------

test('sidebar rows are separated by whitespace, not rules (NEWS-151)', async ({ page }) => {
  await page.goto('/');
  await page.fill('.add-topic input', 'Rule Free One');
  await page.press('.add-topic input', 'Enter');
  await page.fill('.add-topic input', 'Rule Free Two');
  await page.press('.add-topic input', 'Enter');
  await expect(page.locator('.topic', { hasText: 'Rule Free Two' })).toBeVisible();

  const rows = await page.locator('.topic').evaluateAll((els) =>
    els.map((el) => {
      const s = getComputedStyle(el);
      return {
        bottom: Number.parseFloat(s.borderBottomWidth),
        top: Number.parseFloat(s.borderTopWidth),
        gap: Number.parseFloat(s.marginBottom),
      };
    }),
  );

  expect(rows.length).toBeGreaterThan(1);
  for (const row of rows) {
    // A row is already a block of its own — name, timestamp, section pill — so a
    // hairline between every pair drew a ladder down the rail and competed with
    // the pill borders inside each row.
    expect(row.bottom).toBe(0);
    expect(row.top).toBe(0);
    // …but the rows still have to be told apart, and now only space does that.
    expect(row.gap).toBeGreaterThan(0);
  }

  for (const name of ['Rule Free One', 'Rule Free Two']) {
    await topicAction(page, page.locator('.topic', { hasText: name }), 'delete');
  }
});

test('the flag slot leaves the layout when it is empty (NEWS-152)', async ({ page }) => {
  // `min-width: 13px` plus the row's 10px flex gap reserved 23px of every row's
  // 320 for a star most topics don't have — 7% of the rail, taken from the topic
  // name, which is the one thing in the row that needs the width.
  await page.goto('/');
  // "empty" makes the mock provider return no stories (see the fixtures), which
  // this test needs as of NEWS-242: a topic that finds news today gets a count
  // badge, and a badge is something in the slot. A freshly added topic is
  // checked almost immediately, so without this the assertion below is a race
  // against that first check — it passed on a fast machine and failed on a
  // loaded one, which reads exactly like flake and is not.
  await page.fill('.add-topic input', 'Width Reclaimed empty');
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Width Reclaimed' });
  await expect(row).toBeVisible();

  const measure = async (): Promise<{ main: number; row: number; flags: string } | null> =>
    row.evaluate((el) => {
      const main = el.querySelector('.topic-main');
      const flags = el.querySelector('.topic-flags');
      if (!main || !flags) return null;
      return {
        main: main.getBoundingClientRect().width,
        row: el.getBoundingClientRect().width,
        flags: getComputedStyle(flags).display,
      };
    });

  const plain = await measure();
  expect(plain).not.toBeNull();
  expect(plain?.flags).toBe('none');
  // The name column should be within a dial's width of the whole row, not a
  // dial's width *plus* a slot standing empty.
  expect((plain?.main ?? 0) / (plain?.row ?? 1)).toBeGreaterThan(0.85);

  // …and the slot has to come back when there is something to put in it, or this
  // "fix" would simply have hidden the high-priority star.
  await topicAction(page, row, 'priority');
  await expect(row.locator('.flag.high-priority')).toBeVisible();
  const starred = await measure();
  expect(starred?.flags).not.toBe('none');
  // The name column keeps its full width **even with a badge showing**. This
  // originally asserted the opposite — that a badge narrows the name — because
  // the slot was a horizontal sibling and reappearing cost 23px. Since NEWS-163
  // it stacks under the dial, so a badge costs no width at all, which is this
  // ticket's intent carried further rather than a regression from it.
  expect(starred?.main).toBe(plain?.main);

  await topicAction(page, row, 'delete');
});

test('the dial sits on the first line, with badges stacked under it (NEWS-163)', async ({ page }) => {
  // Deliberately a name that **wraps**. On a single-line row the first line's
  // centre and the row's centre are the same point, so the old centred layout
  // and the new one agree — a one-line topic proves nothing here.
  const LONG = 'Apple (the company and their products) and adjacent supply chains';
  await page.goto('/');
  await page.fill('.add-topic input', LONG);
  await page.press('.add-topic input', 'Enter');
  const row = page.locator('.topic', { hasText: 'Apple (the company' });
  await expect(row).toBeVisible();

  await topicAction(page, row, 'priority');
  await expect(row.locator('.flag.high-priority')).toBeVisible();

  const m = await row.evaluate((el) => {
    const dial = el.querySelector('.dial svg');
    const name = el.querySelector('.topic-name');
    const flags = el.querySelector('.topic-flags');
    if (!dial || !name || !flags) return null;
    const range = document.createRange();
    range.selectNodeContents(name);
    const lines = [...range.getClientRects()];
    // Length, not a falsy check on `lines[0]`: the element type is non-nullable
    // here, so `!first` is dead code to the linter while still being a real
    // runtime possibility for an empty range.
    if (lines.length === 0) return null;
    const first = lines[0];
    const d = dial.getBoundingClientRect();
    const f = flags.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return {
      lines: lines.length,
      fromFirstLine: Math.abs(d.top + d.height / 2 - (first.top + first.height / 2)),
      aboveRowCentre: box.top + box.height / 2 - (d.top + d.height / 2),
      flagsBelow: f.top >= d.bottom,
      sameColumn: Math.abs(f.left + f.width / 2 - (d.left + d.width / 2)),
    };
  });
  expect(m).not.toBeNull();
  expect(m?.lines, 'the name must wrap, or this test asserts nothing').toBeGreaterThan(1);

  // On the first line's text, not on the top of its box.
  expect(m?.fromFirstLine ?? 99, 'dial vs first line').toBeLessThan(1.5);
  // …and demonstrably *not* where centring would put it. Without this the
  // assertion above would still pass on a one-line row and quietly stop testing
  // the thing that was wrong.
  expect(m?.aboveRowCentre ?? 0, 'dial should sit well above the row centre').toBeGreaterThan(10);

  // Badges stack under the dial rather than sitting at the far right edge,
  // where on a two-line title they were a long way from anything they described.
  expect(m?.flagsBelow).toBe(true);
  expect(m?.sameColumn ?? 99, 'badges share the dial column').toBeLessThan(1);

  await topicAction(page, row, 'delete');
});
