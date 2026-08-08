import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner } from '../../src/checks.js';
import { cachedImagePath, imagesDir, liveImageHashes, pruneImageCache } from '../../src/images/cache.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir, tmpStore } from '../helpers/tmp.js';

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

    // Now no story references it — the last one went. Some *other* story still
    // exists, which is what makes the mark set trustworthy enough to sweep on
    // (NEWS-341); an empty set means something else entirely.
    expect(pruneImageCache(dir, new Set([hash(8)]))).toBe(1);
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

  it('removes everything unreferenced once there is anything to compare against', () => {
    // This used to pass an empty set and expect the cache emptied. That was the
    // bug (NEWS-341): every caller derives the set from `store.listItems()`, so
    // "nothing is referenced" is indistinguishable from "the database I read is
    // not the one this cache belongs to" — and one of those costs the user every
    // picture they have. The sweep needs a live story to be meaningful.
    const dir = tmpDataDir();
    seedImage(dir, hash(1));
    seedImage(dir, hash(2));
    seedImage(dir, hash(3));
    expect(pruneImageCache(dir, new Set([hash(3)]))).toBe(2);
    expect(fs.readdirSync(imagesDir(dir))).toEqual([`${hash(3)}.bin`]);
  });
});

describe('DELETE /api/topics prunes the cache', () => {
  it("drops a deleted topic's images but keeps another topic's shared image", async () => {
    const dir = tmpDataDir();
    const store = tmpStore(dir);
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

describe('an empty mark set never sweeps a populated cache (NEWS-341)', () => {
  // What actually happened, in order: a database was quarantined at startup
  // (FR-4.9) and replaced with an empty one; the startup prune then ran against
  // zero items and deleted **every** cached image in the install; the database
  // was later restored from its backup, and 47 stories came back pointing at
  // images that no longer existed. The mark set was wrong, and a mark-and-sweep
  // with a wrong mark set is not a prune, it is a wipe.

  it('keeps every cached image when no story references any of them', () => {
    const dir = tmpDataDir();
    seedImage(dir, hash(1));
    seedImage(dir, hash(2));

    const removed = pruneImageCache(dir, new Set());

    expect(removed).toBe(0);
    expect(exists(dir, hash(1))).toBe(true);
    expect(exists(dir, hash(2))).toBe(true);
  });

  it('still sweeps .tmp files, which nothing can reference', () => {
    // A half-written download is garbage whatever the mark set says, and it is
    // the one thing that is never a live image.
    const dir = tmpDataDir();
    seedImage(dir, hash(1));
    fs.mkdirSync(imagesDir(dir), { recursive: true });
    fs.writeFileSync(path.join(imagesDir(dir), `${hash(9)}.bin.tmp`), 'half');

    const removed = pruneImageCache(dir, new Set());

    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(imagesDir(dir), `${hash(9)}.bin.tmp`))).toBe(false);
    expect(exists(dir, hash(1))).toBe(true);
  });

  it('resumes sweeping as soon as one story exists again', () => {
    // The guard must not become a leak. It suspends the sweep exactly while the
    // set is untrustworthy; the moment there is anything to compare against,
    // genuine orphans go.
    const dir = tmpDataDir();
    seedImage(dir, hash(1));
    seedImage(dir, hash(2));

    expect(pruneImageCache(dir, new Set())).toBe(0);
    expect(pruneImageCache(dir, new Set([hash(1)]))).toBe(1);
    expect(exists(dir, hash(1))).toBe(true);
    expect(exists(dir, hash(2))).toBe(false);
  });

  it('is a no-op on an empty cache, not an error', () => {
    // First run of a fresh install: no stories and no files. Nothing to guard
    // against and nothing to do.
    const dir = tmpDataDir();
    expect(pruneImageCache(dir, new Set())).toBe(0);
  });

  it('survives the sequence that caused this: wipe the database, then prune', () => {
    // The transition, not the states either side of it — a store with stories
    // and images, replaced by an empty store pointed at the same data dir.
    const dir = tmpDataDir();
    const store = tmpStore(dir);
    const topic = store.addTopic('Chips');
    store.addItems([
      {
        topicId: topic.id,
        title: 'Fab news',
        summary: 'a',
        sources: [],
        dedupeKey: 'k1',
        foundAt: '2026-08-01T00:00:00.000Z',
        image: { hash: hash(7), sourceUrl: 'https://example.test/a.jpg' },
      },
    ]);
    seedImage(dir, hash(7));
    store.close();

    // The database is replaced — quarantined and started fresh.
    fs.rmSync(path.join(dir, 'newsmonger.db'), { force: true });
    const fresh = tmpStore(dir);
    expect(fresh.listItems()).toEqual([]);

    pruneImageCache(dir, liveImageHashes(fresh.listItems()));
    fresh.close();

    // The image is still there, so restoring the database brings back a story
    // whose picture still loads.
    expect(exists(dir, hash(7))).toBe(true);
  });
});
