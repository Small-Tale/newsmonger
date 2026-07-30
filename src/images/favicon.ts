/**
 * Find a source's favicon, so a feed link can wear its publisher's mark
 * (NEWS-169).
 *
 * Deliberately keyed on the **origin**, not the article. A favicon belongs to a
 * site, not a page: one outlet cited by six stories is one icon, and the same
 * outlets recur on every check. Resolving per article would multiply requests
 * by roughly the number of stories for no additional information.
 *
 * The contrast with the lead image (`ogimage.ts`) is the reason this exists at
 * all: `og:image` is **absent about a third of the time** (FR-8.2, measured
 * against live sites), whereas a favicon is near-universal and a couple of
 * kilobytes. It is the more reliable visual signal for attribution.
 */

/** `rel` values that name a site icon, best first. */
const ICON_RELS = ['icon', 'shortcut icon', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon'];

/** Only the head matters, and stopping there avoids scanning huge documents. */
function headOf(html: string): string {
  const end = html.search(/<\/head>/i);
  return end === -1 ? html.slice(0, 200_000) : html.slice(0, end);
}

/** Decode the entities that routinely appear in a URL inside an attribute. */
function decode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#x26;/gi, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * The origin a URL belongs to, or null if it isn't a usable http(s) URL.
 *
 * This is the cache key, so it has to be *canonical*: `https://reuters.com/a`
 * and `https://reuters.com/b?x=1` must produce one entry, not two.
 */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Extract an icon URL from a document's `<head>`.
 *
 * Parsed with targeted regexes rather than a DOM library, for the same reason
 * `ogimage.ts` does: dragging a parser into the desktop sidecar to read a
 * handful of `<link>` tags is a poor trade when a missed tag costs a link its
 * icon and nothing else.
 *
 * `rel` is matched as a whole word within the attribute, because real markup
 * writes `rel="shortcut icon"` and `rel="icon shortcut"` and both mean the same
 * thing — while a naive substring match on `icon` would also accept
 * `rel="apple-touch-icon-image-precomposed"`-style values in the wrong order.
 */
export function extractIconUrl(html: string, pageUrl: string): string | null {
  const head = headOf(html);
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);

  for (const wanted of ICON_RELS) {
    for (const tag of links) {
      const rel = /\brel\s*=\s*["']?([^"'>]+)["']?/i.exec(tag)?.[1]?.toLowerCase().trim();
      if (rel === undefined) continue;
      const words = rel.split(/\s+/);
      const matches = wanted.includes(' ') ? rel === wanted : words.includes(wanted);
      if (!matches) continue;

      const href = /\bhref\s*=\s*["']?([^"'>\s]+)["']?/i.exec(tag)?.[1];
      if (href === undefined || href.trim() === '') continue;
      try {
        const resolved = new URL(decode(href.trim()), pageUrl);
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
        return resolved.toString();
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * Candidate icon URLs for an origin, in the order to try them.
 *
 * `/favicon.ico` first and unconditionally: it is the oldest convention on the
 * web, still honoured almost everywhere, and it costs **one** request with no
 * HTML parse. Only when it fails is the origin's homepage worth fetching to
 * read a `<link rel="icon">` — so the common case is a single small GET and the
 * fallback is bounded at two.
 */
export function faviconCandidates(origin: string): string[] {
  return [`${origin}/favicon.ico`];
}
