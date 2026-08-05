import { AUTO_ORDER, type ProviderName } from '../ai/types.js';
import type { ProviderInfo } from '../api/schemas.js';

/**
 * What the Source tab's status line has to say (NEWS-308).
 *
 * The line used to render two spans and, on the default settings, put nothing in
 * either — leaving a blank row between the Effort field and the API keys rule.
 * The design review reported that twice without connecting the halves: as "90px
 * of unexplained empty space", and as "FR-3.1a's provider status line is not
 * visible". Same line. It was rendering; it just had nothing to render.
 *
 * The reason is `auto`, which is the default. `GET /api/providers` returns it
 * with `available: null` on purpose — the server cannot answer "is auto
 * available" without deciding which provider auto would pick — so the lookup
 * found a provider whose availability was `null` and the line stayed empty.
 *
 * `null` is the right answer for the *server*. It is not an answer a reader can
 * use, and the resolution auto would make is derivable from the probes already
 * on the page: `AUTO_ORDER`'s first available entry, which is exactly what
 * `resolveProvider` does server-side. So the client computes it rather than
 * printing a blank.
 *
 * Pure and separate from the JSX so the states are testable without a browser —
 * `unknown` in particular is a race (the tab can open before the probe answers)
 * and is unreachable from a rendered assertion.
 */

export type SourceStatus =
  /** Providers not probed yet. The tab can open before the request answers. */
  | { kind: 'unknown' }
  /** The selected provider is usable. `via` names it when the selection is `auto`. */
  | { kind: 'ready'; via: ProviderName | null }
  /** The selected provider is not usable. */
  | { kind: 'unavailable' }
  /** `auto` selected and nothing in `AUTO_ORDER` is usable. */
  | { kind: 'none-usable' };

/**
 * Read the status of the selected provider out of the probe results.
 *
 * Mirrors `resolveProvider`'s rule for `auto` — first available in `AUTO_ORDER`
 * — rather than inventing a second ordering. If the two ever disagree the line
 * would name a provider the next check does not use, which is worse than the
 * blank it replaces.
 */
export function sourceStatus(providers: ProviderInfo[], selected: ProviderName): SourceStatus {
  if (providers.length === 0) return { kind: 'unknown' };

  if (selected === 'auto') {
    for (const name of AUTO_ORDER) {
      if (providers.find((p) => p.name === name)?.available === true) return { kind: 'ready', via: name };
    }
    // Every entry probed and none usable — distinct from "not probed yet", and
    // the one case where the line has something urgent to say.
    const probed = AUTO_ORDER.every((name) => providers.find((p) => p.name === name)?.available !== undefined);
    return probed ? { kind: 'none-usable' } : { kind: 'unknown' };
  }

  const available = providers.find((p) => p.name === selected)?.available;
  if (available === true) return { kind: 'ready', via: null };
  if (available === false) return { kind: 'unavailable' };
  return { kind: 'unknown' };
}
