import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { cachedImagePath, imageHash, isValidHash, sniffImageType } from '../../src/images/cache.js';
import { extractImageUrl } from '../../src/images/ogimage.js';
import { isBlockedAddress, rejectUnsafeUrl, staticUrlRejection } from '../../src/images/safety.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

describe('SSRF guards', () => {
  // Article and image URLs come from an AI provider, so an untrusted party
  // chooses what the server connects to. These are the addresses that must
  // never be reachable.
  it('blocks loopback, private, and link-local addresses', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    // 169.254.169.254 is the cloud metadata endpoint — the classic SSRF target.
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
    expect(isBlockedAddress('100.64.0.1')).toBe(true); // carrier-grade NAT
    expect(isBlockedAddress('224.0.0.1')).toBe(true); // multicast
  });

  it('blocks IPv6 loopback, link-local and unique-local', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('sees through IPv4-mapped IPv6, which is the obvious bypass', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it('refuses anything that is not an address at all', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });

  it('rejects non-http protocols', () => {
    expect(staticUrlRejection('file:///etc/passwd')).toMatch(/protocol/);
    expect(staticUrlRejection('ftp://example.com/x')).toMatch(/protocol/);
    // A data: URL would otherwise let a model inline arbitrary bytes.
    expect(staticUrlRejection('data:image/png;base64,AAAA')).toMatch(/protocol/);
    expect(staticUrlRejection('javascript:alert(1)')).toMatch(/protocol/);
  });

  it('rejects localhost and local domains by name', () => {
    expect(staticUrlRejection('http://localhost:4187/api/keys')).toMatch(/blocked/);
    expect(staticUrlRejection('http://printer.local/x')).toMatch(/blocked/);
    expect(staticUrlRejection('http://svc.internal/x')).toMatch(/blocked/);
    // A trailing dot is the same host to a resolver.
    expect(staticUrlRejection('http://localhost./x')).toMatch(/blocked/);
  });

  it('rejects literal blocked addresses without needing DNS', () => {
    expect(staticUrlRejection('http://169.254.169.254/latest/meta-data/')).toMatch(/blocked/);
    expect(staticUrlRejection('http://127.0.0.1:4187/api/state')).toMatch(/blocked/);
    expect(staticUrlRejection('http://[::1]:4187/')).toMatch(/blocked/);
  });

  it('rejects URLs carrying credentials', () => {
    // Credentials are never legitimate here and leak into logs.
    expect(staticUrlRejection('http://user:pw@example.com/x')).toMatch(/credentials/);
  });

  it('rejects malformed URLs', () => {
    expect(staticUrlRejection('not a url')).not.toBeNull();
    expect(staticUrlRejection('http://')).not.toBeNull();
  });

  it('allows a normal article URL', () => {
    expect(staticUrlRejection('https://www.reuters.com/world/story-2026')).toBeNull();
    expect(staticUrlRejection('http://example.com/a?b=1#c')).toBeNull();
  });

  it('also checks what a hostname resolves to', async () => {
    // The rebinding shape: a public-looking name pointing into the LAN.
    expect(await rejectUnsafeUrl('http://localhost/x')).toMatch(/blocked/);
    expect(await rejectUnsafeUrl('https://nonexistent.invalid/x')).toMatch(/resolve/);
  });
});

describe('og:image extraction', () => {
  const page = (head: string): string => `<html><head>${head}</head><body><img src="/nope.jpg"></body></html>`;

  it('reads a standard og:image tag', () => {
    const html = page('<meta property="og:image" content="https://cdn.test/hero.jpg">');
    expect(extractImageUrl(html, 'https://news.test/a')).toBe('https://cdn.test/hero.jpg');
  });

  it('handles either attribute order', () => {
    const html = page('<meta content="https://cdn.test/x.jpg" property="og:image">');
    expect(extractImageUrl(html, 'https://news.test/a')).toBe('https://cdn.test/x.jpg');
  });

  it('accepts name= as well as property=', () => {
    const html = page('<meta name="og:image" content="https://cdn.test/n.jpg">');
    expect(extractImageUrl(html, 'https://news.test/a')).toBe('https://cdn.test/n.jpg');
  });

  it('resolves a relative image against the page URL', () => {
    const html = page('<meta property="og:image" content="/img/hero.jpg">');
    expect(extractImageUrl(html, 'https://news.test/section/a')).toBe('https://news.test/img/hero.jpg');
  });

  it('decodes entities in the URL', () => {
    const html = page('<meta property="og:image" content="https://cdn.test/i?a=1&amp;b=2">');
    expect(extractImageUrl(html, 'https://news.test/a')).toBe('https://cdn.test/i?a=1&b=2');
  });

  it('prefers the more specific key and falls back to twitter:image', () => {
    const both = page(
      '<meta property="twitter:image" content="https://cdn.test/tw.jpg">' +
        '<meta property="og:image" content="https://cdn.test/og.jpg">',
    );
    expect(extractImageUrl(both, 'https://news.test/a')).toBe('https://cdn.test/og.jpg');

    const only = page('<meta property="twitter:image" content="https://cdn.test/tw.jpg">');
    expect(extractImageUrl(only, 'https://news.test/a')).toBe('https://cdn.test/tw.jpg');
  });

  it('returns null when there is no usable image', () => {
    expect(extractImageUrl(page('<title>x</title>'), 'https://news.test/a')).toBeNull();
    // Body images are ignored on purpose — og:image is the curated one.
    expect(extractImageUrl('<html><body><img src="/a.jpg"></body></html>', 'https://news.test/a')).toBeNull();
    expect(extractImageUrl(page('<meta property="og:image" content="">'), 'https://news.test/a')).toBeNull();
  });

  it('ignores a non-http image value', () => {
    const html = page('<meta property="og:image" content="data:image/png;base64,AAAA">');
    expect(extractImageUrl(html, 'https://news.test/a')).toBeNull();
  });
});

describe('cache addressing', () => {
  it('hashes are stable, 32 hex chars, and differ per URL', () => {
    const a = imageHash('https://cdn.test/a.jpg');
    expect(a).toBe(imageHash('https://cdn.test/a.jpg'));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(imageHash('https://cdn.test/b.jpg'));
  });

  it('only accepts well-formed hashes', () => {
    expect(isValidHash('a'.repeat(32))).toBe(true);
    expect(isValidHash('A'.repeat(32))).toBe(false); // uppercase isn't produced
    expect(isValidHash('a'.repeat(31))).toBe(false);
    // The traversal attempts the route must refuse.
    expect(isValidHash('../../etc/passwd')).toBe(false);
    expect(isValidHash('abc/../../x')).toBe(false);
  });

  it('sniffs the common image types from magic bytes', () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('89504e470d0a1a0a', 'hex'))).toBe('image/png');
    expect(sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe(
      'image/webp',
    );
    expect(sniffImageType(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from('not an image'))).toBe('application/octet-stream');
  });
});

describe('GET /api/image/:hash', () => {
  function appWith(dataDir: string) {
    const store = new Store(dataDir);
    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    return createApp({ store, runner, dataDir });
  }

  it('serves a cached image with its sniffed type', async () => {
    const dir = tmpDataDir();
    const hash = 'a'.repeat(32);
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(cachedImagePath(dir, hash), Buffer.from('89504e470d0a1a0a', 'hex'));

    const res = await appWith(dir).request(`/api/image/${hash}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toMatch(/immutable/);
  });

  it('404s for an unknown hash', async () => {
    const res = await appWith(tmpDataDir()).request(`/api/image/${'b'.repeat(32)}`);
    expect(res.status).toBe(404);
  });

  it('refuses path traversal and malformed ids', async () => {
    // The route is cache-only, so this is defence in depth — but the hash
    // check is also what makes the path join safe.
    const app = appWith(tmpDataDir());
    for (const bad of ['..%2F..%2Fetc%2Fpasswd', 'short', 'A'.repeat(32), '%2e%2e%2fdata.json']) {
      expect((await app.request(`/api/image/${bad}`)).status, bad).toBe(400);
    }
  });

  it('never fetches on request — an unknown image is a 404, not a proxy', async () => {
    // An endpoint that fetched what it was pointed at would be an open proxy
    // on the user's machine. Nothing enters the cache except during a check.
    const dir = tmpDataDir();
    const res = await appWith(dir).request(`/api/image/${imageHash('https://cdn.test/never-fetched.jpg')}`);
    expect(res.status).toBe(404);
    expect(fs.existsSync(path.join(dir, 'images'))).toBe(false);
  });
});

describe('CheckRunner image fetching', () => {
  it('stores the image returned for a story', async () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('fusion energy');
    const runner = new CheckRunner(store, asResolver(createMockProvider()), undefined, () =>
      Promise.resolve({ hash: 'c'.repeat(32), sourceUrl: 'https://cdn.test/x.jpg' }),
    );

    await runner.checkTopic(topic.id);

    expect(store.listItems()[0]?.image).toEqual({ hash: 'c'.repeat(32), sourceUrl: 'https://cdn.test/x.jpg' });
  });

  it('stores null when no image is found', async () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('fusion energy');
    const runner = new CheckRunner(store, asResolver(createMockProvider()), undefined, () => Promise.resolve(null));

    await runner.checkTopic(topic.id);
    expect(store.listItems()[0]?.image).toBeNull();
  });

  it('still records the story when image fetching throws', async () => {
    // A picture is decoration. Losing one must never cost the story.
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('fusion energy');
    const runner = new CheckRunner(store, asResolver(createMockProvider()), undefined, () =>
      Promise.reject(new Error('network down')),
    );

    const added = await runner.checkTopic(topic.id);

    expect(added).toBe(2);
    expect(store.listItems()).toHaveLength(2);
    expect(store.listItems()[0]?.image).toBeNull();
  });

  it('fetches no images at all when no fetcher is configured', async () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('fusion energy');
    await new CheckRunner(store, asResolver(createMockProvider())).checkTopic(topic.id);
    expect(store.listItems().every((i) => i.image === null)).toBe(true);
  });
});
