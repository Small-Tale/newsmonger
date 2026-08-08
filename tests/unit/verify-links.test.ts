import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import type { FoundNewsItem } from '../../src/ai/types.js';
import type { LinkProbe } from '../../src/ai/verify-links.js';
import { verifyItemLinks } from '../../src/ai/verify-links.js';
import { CheckRunner } from '../../src/checks.js';
import { asResolver } from '../helpers/provider.js';
import { tmpStore } from '../helpers/tmp.js';

function story(title: string, urls: string[]): FoundNewsItem {
  return {
    title,
    summary: 'A summary.',
    sources: urls.map((url, i) => ({ title: `Source ${String(i)}`, url })),
  };
}

/** A probe that answers from a set of "live" URLs, and counts its calls. */
function probeFor(live: string[]): LinkProbe & { calls: string[] } {
  const calls: string[] = [];
  const fn = (url: string): Promise<boolean> => {
    calls.push(url);
    return Promise.resolve(live.includes(url));
  };
  return Object.assign(fn, { calls });
}

describe('verifyItemLinks (NEWS-83)', () => {
  it('keeps a story whose links all resolve', async () => {
    const items = [story('Real', ['https://a.test/1'])];
    const result = await verifyItemLinks(items, probeFor(['https://a.test/1']));
    expect(result.items).toEqual(items);
    expect(result.droppedSources).toBe(0);
    expect(result.droppedItems).toBe(0);
  });

  it('prunes the dead source but keeps the story when another resolves', async () => {
    // A story with three citations where one 404s is still a real story —
    // pruning the source is the conservative move, deleting the story is not.
    const items = [story('Mostly real', ['https://a.test/dead', 'https://a.test/live'])];
    const result = await verifyItemLinks(items, probeFor(['https://a.test/live']));
    expect(result.items).toHaveLength(1);
    expect(result.items[0].sources.map((s) => s.url)).toEqual(['https://a.test/live']);
    expect(result.droppedSources).toBe(1);
    expect(result.droppedItems).toBe(0);
  });

  it('drops a story when nothing it cites resolves', async () => {
    const result = await verifyItemLinks([story('Fabricated', ['https://a.test/nope'])], probeFor([]));
    expect(result.items).toEqual([]);
    expect(result.droppedItems).toBe(1);
  });

  it('passes a source-less story through untouched', async () => {
    // The system prompt requires a citation; a story without one is a
    // prompt-compliance problem, not something to silently delete here.
    const items = [story('No citation', [])];
    const result = await verifyItemLinks(items, probeFor([]));
    expect(result.items).toEqual(items);
    expect(result.droppedItems).toBe(0);
  });

  it('probes each distinct URL once across the whole batch', async () => {
    // Several stories routinely cite the same outlet; probing per story is
    // wasted traffic against someone else's server.
    const probe = probeFor(['https://a.test/shared']);
    await verifyItemLinks(
      [story('One', ['https://a.test/shared']), story('Two', ['https://a.test/shared'])],
      probe,
    );
    expect(probe.calls).toEqual(['https://a.test/shared']);
  });

  it('handles an empty batch without probing anything', async () => {
    const probe = probeFor([]);
    const result = await verifyItemLinks([], probe);
    expect(result.items).toEqual([]);
    expect(probe.calls).toHaveLength(0);
  });

  it('keeps the sources in their original order', async () => {
    const items = [story('Ordered', ['https://a.test/1', 'https://a.test/2', 'https://a.test/3'])];
    const result = await verifyItemLinks(items, probeFor(['https://a.test/3', 'https://a.test/1']));
    expect(result.items[0].sources.map((s) => s.url)).toEqual(['https://a.test/1', 'https://a.test/3']);
  });

  it('bounds concurrency rather than firing every probe at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const probe: LinkProbe = async (url) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return url.endsWith('9');
    };
    const urls = Array.from({ length: 20 }, (_, i) => `https://a.test/${String(i)}`);
    await verifyItemLinks([story('Many', urls)], probe);
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe('CheckRunner link verification (NEWS-83)', () => {
  function runnerWith(probe: LinkProbe | null) {
    const store = tmpStore();
    const service = createMockProvider();
    return { store, runner: new CheckRunner(store, asResolver(service), undefined, null, probe) };
  }

  it('stores nothing when every citation is dead', async () => {
    const { store, runner } = runnerWith(probeFor([]));
    const topic = store.addTopic('Fusion');
    expect(await runner.checkTopic(topic.id)).toBe(0);
    expect(store.listItems()).toHaveLength(0);
  });

  it('stores the stories whose citations resolve', async () => {
    const { store, runner } = runnerWith(() => Promise.resolve(true));
    const topic = store.addTopic('Fusion');
    expect(await runner.checkTopic(topic.id)).toBe(2);
  });

  it('skips verification entirely when no probe is configured', async () => {
    const { store, runner } = runnerWith(null);
    const topic = store.addTopic('Fusion');
    expect(await runner.checkTopic(topic.id)).toBe(2);
  });

  it('keeps stories unverified rather than failing the check when the probe throws', async () => {
    // No news at all is a worse outcome than a story with an unchecked link.
    const { store, runner } = runnerWith(() => Promise.reject(new Error('dns exploded')));
    const topic = store.addTopic('Fusion');
    expect(await runner.checkTopic(topic.id)).toBe(2);
    expect(store.listRuns(1)[0].status).toBe('succeeded');
  });

  it('does not let a dead-linked story burn its dedupe key', async () => {
    // Verification runs *before* dedup on purpose. If a dropped story still
    // claimed its key, the real version of the same story would be filtered
    // out as a duplicate on the next check and never appear at all.
    const store = tmpStore();
    const service = createMockProvider();
    const topic = store.addTopic('Fusion');

    const dead = new CheckRunner(store, asResolver(service), undefined, null, probeFor([]));
    expect(await dead.checkTopic(topic.id)).toBe(0);

    const alive = new CheckRunner(store, asResolver(service), undefined, null, () => Promise.resolve(true));
    expect(await alive.checkTopic(topic.id)).toBe(2);
  });
});
