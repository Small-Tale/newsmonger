/**
 * Find an article's lead image the way link-preview cards do: read the Open
 * Graph tag out of the page's `<head>`.
 *
 * Parsed with targeted regexes rather than a DOM library. The alternative is
 * dragging a parser into the desktop sidecar's `node_modules` to read a handful
 * of `<meta>` tags out of documents we never otherwise touch. The tradeoff is
 * accepted deliberately: a missed tag costs a card its picture, which the
 * layout already handles, so the failure mode is cosmetic.
 */

/** `<meta>` tags carrying a preview image, best first. */
const IMAGE_KEYS = ['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src'];

/** Only the head matters, and stopping there avoids scanning huge documents. */
function headOf(html: string): string {
  const end = html.search(/<\/head>/i);
  return end === -1 ? html.slice(0, 200_000) : html.slice(0, end);
}

/**
 * Pull the `content` of a `<meta>` tag whose property/name matches `key`.
 *
 * Handles either attribute order (`property` before or after `content`) and
 * single, double, or unquoted values, because real-world markup uses all of
 * them.
 */
function metaContent(head: string, key: string): string | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${k}["'][^>]*?content\\s*=\\s*["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]*?(?:property|name)\\s*=\\s*["']${k}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(head);
    if (m?.[1] !== undefined && m[1].trim() !== '') return m[1].trim();
  }
  return null;
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
 * Extract a preview image URL from an HTML document.
 *
 * `pageUrl` resolves relative values — plenty of sites publish
 * `content="/img/hero.jpg"`. Returns an absolute http(s) URL, or null when the
 * page has no usable image.
 */
export function extractImageUrl(html: string, pageUrl: string): string | null {
  const head = headOf(html);
  for (const key of IMAGE_KEYS) {
    const raw = metaContent(head, key);
    if (raw === null) continue;
    try {
      const resolved = new URL(decode(raw), pageUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
      return resolved.toString();
    } catch {
      continue; // unparseable value — try the next key
    }
  }
  return null;
}
