import type { CatalogueModel } from '../model-list.js';
import type { Effort } from '../types.js';
import { toEffortLevels } from '../types.js';

/**
 * Reading Anthropic's model catalogue (NEWS-251).
 *
 * `GET /v1/models` carries more than names, and two fields matter here:
 *
 * - **`created_at`** — an RFC 3339 datetime, *not* the epoch seconds OpenAI
 *   uses. `rankModels` sorts on a number, so it is converted rather than
 *   `rankModels` being taught about two formats: the ranking stays vendor-
 *   agnostic, which is the property that makes it immune to model naming.
 * - **`capabilities.effort`** — which effort levels *this model* accepts,
 *   the same per-model fact Codex keeps in its cache (NEWS-250). Anthropic
 *   declares `low`, `medium`, `high`, `max` and a nullable `xhigh`, each a
 *   `{ supported: boolean }`, plus a top-level `supported` for "does this model
 *   do effort at all".
 *
 * Parsing is separated from the SDK call so the shape can be tested without a
 * key — and it is deliberately defensive about a payload it does not own, the
 * same way `codex-models.ts` is. A catalogue this app cannot fetch must degrade
 * to the static suggestions, never to an error.
 *
 * **Honest caveat**: there is no Anthropic key on this machine, so the field
 * names and types below come from the SDK's own generated declarations rather
 * than from a captured response. That is a better source than memory — it is
 * generated from Anthropic's spec, and in NEWS-250 the same declarations
 * settled a question I had wrongly written off as unanswerable — but it is not
 * the live payload, and the tests say which is which.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Pull the `data` array out of a page, however it is handed over. */
function entries(page: unknown): Record<string, unknown>[] {
  if (Array.isArray(page)) return page.filter(isRecord);
  if (isRecord(page) && Array.isArray(page['data'])) return page['data'].filter(isRecord);
  return [];
}

/**
 * Catalogue entries in the shape `rankModels` consumes.
 *
 * `created_at` is converted to epoch seconds. An unparseable or missing date
 * yields no `created`, which `rankModels` sorts last — the model is still
 * offered, because a date this app cannot read is not evidence the model is
 * bad.
 */
export function parseAnthropicModels(page: unknown): CatalogueModel[] {
  return entries(page)
    .filter((m) => typeof m['id'] === 'string' && m['id'] !== '')
    .map((m) => {
      const at = typeof m['created_at'] === 'string' ? Date.parse(m['created_at']) : NaN;
      return { id: m['id'] as string, ...(Number.isNaN(at) ? {} : { created: Math.floor(at / 1000) }) };
    });
}

/**
 * The effort levels one model accepts, from its declared capabilities.
 *
 * `[]` means "no answer" — the model is unknown, the payload has no
 * capabilities, or `effort.supported` is false — and the caller falls back to
 * the provider's union rather than offering nothing.
 */
export function parseAnthropicEfforts(page: unknown, model: string): Effort[] {
  const found = entries(page).find((m) => m['id'] === model);
  const caps = found?.['capabilities'];
  if (!isRecord(caps)) return [];
  const effort = caps['effort'];
  if (!isRecord(effort) || effort['supported'] === false) return [];
  const supported = Object.entries(effort)
    .filter(([, v]) => isRecord(v) && v['supported'] === true)
    .map(([k]) => k);
  return toEffortLevels(supported);
}
