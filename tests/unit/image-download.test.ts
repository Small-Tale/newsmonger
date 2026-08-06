import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cachedImagePath, cacheImageUrl, imageHash, imagesDir } from '../../src/images/cache.js';
import { tmpDataDir } from '../helpers/tmp.js';

/**
 * The real image downloader (NEWS-353).
 *
 * `cacheImageUrl` was split out of `cacheArticleImage` in NEWS-341 so a story
 * whose cached file went missing could be refetched without re-scraping the
 * article. The route's use of it is injectable, which made the *repair* path
 * testable — and left the downloader itself exercised only by hand, against
 * live URLs, by nothing that runs again.
 *
 * This drives the real function with `fetch` stubbed: the size cap, the
 * content-type allow-list, the temp-file write and the rename all actually run.
 *
 * **URLs here are IP literals on purpose.** `rejectUnsafeUrl` returns early for
 * a literal address (`net.isIP(host) !== 0`), so the SSRF guard is exercised
 * without a DNS lookup — a unit test must not depend on a resolver.
 */

/** A public IP literal: passes the static checks, needs no DNS. */
const URL_OK = 'https://93.184.216.34/lead.jpg';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/** Stand in for `fetch`, yielding `body` as a single chunk. */
function stubFetch(options: {
  status?: number;
  contentType?: string;
  contentLength?: string;
  body?: Buffer;
  chunks?: Buffer[];
}): ReturnType<typeof vi.fn> {
  const body = options.body ?? PNG;
  const chunks = options.chunks ?? [body];
  const fake = vi.fn(() =>
    Promise.resolve({
      ok: (options.status ?? 200) < 400,
      status: options.status ?? 200,
      headers: {
        get: (h: string): string | null =>
          h === 'content-type'
            ? (options.contentType ?? 'image/png')
            : h === 'content-length'
              ? (options.contentLength ?? String(body.byteLength))
              : null,
      },
      // A plain async iterable rather than an async generator: the generator
      // form trips `require-await`, and `fetchWithLimit` only ever `for await`s
      // this.
      body: {
        [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => {
          let i = 0;
          return {
            next: (): Promise<IteratorResult<Uint8Array>> =>
              Promise.resolve(
                i < chunks.length
                  ? { value: new Uint8Array(chunks[i++]), done: false }
                  : { value: undefined, done: true },
              ),
          };
        },
      },
    }),
  );
  vi.stubGlobal('fetch', fake);
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cacheImageUrl (NEWS-353)', () => {
  it('downloads to a file named by the hash of its URL', () => {
    // Content-addressed by source URL is what lets a repair land on the hash a
    // story already stores, with no database write (FR-8.20).
    const dir = tmpDataDir();
    stubFetch({});

    return cacheImageUrl(URL_OK, dir).then((result) => {
      expect(result).toEqual({ hash: imageHash(URL_OK), sourceUrl: URL_OK });
      expect(fs.readFileSync(cachedImagePath(dir, imageHash(URL_OK)))).toEqual(PNG);
    });
  });

  it('leaves no .tmp behind, so the prune has nothing to sweep', async () => {
    // The write goes through a temp file and a rename, so a crash mid-download
    // cannot leave a truncated image that is served forever as a cache hit.
    const dir = tmpDataDir();
    stubFetch({});
    await cacheImageUrl(URL_OK, dir);
    expect(fs.readdirSync(imagesDir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('does not refetch a file it already has', async () => {
    const dir = tmpDataDir();
    fs.mkdirSync(imagesDir(dir), { recursive: true });
    fs.writeFileSync(cachedImagePath(dir, imageHash(URL_OK)), PNG);
    const fetchSpy = stubFetch({});

    const result = await cacheImageUrl(URL_OK, dir);

    expect(result?.hash).toBe(imageHash(URL_OK));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a declared size over the cap without reading the body', async () => {
    const dir = tmpDataDir();
    stubFetch({ contentLength: String(6 * 1024 * 1024) });
    expect(await cacheImageUrl(URL_OK, dir)).toBeNull();
    expect(fs.existsSync(cachedImagePath(dir, imageHash(URL_OK)))).toBe(false);
  });

  it('rejects a body that overruns the cap even when content-length lied', async () => {
    // The comment on `fetchWithLimit` is explicit that content-length is a hint,
    // not a promise — so the incremental check is the one that matters.
    const dir = tmpDataDir();
    const oversized = Array.from({ length: 6 }, () => Buffer.alloc(1024 * 1024, 0x41));
    stubFetch({ contentLength: '10', chunks: oversized });

    expect(await cacheImageUrl(URL_OK, dir)).toBeNull();
    expect(fs.existsSync(cachedImagePath(dir, imageHash(URL_OK)))).toBe(false);
  });

  it('refuses a content-type that is not an allowed image', async () => {
    const dir = tmpDataDir();
    stubFetch({ contentType: 'text/html; charset=utf-8' });
    expect(await cacheImageUrl(URL_OK, dir)).toBeNull();
  });

  it('accepts a content-type carrying parameters', async () => {
    // `image/png; charset=binary` is still an image; the split-and-trim is what
    // makes that true, and it is easy to lose.
    const dir = tmpDataDir();
    stubFetch({ contentType: 'image/png; charset=binary' });
    expect((await cacheImageUrl(URL_OK, dir))?.hash).toBe(imageHash(URL_OK));
  });

  it('returns null on a non-OK response', async () => {
    const dir = tmpDataDir();
    stubFetch({ status: 404 });
    expect(await cacheImageUrl(URL_OK, dir)).toBeNull();
  });

  it('returns null when the fetch throws, rather than failing the check', async () => {
    // A dead host must mean "no image", never a failed news check.
    const dir = tmpDataDir();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    );
    expect(await cacheImageUrl(URL_OK, dir)).toBeNull();
  });

  it('never fetches a URL the SSRF guard rejects', async () => {
    // The guard runs on a *stored* sourceUrl too: it was checked when first
    // seen, and the name it resolves to today is not the name it resolved to
    // then (FR-8.20).
    const dir = tmpDataDir();
    const fetchSpy = stubFetch({});
    for (const bad of ['http://127.0.0.1/x.jpg', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd']) {
      expect(await cacheImageUrl(bad, dir), bad).toBeNull();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creates the images directory when it is the first download', async () => {
    const dir = tmpDataDir();
    expect(fs.existsSync(imagesDir(dir))).toBe(false);
    stubFetch({});
    await cacheImageUrl(URL_OK, dir);
    expect(fs.existsSync(path.join(imagesDir(dir), `${imageHash(URL_OK)}.bin`))).toBe(true);
  });
});
