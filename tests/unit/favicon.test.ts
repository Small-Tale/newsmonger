import { describe, expect, it } from 'vitest';

import { NewsSourceSchema } from '../../src/db/schemas.js';
import { Store } from '../../src/db/store.js';
import { extractIconUrl, faviconCandidates, originOf } from '../../src/images/favicon.js';
import { liveImageHashes } from '../../src/images/index.js';
import { tmpDataDir } from '../helpers/tmp.js';

/**
 * Finding a source's favicon (NEWS-169).
 *
 * The extraction is regex over real-world `<head>` markup, which is where all
 * the mess lives: `rel` written three different ways, unquoted attributes,
 * relative hrefs, attributes in either order. Those are the cases worth pinning
 * — the network path is covered by the E2E and by the existing safety suite.
 */

const page = (head: string) => `<!doctype html><html><head>${head}</head><body>x</body></html>`;

describe('canonicalising an origin (NEWS-169)', () => {
  it('collapses different articles from one site to a single key', () => {
    // This is the whole efficiency argument: an outlet cited by six stories
    // must be one cache entry and one request, not six.
    expect(originOf('https://reuters.com/world/a')).toBe('https://reuters.com');
    expect(originOf('https://reuters.com/business/b?x=1#f')).toBe('https://reuters.com');
  });

  it('keeps host, port and scheme distinct', () => {
    expect(originOf('https://a.example.com/x')).not.toBe(originOf('https://b.example.com/x'));
    expect(originOf('http://example.com/x')).not.toBe(originOf('https://example.com/x'));
    expect(originOf('https://example.com:8443/x')).toBe('https://example.com:8443');
  });

  it('refuses anything that is not http(s)', () => {
    // The same posture as the image path: a model-supplied URL is untrusted, and
    // a `file:` or `javascript:` origin has no business reaching a fetch.
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'not a url', '']) {
      expect(originOf(url)).toBeNull();
    }
  });
});

describe('the cheap path (NEWS-169)', () => {
  it('tries /favicon.ico first, with no HTML parse', () => {
    // The oldest convention on the web and still honoured almost everywhere, so
    // the common case is one small GET.
    expect(faviconCandidates('https://reuters.com')).toEqual(['https://reuters.com/favicon.ico']);
  });
});

describe('reading a declared icon out of <head> (NEWS-169)', () => {
  it('finds a plain rel="icon"', () => {
    const html = page('<link rel="icon" href="/i/favicon.png">');
    expect(extractIconUrl(html, 'https://x.example/a')).toBe('https://x.example/i/favicon.png');
  });

  it('accepts rel="shortcut icon", which real markup uses constantly', () => {
    const html = page('<link rel="shortcut icon" href="/f.ico">');
    expect(extractIconUrl(html, 'https://x.example/a')).toBe('https://x.example/f.ico');
  });

  it('accepts the reversed multi-word form rel="icon shortcut"', () => {
    // Matched as whole words, so word order does not matter.
    const html = page('<link rel="icon shortcut" href="/f.ico">');
    expect(extractIconUrl(html, 'https://x.example/a')).toBe('https://x.example/f.ico');
  });

  it('does not mistake a longer rel token for `icon`', () => {
    // A substring match on "icon" would wrongly accept this as a plain icon.
    // It should still be found, but via the apple-touch-icon rule rather than
    // by accident — so the *resolved* URL is what matters here.
    const html = page('<link rel="apple-touch-icon" href="/apple.png">');
    expect(extractIconUrl(html, 'https://x.example/a')).toBe('https://x.example/apple.png');
  });

  it('prefers a plain icon over an apple-touch-icon when both exist', () => {
    const html = page('<link rel="apple-touch-icon" href="/apple.png"><link rel="icon" href="/plain.png">');
    expect(extractIconUrl(html, 'https://x.example/a')).toBe('https://x.example/plain.png');
  });

  it('handles attributes in either order', () => {
    const html = page('<link href="/f.svg" rel="icon" type="image/svg+xml">');
    expect(extractIconUrl(html, 'https://x.example/a')).toBe('https://x.example/f.svg');
  });

  it('handles unquoted attribute values', () => {
    const html = page('<link rel=icon href=/f.png>');
    expect(extractIconUrl(html, 'https://x.example/a')).toBe('https://x.example/f.png');
  });

  it('resolves a relative href against the page, not the site root', () => {
    const html = page('<link rel="icon" href="../assets/f.png">');
    expect(extractIconUrl(html, 'https://x.example/news/2026/a')).toBe('https://x.example/news/assets/f.png');
  });

  it('accepts an absolute href on another host', () => {
    // Plenty of sites serve icons from a CDN. The URL is re-validated before
    // fetching, so accepting it here is safe.
    const html = page('<link rel="icon" href="https://cdn.example/f.png">');
    expect(extractIconUrl(html, 'https://x.example/a')).toBe('https://cdn.example/f.png');
  });

  it('decodes entities in the href', () => {
    const html = page('<link rel="icon" href="/f.png?a=1&amp;b=2">');
    expect(extractIconUrl(html, 'https://x.example/a')).toBe('https://x.example/f.png?a=1&b=2');
  });

  it('refuses a non-http(s) href', () => {
    for (const href of ['data:image/png;base64,AAA', 'javascript:alert(1)']) {
      expect(extractIconUrl(page(`<link rel="icon" href="${href}">`), 'https://x.example/a')).toBeNull();
    }
  });

  it('ignores an icon link declared after </head>', () => {
    // Scanning stops at </head>, which is what keeps a 1.8 MB news page cheap.
    const html = '<html><head><title>t</title></head><body><link rel="icon" href="/late.png"></body></html>';
    expect(extractIconUrl(html, 'https://x.example/a')).toBeNull();
  });

  it('returns null for a page with no icon at all', () => {
    expect(extractIconUrl(page('<title>t</title>'), 'https://x.example/a')).toBeNull();
  });

  it('skips an icon link with an empty href rather than resolving the page URL', () => {
    // `new URL('', pageUrl)` succeeds and yields the page itself — which would
    // cache the HTML document as an icon.
    const html = page('<link rel="icon" href=""><link rel="apple-touch-icon" href="/a.png">');
    expect(extractIconUrl(html, 'https://x.example/a')).toBe('https://x.example/a.png');
  });
});

describe('favicons join the mark-and-sweep (NEWS-169, FR-8.13)', () => {
  const fav = (hash: string) => ({ hash, sourceUrl: `https://x/${hash}` });

  it('marks a source favicon so the sweep does not delete it', () => {
    // Without this the prune would silently reclaim every icon, leaving broken
    // images that only return after a fresh check.
    const live = liveImageHashes([{ image: null, sources: [{ favicon: fav('aaa') }] }]);
    expect(live.has('aaa')).toBe(true);
  });

  it('marks lead images and favicons together', () => {
    const live = liveImageHashes([
      { image: { hash: 'img1' }, sources: [{ favicon: fav('fav1') }, { favicon: fav('fav2') }] },
    ]);
    expect([...live].sort()).toEqual(['fav1', 'fav2', 'img1']);
  });

  it('keeps a shared favicon alive while any story still cites that outlet', () => {
    // Content addressing means two stories from one outlet share a hash; the
    // mark set is the reference count.
    const live = liveImageHashes([
      { image: null, sources: [{ favicon: fav('shared') }] },
      { image: null, sources: [{ favicon: fav('shared') }] },
    ]);
    expect(live.has('shared')).toBe(true);
    expect(live.size).toBe(1);
  });

  it('tolerates sources with no favicon, and items with no sources field', () => {
    const live = liveImageHashes([
      { image: null, sources: [{ favicon: null }] },
      { image: { hash: 'only' } },
    ]);
    expect([...live]).toEqual(['only']);
  });
});

describe('a favicon survives storage (NEWS-169)', () => {
  it('round-trips through SQLite with the rest of the source', () => {
    // `sources` is a JSON column, so the field rides along for free — but that
    // is an assumption about the storage shape, and this is what makes it a
    // checked one rather than a hopeful one.
    const dir = tmpDataDir();
    const store = new Store(dir);
    const topic = store.addTopic('Space');
    store.addItems([
      {
        topicId: topic.id,
        title: 'Launch',
        summary: 'A rocket launched.',
        sources: [
          {
            title: 'src',
            url: 'https://ex.com/a',
            outlet: 'Example',
            publishedAt: null,
            favicon: { hash: 'a'.repeat(32), sourceUrl: 'https://ex.com/favicon.ico' },
          },
        ],
        dedupeKey: 'url:ex.com/a',
        foundAt: new Date().toISOString(),
      },
    ]);

    const reloaded = new Store(dir).listItems();
    expect(reloaded[0].sources[0].favicon).toEqual({
      hash: 'a'.repeat(32),
      sourceUrl: 'https://ex.com/favicon.ico',
    });
  });

  it('reads a story stored before favicons existed as simply having none', () => {
    // The field defaults rather than being migrated, which is only safe if a
    // row written by an older version still parses. Simulated by writing a
    // source with no `favicon` key at all.
    const parsed = NewsSourceSchema.parse({ title: 's', url: 'https://ex.com/a' });
    expect(parsed.favicon).toBeNull();
  });

  it('treats a malformed stored favicon as absent rather than failing the read', () => {
    // `.catch(null)` on the field: one corrupt row must not make a whole
    // topic's history unreadable, and the arrow fallback covers it invisibly.
    const parsed = NewsSourceSchema.parse({ title: 's', url: 'https://ex.com/a', favicon: { hash: 42 } });
    expect(parsed.favicon).toBeNull();
  });
});
