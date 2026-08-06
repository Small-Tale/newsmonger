import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

/**
 * The models Codex offers **on this machine** (NEWS-249).
 *
 * Codex's catalogue is not OpenAI's. It serves models `GET /v1/models` never
 * lists (`gpt-5.3-codex-spark`) and refuses ones the API serves happily — every
 * non-reasoning model answers *"not supported when using Codex with a ChatGPT
 * account"*. So the API catalogue cannot stand in for it, and the CLI exposes no
 * command that prints it: not `--help`, not `doctor`, not `features`, and an
 * invalid `-m` reports only that the model is unsupported without naming any
 * that are.
 *
 * It does keep one on disk. `~/.codex/models_cache.json` is what the TUI's own
 * picker reads, refreshed by the CLI against the user's account, and it carries
 * more than names: `visibility`, `priority`, and the reasoning levels each model
 * accepts. Reading it means the app offers exactly what that user's Codex
 * offers — including entitlements this machine has and another might not.
 *
 * Read-only, and treated as somebody else's file: any shape that is not what we
 * expect yields no models rather than an error, and the picker falls back to the
 * static list. A cache we do not own is allowed to change without breaking a
 * dropdown.
 */

/** Where the Codex CLI keeps its catalogue. `CODEX_HOME` moves the whole dir. */
export function codexModelsCachePath(home: string = os.homedir()): string {
  const codexHome = process.env['CODEX_HOME'];
  return path.join(codexHome !== undefined && codexHome !== '' ? codexHome : path.join(home, '.codex'), 'models_cache.json');
}

/**
 * One entry, narrowed to the fields this app uses (NEWS-360).
 *
 * **Validated, not asserted.** This was an `interface` plus
 * `as unknown as CachedModel[]`, which told TypeScript the shape without
 * checking it — and this file reads `~/.codex/models_cache.json`, a file the
 * *vendor* writes and has already changed twice under us (NEWS-272/274). With
 * the cast in place, `supported_reasoning_levels` arriving as an object rather
 * than an array sailed past `?? []` and threw `.map is not a function`; a
 * `priority` arriving as a string made the sort comparator return `NaN`, which
 * does not fail, it just orders arbitrarily.
 *
 * Every field is optional and `.catch`-ed to a safe value, so a shape we have
 * never seen degrades to "no models" or "no levels" — the behaviour the module
 * doc already promised — instead of throwing.
 */
const CachedModelSchema = z.object({
  slug: z.string().catch(''),
  /** `list` shows it in a picker; `hide` is internal (e.g. `codex-auto-review`). */
  visibility: z.string().optional().catch(undefined),
  /** Codex's own ordering — 1 is the model it puts first. */
  priority: z.number().optional().catch(undefined),
  /** Effort levels this model accepts, which vary per model. */
  supported_reasoning_levels: z
    .array(z.object({ effort: z.string().optional().catch(undefined) }).catch({ effort: undefined }))
    .optional()
    .catch(undefined),
});

type CachedModel = z.infer<typeof CachedModelSchema>;

/**
 * Every entry the cache holds, in file order.
 *
 * Per-entry rather than whole-array parsing on purpose: one malformed model
 * must not cost the user the rest of their catalogue, which is what a single
 * `z.array(...)` parse would do.
 */
function cachedModels(body: unknown): CachedModel[] {
  const outer = z.object({ models: z.array(z.unknown()) }).safeParse(body);
  if (!outer.success) return [];
  return outer.data.models.flatMap((m) => {
    const parsed = CachedModelSchema.safeParse(m);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Parse a cache body into the models worth offering.
 *
 * Split from the file read so it can be tested against a real captured cache
 * without one being present — and so a malformed file is a data case rather
 * than an I/O one.
 *
 * **`visibility: 'hide'` is honoured**, which is not cosmetic: `codex-auto-review`
 * is an internal model Codex lists for its own use, and offering it as a news
 * provider would be offering something that was never meant to be chosen.
 */
export function parseCodexModels(body: unknown): string[] {
  return cachedModels(body)
    .filter((m) => m.slug !== '')
    .filter((m) => m.visibility !== 'hide')
    .slice()
    // Codex's own `priority`, so the app agrees with the CLI about what comes
    // first rather than inventing a second opinion. Ties keep file order, which
    // is Codex's too. Anything unranked sorts last.
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
    .map((m) => m.slug);
}

/** The effort levels a given cached model accepts, or `[]` if unknown. */
export function parseCodexEfforts(body: unknown, slug: string): string[] {
  const found = cachedModels(body).find((m) => m.slug === slug);
  return (found?.supported_reasoning_levels ?? [])
    .map((l) => l.effort)
    .filter((e): e is string => typeof e === 'string' && e !== '');
}

/**
 * The effort levels a Codex model accepts, read from the same cache.
 *
 * A **subset** of the truth, and knowingly so: asking `gpt-5.4` for a level it
 * refuses produced *"Supported values are: 'none', 'low', 'medium', 'high', and
 * 'xhigh'"* — the API allows `none`, which the cache's
 * `supported_reasoning_levels` does not list. Erring narrow is the right
 * direction here, because the cost of offering one level too few is a missing
 * option and the cost of one too many is a failed check.
 *
 * An empty or unknown `model` yields the union across every listed model: which
 * model Codex will pick is not known until it runs.
 */
export function readCodexEfforts(model: string, file: string = codexModelsCachePath()): string[] {
  // The `try` wraps the **parse as well as the read** (NEWS-360). It used to
  // close after `JSON.parse`, leaving the two `parseCodexEfforts` calls outside
  // it — so a cache whose shape we did not expect threw out of this function
  // while its sibling `readCodexModels`, whose try wraps both, returned `[]`.
  // Two readers of the same vendor file disagreeing about that is the bug.
  try {
    const body: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (model !== '') return parseCodexEfforts(body, model);
    const union = new Set<string>();
    for (const slug of parseCodexModels(body)) for (const e of parseCodexEfforts(body, slug)) union.add(e);
    return [...union];
  } catch {
    return [];
  }
}

/** Read and parse the cache. `[]` when it is absent, unreadable or unexpected. */
export function readCodexModels(file: string = codexModelsCachePath()): string[] {
  try {
    return parseCodexModels(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch {
    // Not installed, never run, or a shape we don't recognise. The picker falls
    // back to the static suggestions; none of that is worth an error.
    return [];
  }
}
