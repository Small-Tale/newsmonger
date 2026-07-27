import fs from 'node:fs';
import path from 'node:path';

import type { ModelPrice, PriceTable } from './price-schema.js';
import { PriceTableSchema } from './price-schema.js';
import { BUILTIN_PRICES, BUILTIN_PRICES_VERIFIED_ON } from './pricing.js';

/**
 * Runtime-updatable pricing (NEWS-93).
 *
 * Rates change often — introductory pricing ends, new models land, vendors
 * re-tier — and needing a new build to correct a number is the wrong shape for
 * something that moves on someone else's schedule. So the built-in table is a
 * **seed and a fallback**, not the source of truth:
 *
 * 1. `<data-dir>/prices.json` is the live table. It is written on first run
 *    from the built-ins and can be edited by hand at any time; edits are picked
 *    up on the next read, with no restart.
 * 2. If `settings.priceManifestUrl` is set, that URL is fetched at startup and
 *    daily, and its contents replace the file — so prices can be published
 *    centrally without shipping the app.
 *
 * Every layer falls back to the one beneath it. A missing file, unparseable
 * JSON, or an unreachable manifest costs the *update*, never the estimate.
 */

export type { ModelPrice, PriceTable };

export const PRICES_FILENAME = 'prices.json';

/** The compiled-in table, as a `PriceTable`. Used to seed the file and as the floor. */
export function builtinTable(): PriceTable {
  const models: Record<string, ModelPrice> = {};
  for (const [id, price] of Object.entries(BUILTIN_PRICES)) {
    if (price !== undefined) models[id] = price;
  }
  return {
    verifiedOn: BUILTIN_PRICES_VERIFIED_ON,
    sources: ['https://platform.claude.com/docs/en/about-claude/pricing'],
    models,
  };
}

/**
 * Reads `<data-dir>/prices.json`, caching on mtime so a hand edit is picked up
 * without a restart and without re-reading the file on every request.
 *
 * Seeds the file from the built-ins when it's absent, so there is always
 * something concrete for a user to open and edit rather than a format they'd
 * have to invent.
 */
export class PriceStore {
  private readonly filePath: string;
  private cached: PriceTable;
  private cachedMtimeMs = -1;

  constructor(private readonly dataDir: string) {
    this.filePath = path.join(dataDir, PRICES_FILENAME);
    this.cached = builtinTable();
    this.seedIfMissing();
  }

  private seedIfMissing(): void {
    try {
      if (!fs.existsSync(this.filePath)) this.write(builtinTable());
    } catch {
      // Read-only data dir, or a race with another process — the built-ins
      // still work, so this is not worth failing startup over.
    }
  }

  /** The live table. Re-reads the file only when it has actually changed. */
  table(): PriceTable {
    try {
      const mtimeMs = fs.statSync(this.filePath).mtimeMs;
      if (mtimeMs === this.cachedMtimeMs) return this.cached;
      const parsed = PriceTableSchema.safeParse(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
      this.cachedMtimeMs = mtimeMs;
      if (!parsed.success) {
        // A hand edit with a typo shouldn't silently switch every model to
        // "unknown" — say so and keep using the last good table.
        console.error(`news: ${PRICES_FILENAME} is not valid; keeping the previous prices`);
        return this.cached;
      }
      this.cached = parsed.data;
    } catch {
      // Missing or unreadable — the last good table (or the built-ins) stands.
    }
    return this.cached;
  }

  /** Replace the file's contents. Used by the manifest refresh. */
  write(table: PriceTable): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(table, null, 2));
    fs.renameSync(tmp, this.filePath);
    this.cachedMtimeMs = -1; // force a re-read on the next `table()`
  }
}

/**
 * Fetch a published price manifest and store it (NEWS-93).
 *
 * Returns whether anything was updated. Deliberately quiet on failure: an
 * unreachable manifest means the *update* didn't happen, which is a very
 * different thing from the prices being wrong, and it must never interrupt the
 * app. The URL is the user's own setting — not model output — so it does not go
 * through the SSRF vetting that model-supplied URLs do; it is checked only for
 * being https, so a plaintext manifest can't be swapped in transit.
 */
export async function refreshPricesFromManifest(
  store: PriceStore,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!url.startsWith('https://')) return false;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return false;
    const parsed = PriceTableSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.error('news: price manifest did not match the expected shape; keeping current prices');
      return false;
    }
    store.write(parsed.data);
    return true;
  } catch {
    return false;
  }
}
