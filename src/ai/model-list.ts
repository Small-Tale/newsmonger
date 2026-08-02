/**
 * Turn a vendor's raw model catalogue into a picker's worth of suggestions
 * (NEWS-248).
 *
 * The suggestions used to be a hardcoded array per provider, and they went
 * stale exactly as fast as the vendors ship: the OpenAI list offered `gpt-5`
 * and `o3` while the current frontier was `gpt-5.6-sol`. NEWS-243 fixed the
 * same problem for the Claude CLI by switching to **aliases**, which cannot go
 * stale because the vendor resolves them — but OpenAI has no aliases, so the
 * list has to come from the vendor instead of from us.
 *
 * It can: `GET /v1/models` carries a `created` timestamp per model, so the
 * newest can be found **without parsing a single model name**. That matters
 * more than it sounds. Every previous attempt at this problem in this codebase
 * failed by encoding knowledge about *which* models exist; sorting on a field
 * the vendor maintains encodes none.
 *
 * Pure and vendor-agnostic so it can be tested against a real catalogue without
 * a key — the fixture in `model-list.test.ts` is 131 real entries.
 */

/** One entry from a vendor's model list. `created` is epoch **seconds**. */
export interface CatalogueModel {
  id: string;
  created?: number;
}

/**
 * Families that are not text models, matched as substrings of the id.
 *
 * **An exception list, not an allow-list**, and that is the whole design. An
 * allow-list of "good" families would go stale precisely like the array this
 * replaces — a model released tomorrow would be missing from the picker, which
 * is the failure nobody notices. This way tomorrow's model appears on its own
 * and the worst case is a stray image model in a dropdown, which anyone can
 * see and ignore. Same reasoning as `usesLegacyRequestShape` (NEWS-132) and the
 * effort retry (NEWS-245).
 */
const NON_TEXT_FAMILIES = [
  'transcribe',
  'realtime',
  'whisper',
  'tts',
  'dall-e',
  'sora',
  'embedding',
  'moderation',
  'audio',
  'image',
  'computer-use',
  // Pre-chat completion models. Present on long-lived keys, useless here.
  'babbage',
  'davinci',
] as const;

/**
 * A dated snapshot id: `gpt-5.4-2026-03-05` beside the `gpt-5.4` that tracks it.
 *
 * Dropped because offering both doubles the list while saying nothing new — the
 * undated id *is* the pointer to the newest snapshot. Anyone who wants to pin a
 * specific date can still type it: the field is free text, exactly as it is for
 * the Claude aliases.
 */
const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

/** Default number of suggestions. A dropdown, not a catalogue. */
export const MODEL_SUGGESTION_LIMIT = 20;

/**
 * Rank a raw catalogue into suggestions: newest first, noise removed.
 *
 * Models without a `created` timestamp sort last rather than being dropped —
 * absent metadata is not evidence the model is bad, and this file exists
 * because guessing from names is what kept going wrong.
 */
export function rankModels(models: CatalogueModel[], limit: number = MODEL_SUGGESTION_LIMIT): string[] {
  return models
    .filter((m) => !NON_TEXT_FAMILIES.some((f) => m.id.includes(f)))
    .filter((m) => !DATED_SNAPSHOT.test(m.id))
    .slice()
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((m) => m.id)
    .slice(0, limit);
}
