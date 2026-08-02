import type { Effort } from '../ai/types.js';
import { EFFORT_LEVELS } from '../ai/types.js';

/**
 * Which effort levels the Settings control should offer (NEWS-250).
 *
 * The levels a check can actually use narrow with the **model**, not just the
 * provider: on Codex `gpt-5.6-sol` takes `ultra` and `gpt-5.4` does not. That
 * is not cosmetic — asking for one a model refuses fails the check outright:
 *
 *   400 unsupported_value  param "reasoning.effort"
 *   "Unsupported value: 'max' is not supported with the 'gpt-5.4-…' model."
 *
 * So `EFFORT_LEVELS` is the vocabulary and this decides the menu. Pure and
 * separate from `app.tsx` for the same reason `poll.ts` and `select-sync.ts`
 * are: a rule with this many edges should be tested by choosing its inputs, not
 * by driving a browser to the right state.
 */

/** The server's answer, as the client holds it. */
export interface EffortChoice {
  /** Levels the resolved provider and model accept. Empty = could not ask. */
  liveEffortLevels: readonly Effort[];
  /** The level currently saved in settings. */
  chosen: Effort;
}

/**
 * Whether this level is usable with the current provider and model.
 *
 * An empty `liveEffortLevels` means the server could not ask — no key, or a
 * provider that cannot say — and then everything counts as supported. A control
 * that greys out every option because a lookup failed is worse than one that
 * offers too much, especially when the providers that cannot answer are exactly
 * the ones where the old global list was already the best available guess.
 */
export function effortSupported(state: EffortChoice, level: Effort): boolean {
  return state.liveEffortLevels.length === 0 || level === '' || state.liveEffortLevels.includes(level);
}

/**
 * The options to render: what this model takes, plus the saved level if it
 * doesn't take it.
 *
 * Keeping an unsupported saved level **visible** is deliberate. Dropping it
 * would leave the `<select>` showing a value absent from its own options — the
 * control silently misreporting what is stored, which is the exact class of bug
 * NEWS-238 was — and silently rewriting the setting to tidy the menu would be
 * worse: the user picked that, and switching model is not consent to change it.
 * It is shown, labelled unsupported by the caller, and left for them to decide.
 */
export function effortOptions(state: EffortChoice): Effort[] {
  const supported = EFFORT_LEVELS.filter((l) => effortSupported(state, l));
  return supported.includes(state.chosen) ? supported : [...supported, state.chosen];
}
