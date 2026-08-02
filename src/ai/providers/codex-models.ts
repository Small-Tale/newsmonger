import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/** One entry, narrowed to the fields this app uses. */
interface CachedModel {
  slug: string;
  /** `list` shows it in a picker; `hide` is internal (e.g. `codex-auto-review`). */
  visibility?: string;
  /** Codex's own ordering — 1 is the model it puts first. */
  priority?: number;
  /** Effort levels this model accepts, which vary per model. */
  supported_reasoning_levels?: { effort?: string }[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
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
  if (!isRecord(body) || !Array.isArray(body['models'])) return [];
  const models = body['models'].filter(isRecord) as unknown as CachedModel[];
  return models
    .filter((m) => typeof m.slug === 'string' && m.slug !== '')
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
  if (!isRecord(body) || !Array.isArray(body['models'])) return [];
  const found = (body['models'].filter(isRecord) as unknown as CachedModel[]).find((m) => m.slug === slug);
  return (found?.supported_reasoning_levels ?? [])
    .map((l) => l.effort)
    .filter((e): e is string => typeof e === 'string' && e !== '');
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
