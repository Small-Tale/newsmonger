import type { ProviderName } from '../ai/types.js';

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
 * The model to switch to when the provider changes, or `null` to leave it be.
 *
 * Three rules, and the middle one is where the care is:
 *
 * 1. **Nothing chosen gets filled in**, from the live catalogue or the static
 *    fallback. `''` is a storable state the dropdown cannot represent, so
 *    leaving it would make the control display its first option while the
 *    setting said "provider default" — a control lying about what is stored,
 *    which is precisely what NEWS-238 turned out to be.
 * 2. **A real choice is only overruled against a *live* catalogue.** The static
 *    fallback is four entries long and could never contain a gateway's own
 *    model id, so correcting against it would clobber exactly the setting the
 *    free-text field existed for. No live list means no opinion.
 * 3. **A valid choice is never touched.** Switching provider is not consent to
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
  // A real choice is only overruled against a **live** catalogue. The static
  // fallback is four entries long and could never contain a gateway's own model
  // id, so correcting against it would clobber exactly the setting the free-text
  // field used to exist for.
  if (live.length === 0 || live.includes(current)) return null;
  const next = preferredModel(provider, live);
  return next === '' || next === current ? null : next;
}
