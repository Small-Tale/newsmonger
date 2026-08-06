import { closeSettings, expect, openSettingsTab, resetSharedState,seedCheckedTopic, test, workerBaseURL } from './fixtures.js';

// Settings → Source: which provider does the searching, on what model, at what
// effort, and what it says about keys (NEWS-322 split this out of app.spec.ts).
//
// Seeds a checked topic because the status line reports the *last* check
// ("last check via mock"), which is not a thing settings can produce on its own.

test.describe.configure({ mode: 'serial' });

// Every attempt starts from a known server, including a serial retry — see
// `resetSharedState` (NEWS-101) and `seedCheckedTopic` (NEWS-322). No file
// inherits its precondition from another's leftovers (NEWS-313).
test.beforeAll(async () => {
  const baseURL = workerBaseURL();
  await resetSharedState(baseURL);
  await seedCheckedTopic(baseURL, 'Source Panel Topic');
});

test('the provider picker persists a choice across reload', async ({ page }) => {
  await page.goto('/');
  await openSettingsTab(page, 'Source');
  await expect(page.locator('[data-action=provider]')).toBeVisible();

  await page.selectOption('[data-action=provider]', 'openai');
  // OpenAI is endpoint-configurable, so the endpoint field appears.
  await expect(page.locator('[data-action=endpoint]')).toBeVisible();
  await page.reload();
  await openSettingsTab(page, 'Source');
  await expect(page.locator('[data-action=provider]')).toHaveValue('openai');

  // Reset to auto so later tests aren't affected. (Checks still run the mock
  // provider — the server is in --ai-test — regardless of this setting.)
  await page.selectOption('[data-action=provider]', 'auto');
  await expect(page.locator('[data-action=endpoint]')).toHaveCount(0);
  await closeSettings(page);
});

test('the Source panel reads provider, model, effort, then the notes (NEWS-256)', async ({ page }) => {
  // The order the settings are decided in — and, since NEWS-253/254, the order
  // they *depend* on each other: the provider decides which models are offered,
  // and the model decides which effort levels are. Asserted by position in the
  // document rather than by eye, since a reorder is exactly the kind of change
  // a later edit undoes without noticing.
  await page.goto('/');
  await openSettingsTab(page, 'Source');
  // A provider with a model field and an endpoint field, so the whole run is
  // present at once.
  await page.selectOption('[data-action=provider]', 'openai');
  await expect(page.locator('[data-action=model]')).toBeVisible();

  const order = await page.evaluate(() => {
    const panel = document.querySelector('#settings-panel');
    const at = (sel: string) => {
      const el = panel?.querySelector(sel);
      return el ? [...(panel?.querySelectorAll('*') ?? [])].indexOf(el) : -1;
    };
    return {
      provider: at('[data-action=provider]'),
      model: at('[data-action=model]'),
      effort: at('[data-action=effort]'),
      note: at('.effort-note'),
      status: at('.source-status'),
    };
  });

  expect(order.provider).toBeGreaterThan(-1);
  expect(order.model, 'model comes after provider').toBeGreaterThan(order.provider);
  expect(order.effort, 'effort comes after model').toBeGreaterThan(order.model);
  // Every explanation sits below the three controls, rather than interleaved.
  expect(order.note, 'the effort note is below the controls').toBeGreaterThan(order.effort);
  expect(order.status, 'the source status is below the controls').toBeGreaterThan(order.effort);

  await page.selectOption('[data-action=provider]', 'auto');
  await closeSettings(page);
});

test('the Source panel has no void below its controls (NEWS-308)', async ({ page }) => {
  // The design review reported "roughly 90px of empty space" between Effort and
  // the API keys rule, and separately that FR-3.1a's status line "is not
  // visible". One finding, not two: the line was rendering with both its spans
  // empty, because `auto` — the default — is reported by the server as
  // `available: null` and the old lookup had no branch for that.
  //
  // **The space was never the bug, which is why this asserts content and not
  // geometry.** `.source-status` carries `min-height: 1.2em`, so the blank row
  // occupied exactly the height the filled one does — measured at 66.5px before
  // and after the fix. A gap ceiling would have passed on the broken build. What
  // a reader met was an unexplained *void*, and "is anything written here" is
  // the only question that separates the two.
  await page.goto('/');
  await openSettingsTab(page, 'Source');
  await page.selectOption('[data-action=provider]', 'auto');

  // Which thing it says depends on what is signed in on this machine, so assert
  // that it is not blank rather than pinning the words. Verified against the
  // pre-fix build: this is the assertion that fails there.
  const status = page.locator('.source-status .source-state');
  await expect(status).not.toBeEmpty();

  const box = await page.evaluate(() => {
    const panel = document.querySelector('#settings-panel');
    const effort = panel?.querySelector('[data-action=effort]')?.closest('.field');
    // By name, not by position: since NEWS-307 the tab opens with a `Provider`
    // eyebrow, so the *first* one is above these controls rather than below them.
    const keys = [...(panel?.querySelectorAll('h3.eyebrow') ?? [])].find(
      (h) => h.textContent.trim() === 'API keys',
    );
    const line = panel?.querySelector('.source-status');
    if (!effort || !keys || !line) throw new Error('Source panel not rendered as expected');
    const spent = (sel: string): number => {
      const el = panel?.querySelector(sel);
      if (el === null || el === undefined) throw new Error(`${sel} must stay in the DOM`);
      const cs = getComputedStyle(el);
      return (
        el.getBoundingClientRect().height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom)
      );
    };
    return {
      lineTop: line.getBoundingClientRect().top,
      effortBottom: effort.getBoundingClientRect().bottom,
      keysTop: keys.getBoundingClientRect().top,
      fields: spent('.source-fields'),
      effortNote: spent('.effort-note'),
    };
  });

  // The filled line is *in* the band, so "not empty" cannot be satisfied by text
  // rendered somewhere else on the tab.
  expect(box.lineTop).toBeGreaterThan(box.effortBottom);
  expect(box.lineTop).toBeLessThan(box.keysTop);

  // A separate guard for a different regression, and measured per-container
  // rather than as a gap: the band's height legitimately varies with what the
  // status line says (once checks have run it also carries "last check via …",
  // which wraps at this width — 66px alone, 87px later in the suite). What must
  // not vary is these two. They are always-present containers holding nothing
  // here, collapsed by `:empty { display: none }`, and the first padding or
  // margin added to either would open a real hole with nothing naming the cause.
  expect(box.fields, '.source-fields must collapse when empty').toBe(0);
  expect(box.effortNote, '.effort-note must collapse when empty').toBe(0);
  // …and they must not be *deleted* to achieve that, which would reintroduce the
  // morph bugs docs/3-ui.md keeps them for.
  await expect(page.locator('.source-fields')).toHaveCount(1);
  await expect(page.locator('.effort-note')).toHaveCount(1);

  await closeSettings(page);
});

test('the effort dropdown persists, and is disabled only where it does nothing (NEWS-189)', async ({ page }) => {
  await page.goto('/');
  await openSettingsTab(page, 'Source');

  // Every real provider takes an effort parameter as of NEWS-245, so the only
  // one left disabled is the test-only `mock`. Disabled rather than hidden,
  // because a control that vanishes reads as a bug.
  await page.selectOption('[data-action=provider]', 'anthropic');
  const effort = page.locator('[data-action=effort]');
  await expect(effort).toBeEnabled();
  await expect(effort).toHaveValue('');

  await page.selectOption('[data-action=effort]', 'max');
  await page.reload();
  await openSettingsTab(page, 'Source');
  await expect(page.locator('[data-action=effort]')).toHaveValue('max');

  await page.selectOption('[data-action=provider]', 'mock');
  await expect(page.locator('[data-action=effort]')).toBeDisabled();

  // Reset for later tests, which build on this state.
  await page.selectOption('[data-action=provider]', 'anthropic');
  await page.selectOption('[data-action=effort]', '');
  await page.selectOption('[data-action=provider]', 'auto');
  await closeSettings(page);
});

test('the model field is a dropdown of models the provider actually has (NEWS-37, NEWS-253)', async ({ page }) => {
  await page.goto('/');
  await openSettingsTab(page, 'Source');
  await page.selectOption('[data-action=provider]', 'anthropic');

  // A `<select>` since NEWS-253, not the free-text combobox NEWS-37 shipped.
  // The suggestions were never the problem; a value the provider would reject
  // sitting in the field until the next check was.
  const model = page.locator('[data-action=model]');
  await expect(model).toHaveJSProperty('tagName', 'SELECT');
  await expect(page.locator('#model-suggestions')).toHaveCount(0);

  // Options track the provider — asserted as *change*, not as a model id. This
  // used to pin `claude-opus-4-8` and `gpt-5`, which made the test a second
  // copy of the hardcoded list it was checking: both went stale together and
  // the test's job became defending the staleness (NEWS-248).
  const options = page.locator('[data-action=model] option');
  await expect(options.first()).toHaveCount(1);
  const anthropicFirst = await options.first().getAttribute('value');
  expect(anthropicFirst, 'a provider must offer at least one model').toBeTruthy();

  await page.selectOption('[data-action=provider]', 'openai');
  await expect(options.first()).not.toHaveAttribute('value', anthropicFirst ?? '');
  expect(await options.first().getAttribute('value')).toBeTruthy();

  // Whatever is selected is one of the options — the property the dropdown
  // exists to guarantee, and the one the old field could not.
  const chosen = await model.inputValue();
  expect(await options.allTextContents()).toContain(chosen);

  // Reset so later tests see a clean provider config.
  await page.selectOption('[data-action=provider]', 'auto');
  await closeSettings(page);
});

test('whatever model is selected is one the provider offers (NEWS-253)', async ({ page }) => {
  // The guarantee the dropdown exists to make, and the one the old free-text
  // field could not: a model belonging to the provider you just left can no
  // longer sit in the control waiting to fail on the next check.
  //
  // Most of the *correction* — rewriting a stored model that belongs elsewhere
  // — needs a live catalogue to judge against, and `--ai-test` forces the mock
  // provider, so `/api/models` answers empty here and the picker falls back to
  // the static list. Those paths are unit-tested in `model-choice.test.ts`,
  // where the catalogue can be chosen. What is assertable here is the invariant
  // that holds either way, on every provider — and, since NEWS-278, the
  // cross-vendor case, which needs no catalogue and has its own test below.
  await page.goto('/');
  await openSettingsTab(page, 'Source');

  for (const provider of ['anthropic', 'openai', 'claude-cli', 'codex-cli']) {
    await page.selectOption('[data-action=provider]', provider);
    await expect(page.locator('[data-action=provider]')).toHaveValue(provider, { timeout: 15_000 });

    const model = page.locator('[data-action=model]');
    await expect(model).toHaveJSProperty('tagName', 'SELECT');
    const options = await page.locator('[data-action=model] option').allTextContents();
    expect(options.length, `${provider} must offer at least one model`).toBeGreaterThan(0);
    expect(options, `${provider}'s selection must be one of its own options`).toContain(await model.inputValue());
  }

  // Leave the shared server as later specs expect.
  await page.selectOption('[data-action=provider]', 'auto');
  await closeSettings(page);
});

test('switching vendor replaces the other vendor’s model (NEWS-278)', async ({ page }) => {
  // The reported flow exactly: on the ChatGPT (Codex) provider with a GPT model
  // chosen, switch to the Claude subscription. `gpt-5.4-mini` stayed selected
  // and listed above `opus`/`sonnet`/`haiku`/`fable`, and every check after that
  // would have failed.
  //
  // This one *is* assertable here, unlike the rest of the correction: Claude
  // Code publishes no catalogue by design (NEWS-243), which is why the old rule
  // had nothing to judge against — and why the new rule judges by vendor
  // instead, which needs no catalogue and so works under `--ai-test` too.
  await page.goto('/');
  await openSettingsTab(page, 'Source');

  await page.selectOption('[data-action=provider]', 'codex-cli');
  await expect(page.locator('[data-action=provider]')).toHaveValue('codex-cli', { timeout: 15_000 });
  await page.selectOption('[data-action=model]', 'gpt-5.4-mini');
  await expect(page.locator('[data-action=model]')).toHaveValue('gpt-5.4-mini');

  await page.selectOption('[data-action=provider]', 'claude-cli');
  await expect(page.locator('[data-action=provider]')).toHaveValue('claude-cli', { timeout: 15_000 });

  const model = page.locator('[data-action=model]');
  await expect(model, 'the small model of the vendor now selected').toHaveValue('haiku', { timeout: 15_000 });
  // And it is gone from the list, not merely deselected — `modelOptions` keeps
  // an unlisted *stored* value visible on purpose (FR-6.14), so the leftover
  // would still have been sitting at the top of the menu if only the selection
  // had moved.
  const options = await page.locator('[data-action=model] option').allTextContents();
  expect(options, 'the other vendor’s model is no longer offered').not.toContain('gpt-5.4-mini');

  // The correction settles: reopening the tab must not PATCH again, or every
  // provider refresh writes settings and each write triggers another refresh.
  await closeSettings(page);
  await openSettingsTab(page, 'Source');
  await expect(page.locator('[data-action=model]')).toHaveValue('haiku');

  await page.selectOption('[data-action=provider]', 'auto');
  await closeSettings(page);
});

test('the model picker asks the provider rather than a hardcoded list (NEWS-248)', async ({ page }) => {
  // The suggestions were a hand-written array that drifted two and a half
  // generations behind — offering `gpt-5` and `o3` while the current frontier
  // was `gpt-5.6-sol`. The picker now asks the configured provider.
  //
  // Under `--ai-test` the mock provider exposes no catalogue, so this asserts
  // the half that matters here: the route exists, answers 200 with a
  // well-formed body, and an empty answer degrades to the static suggestions
  // instead of an empty dropdown. The ranking itself is unit-tested against a
  // 131-entry catalogue captured from the live API.
  await page.goto('/');
  const res = await page.request.get('/api/models');
  expect(res.status()).toBe(200);
  // `effortLevels` rides along since NEWS-250 — the UI needs both to render one
  // control honestly, and they answer to the same resolved provider. `null`
  // rather than `[]` since NEWS-254: the mock provider has no opinion on effort,
  // which is a different statement from "this model refuses it", and only the
  // latter switches the control off.
  expect(await res.json()).toEqual({ models: [], effortLevels: null });

  await openSettingsTab(page, 'Source');
  await page.selectOption('[data-action=provider]', 'openai');
  // A provider that cannot enumerate must still leave a usable dropdown — it
  // falls back to the static list rather than showing nothing, which is why
  // `PROVIDER_MODELS` survives (NEWS-248) and matters more now that the field
  // is a `<select>` with no free text behind it (NEWS-253).
  const options = page.locator('[data-action=model] option');
  await expect(options.first()).toHaveCount(1);
  expect(await options.count()).toBeGreaterThan(0);

  // Leave the shared server on the mock provider for the specs that follow.
  await page.selectOption('[data-action=provider]', 'mock');
  await expect(page.locator('[data-action=provider]')).toHaveValue('mock', { timeout: 15_000 });
  await closeSettings(page);
});

test('a subscription provider never asks for an API key it does not use (NEWS-240/239)', async ({ page }) => {
  await page.goto('/');
  await openSettingsTab(page, 'Source');
  await page.locator('[data-action=provider]').selectOption('claude-cli');
  await expect(page.locator('[data-action=provider]')).toHaveValue('claude-cli', { timeout: 15_000 });

  // The status line must not say "no API key" for a provider that needs none —
  // it sat directly above a sentence saying checks use the subscription, so the
  // panel contradicted itself. What is actually wrong when a CLI provider is
  // unavailable is that the binary could not be run.
  const status = page.locator('.source-status');
  await expect(status).not.toContainText('no API key');

  // Effort IS available on the Claude subscription — `claude --effort <level>`
  // takes the same levels the API does (NEWS-239). It was disabled here on the
  // false premise that the CLI providers accept no such parameter, and reported
  // as "effort popup doesn't work — nothing pops up", which is exactly what a
  // disabled select looks like when nothing on the page says why.
  const effort = page.locator('[data-action=effort]');
  await expect(effort).toBeEnabled();
  await expect(page.locator('.effort-note')).toBeEmpty();

  // Codex takes one too (NEWS-244) — `-c model_reasoning_effort=<level>`, which
  // its `--help` never mentions because it rides the generic config override.
  // This spec asserted the opposite an hour ago, on the same reasoning that was
  // already wrong about Claude Code.
  await page.locator('[data-action=provider]').selectOption('codex-cli');
  await expect(page.locator('[data-action=provider]')).toHaveValue('codex-cli', { timeout: 15_000 });
  await expect(effort).toBeEnabled();
  await expect(page.locator('.effort-note')).toBeEmpty();

  // OpenAI takes one as well now (NEWS-245) — `reasoning.effort` on the
  // Responses API, sent and dropped again if the model turns out not to do
  // reasoning. So all four real providers are enabled, and this spec has now
  // asserted the opposite about three of them in turn.
  await page.locator('[data-action=provider]').selectOption('openai');
  await expect(effort).toBeEnabled();
  await expect(page.locator('.effort-note')).toBeEmpty();

  // `mock` is the only provider left that takes none — deterministic and
  // test-only, with no model to work harder — so the disabled state and its
  // explanation are asserted there.
  await page.locator('[data-action=provider]').selectOption('mock');
  await expect(page.locator('[data-action=provider]')).toHaveValue('mock', { timeout: 15_000 });
  await expect(effort).toBeDisabled();
  const note = page.locator('.effort-note');
  await expect(note).toContainText('takes no effort setting');

  // And it must *look* disabled (NEWS-239, reopened). Styling these controls
  // removes the browser's own greying, so `disabled` alone renders identically
  // to a live field — which invites the click it cannot answer. Reported as
  // "still doesn't work and also doesn't look disabled" on a build that already
  // carried the explanatory note: the note was there, the control just didn't
  // look inert, so it read as broken rather than as switched off.
  const off = await effort.evaluate((el) => {
    const c = getComputedStyle(el);
    return { opacity: Number(c.opacity), cursor: c.cursor };
  });
  expect(off.opacity, 'a disabled control must be visibly dimmed').toBeLessThan(1);
  expect(off.cursor).toBe('not-allowed');

  // ...and it goes away when the setting does apply.
  await page.locator('[data-action=provider]').selectOption('anthropic');
  await expect(effort).toBeEnabled();
  await expect(page.locator('.effort-note')).toBeEmpty();
  // Full opacity when it works — otherwise "dimmed" would mean nothing.
  expect(await effort.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);

  // Leave the shared server on the mock provider for the specs that follow.
  await page.locator('[data-action=provider]').selectOption('mock');
  await expect(page.locator('[data-action=provider]')).toHaveValue('mock', { timeout: 15_000 });
});

