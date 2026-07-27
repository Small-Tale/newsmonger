import { rejectUnsafeUrl } from '../images/safety.js';
import type { FoundNewsItem } from './types.js';

/**
 * Probe one URL. Injected so tests never touch the network, and so the check
 * can be turned off entirely (`--ai-test`).
 */
export type LinkProbe = (url: string) => Promise<boolean>;

/** How long a single probe may take. A slow site is not a dead one, but a check is not a crawl. */
const PROBE_TIMEOUT_MS = 6000;

/** How many probes run at once, so a story with many sources can't stampede. */
const PROBE_CONCURRENCY = 4;

/**
 * Whether a URL resolves to something real (NEWS-83).
 *
 * `HEAD` first — it's the cheapest question — falling back to a ranged `GET`,
 * because a surprising number of news sites answer HEAD with 403 or 405 while
 * serving the page perfectly well. Treating those as dead would delete good
 * stories, which is worse than the problem being solved.
 *
 * **Reuses the image pipeline's SSRF vetting** rather than opening a second
 * fetch path: these URLs come from a model, so the same protocol / hostname /
 * post-DNS-address rules apply (`src/images/safety.ts`).
 */
export const probeLink: LinkProbe = async (url) => {
  if ((await rejectUnsafeUrl(url)) !== null) return false;
  const attempt = async (init: RequestInit): Promise<Response | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, PROBE_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const head = await attempt({ method: 'HEAD' });
  if (head !== null && head.ok) return true;
  // 403/405 on HEAD is common and says nothing about the article; ask for one
  // byte instead of the whole page.
  const ranged = await attempt({ method: 'GET', headers: { Range: 'bytes=0-0' } });
  return ranged !== null && ranged.ok;
};

/** Run `fn` over `items` with a fixed number in flight at once. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Drop sources that don't resolve, and drop a story only if none of them do
 * (NEWS-83).
 *
 * A dead or hallucinated link is the failure mode that most damages trust in an
 * AI news product — but a story with three citations where one 404s is still a
 * real story, so the conservative move is to prune the source rather than the
 * story. A story that cites **nothing** reachable is the one that shouldn't be
 * shown at all.
 *
 * Stories that arrived with no sources are passed through untouched: that is a
 * prompt-compliance problem (the system prompt requires a source link), not
 * something to silently delete here.
 */
export async function verifyItemLinks(
  items: FoundNewsItem[],
  probe: LinkProbe = probeLink,
): Promise<{ items: FoundNewsItem[]; droppedSources: number; droppedItems: number }> {
  // De-duplicated across the batch: several stories routinely cite the same
  // outlet's front page, and probing it once per story is wasted traffic.
  const urls = [...new Set(items.flatMap((item) => item.sources.map((s) => s.url)))];
  const verdicts = await mapLimited(urls, PROBE_CONCURRENCY, async (url) => [url, await probe(url)] as const);
  const alive = new Map(verdicts);

  let droppedSources = 0;
  let droppedItems = 0;
  const kept: FoundNewsItem[] = [];
  for (const item of items) {
    if (item.sources.length === 0) {
      kept.push(item);
      continue;
    }
    const sources = item.sources.filter((s) => alive.get(s.url) === true);
    droppedSources += item.sources.length - sources.length;
    if (sources.length === 0) {
      droppedItems += 1;
      continue;
    }
    kept.push({ ...item, sources });
  }
  return { items: kept, droppedSources, droppedItems };
}
