import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { cachedImagePath, imagesDir, liveImageHashes, pruneImageCache } from '../../src/images/cache.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

const hash = (n: number): string => n.toString(16).padStart(32, '0');

/** Write a cached image file for `hash`. */
function seedImage(dir: string, h: string): void {
  fs.mkdirSync(imagesDir(dir), { recursive: true });
  fs.writeFileSync(cachedImagePath(dir, h), Buffer.from('image-bytes'));
}

function exists(dir: string, h: string): boolean {
  return fs.existsSync(cachedImagePath(dir, h));
}

describe('liveImageHashes', () => {
  it('collects hashes from items that have an image, skipping the rest', () => {
    const items = [
      { image: { hash: 'a' } },
      { image: null },
      { image: { hash: 'b' } },
    ];
    expect(liveImageHashes(items)).toEqual(new Set(['a', 'b']));
  });

  it('dedupes a shared hash into a single entry', () => {
    // Two stories citing the same image URL → same hash. That's the reference
    // count: the set carries one entry, present as long as either survives.
    const items = [{ image: { hash: 'shared' } }, { image: { hash: 'shared' } }];
    expect(liveImageHashes(items)).toEqual(new Set(['shared']));
  });
});

describe('pruneImageCache', () => {
  it('deletes files no live item references, keeps the referenced ones', () => {
    const dir = tmpDataDir();
    seedImage(dir, hash(1)); // referenced
    seedImage(dir, hash(2)); // orphan
    seedImage(dir, hash(3)); // orphan

    const removed = pruneImageCache(dir, new Set([hash(1)]));

    expect(removed).toBe(2);
    expect(exists(dir, hash(1))).toBe(true);
    expect(exists(dir, hash(2))).toBe(false);
    expect(exists(dir, hash(3))).toBe(false);
  });

  it('keeps a shared image while ANY referencing item remains', () => {
    // The case the ticket flags: deleting one of two stories that share an
    // image must not orphan the survivor's picture.
    const dir = tmpDataDir();
    seedImage(dir, hash(7));

    // Still referenced by the surviving story.
    const removed = pruneImageCache(dir, new Set([hash(7)]));
    expect(removed).toBe(0);
    expect(exists(dir, hash(7))).toBe(true);

    // Now no story references it — the last one went.
    expect(pruneImageCache(dir, new Set())).toBe(1);
    expect(exists(dir, hash(7))).toBe(false);
  });

  it('sweeps stray .tmp files from an interrupted download', () => {
    const dir = tmpDataDir();
    fs.mkdirSync(imagesDir(dir), { recursive: true });
    fs.writeFileSync(path.join(imagesDir(dir), `${hash(1)}.bin.tmp`), 'partial');
    seedImage(dir, hash(1));

    const removed = pruneImageCache(dir, new Set([hash(1)]));
    expect(removed).toBe(1); // the .tmp
    expect(exists(dir, hash(1))).toBe(true);
    expect(fs.existsSync(path.join(imagesDir(dir), `${hash(1)}.bin.tmp`))).toBe(false);
  });

  it('leaves unrelated files alone', () => {
    const dir = tmpDataDir();
    fs.mkdirSync(imagesDir(dir), { recursive: true });
    fs.writeFileSync(path.join(imagesDir(dir), 'README.txt'), 'not an image');
    seedImage(dir, hash(1));

    pruneImageCache(dir, new Set());
    expect(fs.existsSync(path.join(imagesDir(dir), 'README.txt'))).toBe(true);
  });

  it('is a no-op when the cache directory does not exist', () => {
    expect(pruneImageCache(tmpDataDir(), new Set([hash(1)]))).toBe(0);
  });

  it('removes everything when nothing is referenced', () => {
    const dir = tmpDataDir();
    seedImage(dir, hash(1));
    seedImage(dir, hash(2));
    expect(pruneImageCache(dir, new Set())).toBe(2);
    expect(fs.readdirSync(imagesDir(dir))).toEqual([]);
  });
});

describe('DELETE /api/topics prunes the cache', () => {
  it("drops a deleted topic's images but keeps another topic's shared image", async () => {
    const dir = tmpDataDir();
    const store = new Store(dir);
    const keep = store.addTopic('keep');
    const drop = store.addTopic('drop');

    // 'drop' has a unique image; both topics share another.
    store.addItems([
      { topicId: keep.id, title: 'k', summary: '', sources: [], dedupeKey: 'k', foundAt: '2026-07-24T00:00:00.000Z', image: { hash: hash(1), sourceUrl: 'u1' } },
      { topicId: drop.id, title: 'd1', summary: '', sources: [], dedupeKey: 'd1', foundAt: '2026-07-24T00:00:00.000Z', image: { hash: hash(2), sourceUrl: 'u2' } },
      { topicId: drop.id, title: 'd2', summary: '', sources: [], dedupeKey: 'd2', foundAt: '2026-07-24T00:00:00.000Z', image: { hash: hash(1), sourceUrl: 'u1' } },
    ]);
    seedImage(dir, hash(1)); // shared by keep + drop
    seedImage(dir, hash(2)); // drop-only

    const runner = new CheckRunner(store, asResolver(createMockProvider()));
    const app = createApp({ store, runner, dataDir: dir });

    const res = await app.request(`/api/topics/${drop.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    // hash(2) was only drop's — gone. hash(1) still belongs to keep — stays.
    expect(exists(dir, hash(1))).toBe(true);
    expect(exists(dir, hash(2))).toBe(false);
  });
});
