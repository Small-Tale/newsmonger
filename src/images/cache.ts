/**
 * Fetch article images and cache them on disk, so the browser never talks to a
 * publisher directly.
 *
 * Loading images straight from the source would tell every publisher in the
 * feed your IP address and that you opened the app — including for stories you
 * never read. Today the page makes no third-party requests at all, and that's
 * worth keeping: the server fetches once, stores the bytes, and the page loads
 * them from `127.0.0.1`.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { extractIconUrl, faviconCandidates } from './favicon.js';
import { extractImageUrl } from './ogimage.js';
import { rejectUnsafeUrl } from './safety.js';

/** Give up on a slow page or image rather than stalling a whole check. */
const FETCH_TIMEOUT_MS = 8_000;
/**
 * How much of a page to read. News pages routinely exceed a megabyte (AP's
 * section front is ~1.8 MB), but `<head>` is at the very top, so reading a
 * prefix is enough — see the `truncate` mode below.
 */
const MAX_HTML_BYTES = 512 * 1024;
/** A lead image beyond this is not worth caching. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

/**
 * A favicon beyond this is not a favicon (NEWS-169).
 *
 * Two orders of magnitude below the lead-image cap, because the shapes are
 * different: a hero photograph is legitimately megabytes, a site icon is a few
 * kilobytes. Keeping the cap tight means a misconfigured server that answers
 * `/favicon.ico` with a full-page image is rejected rather than cached.
 */
const MAX_FAVICON_BYTES = 256 * 1024;

/**
 * Types a favicon may be, which is a *wider* set than a lead image's.
 *
 * `image/x-icon` and `image/vnd.microsoft.icon` are the two spellings of ICO
 * that real servers send, and SVG favicons are now common. Both are fine here
 * and neither belongs in the lead-image set — a `.ico` hero photo would be a
 * sign something had gone wrong.
 */
const ALLOWED_FAVICON_TYPES = new Set([
  ...ALLOWED_IMAGE_TYPES,
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml',
]);

/** Cache filenames are content-addressed by source URL — stable and safe. */
export function imageHash(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

export function imagesDir(dataDir: string): string {
  return path.join(dataDir, 'images');
}

/** Path a cached image lives at. `hash` MUST already be validated as hex. */
export function cachedImagePath(dataDir: string, hash: string): string {
  return path.join(imagesDir(dataDir), `${hash}.bin`);
}

/** Hashes are the only thing the image route accepts, so pin the shape. */
export function isValidHash(hash: string): boolean {
  return /^[0-9a-f]{32}$/.test(hash);
}

/**
 * Fetch with a byte cap.
 *
 * `onOverflow` matters: a truncated HTML prefix still contains the `<head>` we
 * want, but a truncated image is a corrupt file — so pages truncate and images
 * are rejected outright.
 */
async function fetchWithLimit(
  url: string,
  maxBytes: number,
  accept: string,
  onOverflow: 'truncate' | 'reject',
): Promise<{ body: Buffer; contentType: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept,
        // Identify honestly. Sites that refuse this simply don't get a picture.
        'user-agent': 'news/0.1 (+local personal news reader)',
      },
    });
    if (!res.ok || res.body === null) return null;

    const declared = Number(res.headers.get('content-length') ?? '0');
    if (onOverflow === 'reject' && declared > maxBytes) return null;

    // Read incrementally: content-length is a hint, not a promise.
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        if (onOverflow === 'reject') return null;
        chunks.push(Buffer.from(chunk));
        break; // enough for the head; stop pulling the rest of the page
      }
      chunks.push(Buffer.from(chunk));
    }
    return { body: Buffer.concat(chunks), contentType: res.headers.get('content-type') ?? '' };
  } catch {
    return null; // timeout, DNS failure, TLS error — all just mean "no image"
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve an article URL to a cached image, returning its hash.
 *
 * Every network hop re-checks the URL: the article, and then the image URL the
 * article advertised — which is a *second* attacker-influenced value, and the
 * one a redirect could point back at the local network.
 */
export async function cacheArticleImage(
  articleUrl: string,
  dataDir: string,
): Promise<{ hash: string; sourceUrl: string } | null> {
  if ((await rejectUnsafeUrl(articleUrl)) !== null) return null;

  const page = await fetchWithLimit(articleUrl, MAX_HTML_BYTES, 'text/html', 'truncate');
  if (page === null || !page.contentType.toLowerCase().includes('html')) return null;

  const imageUrl = extractImageUrl(page.body.toString('utf-8'), articleUrl);
  if (imageUrl === null) return null;
  if ((await rejectUnsafeUrl(imageUrl)) !== null) return null;

  const hash = imageHash(imageUrl);
  const file = cachedImagePath(dataDir, hash);
  if (fs.existsSync(file)) return { hash, sourceUrl: imageUrl };

  const image = await fetchWithLimit(imageUrl, MAX_IMAGE_BYTES, 'image/*', 'reject');
  if (image === null) return null;

  const type = image.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ALLOWED_IMAGE_TYPES.has(type)) return null;

  fs.mkdirSync(imagesDir(dataDir), { recursive: true });
  // Write via a temp file so a crash mid-download can't leave a truncated
  // image that would then be served forever as a valid cache hit.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, image.body);
  fs.renameSync(tmp, file);
  return { hash, sourceUrl: imageUrl };
}

/** Content type to serve a cached file with, sniffed from its magic bytes. */
export function sniffImageType(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (bytes.length >= 12 && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(4, 12).toString('ascii') === 'ftypavif') return 'image/avif';
  return 'application/octet-stream';
}

/**
 * Collect every image hash still referenced by a live item.
 *
 * This IS the reference count: an image shared by two stories (same URL → same
 * hash, the point of content addressing) is in the set as long as either story
 * survives, so the sweep below never deletes a file another item still uses.
 */
export function liveImageHashes(
  items: readonly {
    image: { hash: string } | null;
    /** Optional so callers that only have lead images still type-check. */
    sources?: readonly { favicon?: { hash: string } | null }[];
  }[],
): Set<string> {
  const hashes = new Set<string>();
  for (const item of items) {
    if (item.image !== null) hashes.add(item.image.hash);
    // Source favicons live in the same cache and must join the mark set or the
    // sweep below deletes them (NEWS-169) — and it would do so *silently*,
    // leaving broken icons that only reappear after a fresh check.
    for (const source of item.sources ?? []) {
      if (source.favicon != null) hashes.add(source.favicon.hash);
    }
  }
  return hashes;
}

/**
 * Delete cached images no longer referenced by any live item.
 *
 * Mark-and-sweep against `liveHashes`: self-healing, so it also reclaims
 * orphans left by a crash or an older version, not only ones from the delete
 * that triggered it. Stray `.tmp` files from an interrupted download are swept
 * too. Returns the number of files removed. Never throws — a cache that can't
 * be read just isn't pruned this pass.
 */
export function pruneImageCache(dataDir: string, liveHashes: ReadonlySet<string>): number {
  const dir = imagesDir(dataDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0; // no cache directory yet — nothing to prune
  }
  let removed = 0;
  for (const name of entries) {
    if (name.endsWith('.tmp')) {
      fs.rmSync(path.join(dir, name), { force: true });
      removed++;
      continue;
    }
    if (!name.endsWith('.bin')) continue;
    const hash = name.slice(0, -'.bin'.length);
    if (!liveHashes.has(hash)) {
      fs.rmSync(path.join(dir, name), { force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * Download and cache one icon URL. Shared by both favicon attempts.
 *
 * Re-checks the URL before fetching, like every other hop: an icon URL taken
 * from a page's `<link>` is an attacker-influenced value, exactly the FR-8.9
 * situation the lead-image path already guards.
 */
async function cacheIconUrl(iconUrl: string, dataDir: string): Promise<{ hash: string; sourceUrl: string } | null> {
  if ((await rejectUnsafeUrl(iconUrl)) !== null) return null;

  const hash = imageHash(iconUrl);
  const file = cachedImagePath(dataDir, hash);
  if (fs.existsSync(file)) return { hash, sourceUrl: iconUrl };

  const icon = await fetchWithLimit(iconUrl, MAX_FAVICON_BYTES, 'image/*', 'reject');
  if (icon === null) return null;

  const type = icon.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ALLOWED_FAVICON_TYPES.has(type)) return null;
  // A zero-length body is what some servers return instead of a 404 for a
  // missing /favicon.ico. Caching it would put a broken <img> on every link
  // from that outlet, permanently, since the cache is never re-fetched.
  if (icon.body.length === 0) return null;

  fs.mkdirSync(imagesDir(dataDir), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, icon.body);
  fs.renameSync(tmp, file);
  return { hash, sourceUrl: iconUrl };
}

/**
 * Resolve an origin to a cached favicon (NEWS-169).
 *
 * Two bounded attempts: `/favicon.ico`, then the origin's homepage read for a
 * `<link rel="icon">`. The first covers the overwhelming majority in a single
 * small request with no HTML parse; the second exists because plenty of modern
 * sites ship only an SVG or a hashed asset path and never place a file at the
 * legacy location.
 *
 * Returns null on every failure. A link without an icon falls back to the arrow
 * glyph it always had, so this is cosmetic by construction — it must never cost
 * a story or fail a check.
 */
export async function cacheFavicon(
  origin: string,
  dataDir: string,
): Promise<{ hash: string; sourceUrl: string } | null> {
  for (const candidate of faviconCandidates(origin)) {
    const cached = await cacheIconUrl(candidate, dataDir);
    if (cached !== null) return cached;
  }

  // Fallback: ask the homepage what its icon is.
  if ((await rejectUnsafeUrl(origin)) !== null) return null;
  const page = await fetchWithLimit(origin, MAX_HTML_BYTES, 'text/html', 'truncate');
  if (page === null || !page.contentType.toLowerCase().includes('html')) return null;

  const declared = extractIconUrl(page.body.toString('utf-8'), origin);
  if (declared === null) return null;
  return cacheIconUrl(declared, dataDir);
}
