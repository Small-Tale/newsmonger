import type { FoundNewsItem } from './types.js';

/**
 * Normalize a URL for deduplication: lowercase host, strip `www.`, drop
 * query/hash, and trim a trailing slash. Returns null for unparseable URLs.
 */
export function normalizeUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const pathName = u.pathname.replace(/\/+$/, '');
    return `${host}${pathName}`;
  } catch {
    return null;
  }
}

/** Normalize a title for deduplication: lowercase, strip punctuation, collapse whitespace. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The dedupe key for a found item: the normalized URL of its first parseable
 * source, falling back to the normalized title.
 */
export function dedupeKeyFor(item: FoundNewsItem): string {
  for (const source of item.sources) {
    const normalized = normalizeUrl(source.url);
    if (normalized !== null) return `url:${normalized}`;
  }
  return `title:${normalizeTitle(item.title)}`;
}

/**
 * Drop found items whose dedupe key is already known, and de-duplicate within
 * the batch itself. Returns the surviving items paired with their keys.
 */
export function filterNewItems(
  found: FoundNewsItem[],
  existingKeys: ReadonlySet<string>,
): { item: FoundNewsItem; dedupeKey: string }[] {
  const seen = new Set(existingKeys);
  const result: { item: FoundNewsItem; dedupeKey: string }[] = [];
  for (const item of found) {
    const key = dedupeKeyFor(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ item, dedupeKey: key });
  }
  return result;
}
