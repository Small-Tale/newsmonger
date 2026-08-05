import { PROVIDER_INFO, PROVIDER_MODELS, type ProviderName } from '../ai/types.js';

/**
 * Which model the picker offers, and which one it falls back to (NEWS-253).
 *
 * The model field used to be free text with suggestions, so "is this model
 * valid here" was never asked — a model left over from another provider simply
 * failed on the next check. Now the control is a real `<select>`, which means
 * something has to decide what belongs in it and what to do when the stored
 * value does not.
 *
 * Pure and separate from `app.tsx` for the same reason `poll.ts`,
 * `select-sync.ts` and `effort-options.ts` are: these are rules with edges —
 * an unknown catalogue, a model from a gateway, a provider that changed under
 * a stored value — and edges are cheaper to test by choosing inputs than by
 * driving a browser into each one.
 */

/**
 * The **small** model each provider family should default to (NEWS-253):
 * Haiku on the Claude paths, the mini on the OpenAI ones.
 *
 * Matched by name, which this codebase has otherwise spent real effort getting
 * away from — NEWS-243 replaced a stale hardcoded list with aliases, NEWS-248
 * replaced another with a catalogue sorted on the vendor's own timestamp.
 *
 * The difference is that "the newest model" was never a naming question and
 * this one is: *the Haiku one* has no other definition. So the match is on a
 * family token rather than a version, which cannot go stale the way
 * `claude-opus-4-8` did — `haiku` picks whatever the newest Haiku is — and it
 * falls back to the newest model when nothing matches, so an unfamiliar
 * catalogue (a gateway, a future naming scheme) still yields a usable answer
 * instead of nothing.
 */
const PREFERRED_FAMILY: Partial<Record<ProviderName, string>> = {
  anthropic: 'haiku',
  'claude-cli': 'haiku',
  openai: 'mini',
  'codex-cli': 'mini',
};

/**
 * The model to select when nothing valid is chosen.
 *
 * `catalogue` is newest-first (`rankModels`, and Codex's own `priority`), so
 * the first token match *is* the most recent of that family. Empty when there
 * is no catalogue to choose from — the caller then leaves the setting alone
 * rather than inventing one.
 */
export function preferredModel(provider: ProviderName, catalogue: readonly string[]): string {
  const family = PREFERRED_FAMILY[provider];
  const match = family === undefined ? undefined : catalogue.find((m) => m.toLowerCase().includes(family));
  // `catalogue[0]` is typed non-optional without `noUncheckedIndexedAccess`, so
  // the empty case is guarded here rather than by a `??` the linter can see is
  // dead.
  if (match !== undefined) return match;
  return catalogue.length > 0 ? catalogue[0] : '';
}

/**
 * The options to render.
 *
 * **`current` is always included, even when the catalogue does not list it**,
 * and that is the whole concession this change makes to what it takes away.
 * The field was free text on purpose (FR-6.14): an OpenAI-compatible gateway
 * reached through `OPENAI_BASE_URL` may serve models this app cannot enumerate,
 * and a model can be newer than whatever the catalogue returned. A strict
 * `<select>` removes that escape hatch — but it must not *silently discard a
 * setting someone already has*, which is what dropping an unlisted value would
 * do the moment they opened Settings.
 *
 * So an unlisted stored model stays selectable and stays selected. It cannot be
 * re-typed once changed away from, which is the real cost of the dropdown and
 * is worth knowing rather than discovering.
 */
export function modelOptions(catalogue: readonly string[], current: string): string[] {
  if (current === '' || catalogue.includes(current)) return [...catalogue];
  // First, so a value the app doesn't recognise is visible rather than buried
  // at the end of twenty suggestions.
  return [current, ...catalogue];
}

/**
 * Which vendor actually serves a provider (NEWS-278).
 *
 * `claude-cli` and `anthropic` are two routes to Anthropic's models; `codex-cli`
 * and `openai` are two routes to OpenAI's. Switching *within* a family leaves a
 * stored model usable — `claude --model` takes a full name as well as an alias —
 * so the pairing is what separates "a leftover that cannot possibly work" from
 * "a valid choice reached by another road".
 */
const VENDOR: Partial<Record<ProviderName, string>> = {
  'claude-cli': 'anthropic',
  anthropic: 'anthropic',
  'codex-cli': 'openai',
  openai: 'openai',
};

/**
 * The vendor whose static catalogue lists this model, or `null` if none does.
 *
 * `null` is the important answer: a model no provider lists is the gateway case
 * FR-6.14 exists for, and nothing here may touch it.
 */
function vendorOfModel(model: string): string | null {
  for (const [name, models] of Object.entries(PROVIDER_MODELS)) {
    if (models.includes(model)) return VENDOR[name as ProviderName] ?? null;
  }
  return null;
}

/**
 * The model to switch to when the provider changes, or `null` to leave it be.
 *
 * Four rules, and the middle two are where the care is:
 *
 * 1. **Nothing chosen gets filled in**, from the live catalogue or the static
 *    fallback. `''` is a storable state the dropdown cannot represent, so
 *    leaving it would make the control display its first option while the
 *    setting said "provider default" — a control lying about what is stored,
 *    which is precisely what NEWS-238 turned out to be.
 * 2. **Another vendor's model is replaced, catalogue or no catalogue**
 *    (NEWS-278). Switching Codex → Claude left `gpt-5.4-mini` selected and
 *    listed among `opus`/`sonnet`/`haiku`/`fable`, because rule 3 below found no
 *    live catalogue to judge against — Claude Code publishes none, by design
 *    (NEWS-243: it takes aliases the vendor resolves). But no catalogue is
 *    needed to know a *GPT* model will not run on a Claude subscription. This
 *    fires only when some other provider's own list names the model, so an
 *    unrecognised id is still nobody's business but the user's, and only when
 *    the target provider is **not** endpoint-configurable — an OpenAI-compatible
 *    gateway can serve anything, which is the whole reason rule 3 is cautious.
 * 3. **Otherwise a real choice is only overruled against a *live* catalogue.**
 *    The static fallback is four entries long and could never contain a
 *    gateway's own model id, so correcting against it would clobber exactly the
 *    setting the free-text field existed for. No live list means no opinion.
 * 4. **A valid choice is never touched.** Switching provider is not consent to
 *    change a model that still works; silently "helping" is the failure mode of
 *    automatic correction.
 */
export function correctedModel(
  provider: ProviderName,
  current: string,
  live: readonly string[],
  fallback: readonly string[] = [],
): string | null {
  // Nothing chosen: fill it in from whatever list is available, live or static.
  // No user choice can be destroyed here, and leaving it empty is not an option
  // — `''` is a storable state the dropdown cannot represent, so the control
  // would show its first option while the setting said something else. That is
  // a control lying about what is stored, which is exactly what NEWS-238 was.
  if (current === '') {
    const next = preferredModel(provider, live.length > 0 ? live : fallback);
    return next === '' ? null : next;
  }
  // Another vendor's model, named by that vendor's own catalogue: demonstrably
  // unusable here, so it goes whether or not a live list exists (NEWS-278).
  const here = VENDOR[provider];
  const there = vendorOfModel(current);
  if (
    here !== undefined &&
    there !== null &&
    there !== here &&
    !PROVIDER_INFO[provider].endpointConfigurable &&
    !live.includes(current)
  ) {
    const next = preferredModel(provider, live.length > 0 ? live : fallback);
    if (next !== '' && next !== current) return next;
  }

  // Otherwise a real choice is only overruled against a **live** catalogue. The
  // static fallback is four entries long and could never contain a gateway's own
  // model id, so correcting against it would clobber exactly the setting the
  // free-text field used to exist for.
  if (live.length === 0 || live.includes(current)) return null;
  const next = preferredModel(provider, live);
  return next === '' || next === current ? null : next;
}
