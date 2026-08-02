import type { Effort } from '../ai/types.js';
import { EFFORT_LEVELS } from '../ai/types.js';

/**
 * Which effort levels the Settings control offers, and whether it is usable at
 * all (NEWS-250, tightened in NEWS-254).
 *
 * The levels a check can actually use narrow with the **model**, not just the
 * provider: on Codex `gpt-5.6-sol` takes `ultra` and `gpt-5.4` does not, and
 * `claude-haiku-4-5` takes none whatsoever. That is not cosmetic — asking for
 * one a model refuses fails the check outright:
 *
 *   400 unsupported_value  param "reasoning.effort"
 *   "Unsupported value: 'max' is not supported with the 'gpt-5.4-…' model."
 *
 * So `EFFORT_LEVELS` is the vocabulary and this decides the menu. Pure and
 * separate from `app.tsx` for the same reason `poll.ts`, `select-sync.ts` and
 * `model-choice.ts` are: a rule with this many edges should be tested by
 * choosing its inputs, not by driving a browser to the right state.
 */

/** The server's answer, as the client holds it. */
export interface EffortChoice {
  /**
   * Levels the resolved provider and model accept.
   *
   * **Three states.** A list is what to offer. `null` is *could not ask* — no
   * key, nothing resolvable — and everything is offered, because a control that
   * greys out over a lookup failure is worse than one offering too much. `[]`
   * is a different statement: *this model accepts no effort*, and the control
   * switches off.
   *
   * Those last two were one value until NEWS-254, which is how the menu came to
   * offer every level on a model that takes none.
   */
  liveEffortLevels: readonly Effort[] | null;
  /** The level currently saved in settings. */
  chosen: Effort;
}

/** Whether the chosen provider and model accept any effort level at all. */
export function effortAvailable(state: EffortChoice): boolean {
  return state.liveEffortLevels === null || state.liveEffortLevels.length > 0;
}

/** Whether this specific level is usable with the current provider and model. */
export function effortSupported(state: EffortChoice, level: Effort): boolean {
  if (state.liveEffortLevels === null) return true;
  // `''` is "send nothing", which every provider accepts by construction — and
  // it is the only option left when a model takes none, so the control still
  // has something honest to display while disabled.
  return level === '' || state.liveEffortLevels.includes(level);
}

/**
 * The options to render.
 *
 * **Only valid levels** since NEWS-254. That ticket revisited a deliberate
 * NEWS-250 decision — an unsupported *saved* level used to stay visible,
 * labelled — on the grounds that hiding it left the `<select>` showing a value
 * absent from its own options, which is a control misreporting what is stored.
 *
 * The tension dissolves because the value no longer *stays* invalid:
 * `correctedEffort` moves it as soon as the model changes, so an invalid stored
 * level is transient rather than a state the UI has to render. If it were
 * merely hidden while settings still held it, the next check would send it and
 * fail — trading a visible oddity for an invisible one.
 */
export function effortOptions(state: EffortChoice): Effort[] {
  return EFFORT_LEVELS.filter((l) => effortSupported(state, l));
}

/**
 * The level to fall back to when the current one is not usable, or `null` to
 * leave it alone.
 *
 * Always `''` — "provider default" — rather than a guess at an equivalent.
 * There is no honest mapping from `ultra` on Codex to anything on Anthropic,
 * and silently substituting a *different* amount of thinking is a worse liberty
 * than declining to choose. `''` is valid everywhere and visibly means "I did
 * not pick one".
 *
 * Returns `null` when the answer is unknown (`liveEffortLevels === null`), for
 * the same reason `correctedModel` does: a lookup failure must not clobber a
 * working setting.
 */
export function correctedEffort(state: EffortChoice): Effort | null {
  if (state.liveEffortLevels === null) return null;
  if (state.chosen === '' || effortSupported(state, state.chosen)) return null;
  return '';
}
