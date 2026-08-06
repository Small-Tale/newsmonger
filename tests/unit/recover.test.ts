import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner } from '../../src/checks.js';
import { dbPath } from '../../src/db/sqlite.js';
import { Store } from '../../src/db/store.js';
import { isSetAsideName, listSetAside, recoverSetAside } from '../../src/recover.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

/**
 * Getting back a database that was set aside (NEWS-342).
 *
 * FR-4.9 renames a database it cannot open and starts fresh; FR-4.17 says where
 * it went. This is the answer to the question that follows, and the thing it
 * must never do is make the situation worse — someone acting on that banner has
 * already lost data once.
 */

/** A data dir holding a real set-aside database with `topics` in it. */
function withSetAside(names: string[]): { dir: string; file: string } {
  const dir = tmpDataDir();
  const seed = new Store(dir);
  for (const name of names) seed.addTopic(name);
  seed.close();

  const file = `newsmonger.db.corrupt-${String(Date.now())}`;
  fs.copyFileSync(dbPath(dir), path.join(dir, file));
  fs.rmSync(dbPath(dir), { force: true });
  fs.rmSync(`${dbPath(dir)}-wal`, { force: true });
  fs.rmSync(`${dbPath(dir)}-shm`, { force: true });
  return { dir, file };
}

describe('isSetAsideName (NEWS-342)', () => {
  it('accepts only the names FR-4.9 produces', () => {
    expect(isSetAsideName('newsmonger.db.corrupt-1785991465508')).toBe(true);
    expect(isSetAsideName('newsmonger.db')).toBe(false);
    expect(isSetAsideName('newsmonger.db.corrupt-1785991465508-wal')).toBe(false);
  });

  it('rejects anything that could name a file elsewhere', () => {
    // The name is what the API takes back, so this check is also what makes the
    // path join safe.
    for (const bad of [
      '../newsmonger.db.corrupt-1',
      '/etc/passwd',
      'newsmonger.db.corrupt-1/../../x',
      'sub/newsmonger.db.corrupt-1',
      'newsmonger.db.corrupt-',
    ]) {
      expect(isSetAsideName(bad), bad).toBe(false);
    }
  });
});

describe('listSetAside (NEWS-342)', () => {
  it('finds a set-aside database and says what is in it', () => {
    const { dir, file } = withSetAside(['Chips', 'Batteries']);
    const found = listSetAside(dir);

    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe(file);
    expect(found[0]?.contents).toEqual({ topics: 2, items: 0, runs: 0 });
    expect(found[0]?.error).toBeNull();
    expect(found[0]?.sizeBytes).toBeGreaterThan(0);
  });

  it('is empty for an ordinary data directory', () => {
    const dir = tmpDataDir();
    new Store(dir).close();
    expect(listSetAside(dir)).toEqual([]);
  });

  it('does not modify the file it inspects', () => {
    // `openDb` migrates what it opens, and this is the user's only copy. Reading
    // it must not be the thing that changes it.
    const { dir, file } = withSetAside(['Chips']);
    const target = path.join(dir, file);
    const before = fs.readFileSync(target);

    listSetAside(dir);

    expect(fs.readFileSync(target).equals(before)).toBe(true);
  });

  it('reports a file it still cannot read, without hiding the others', () => {
    const { dir } = withSetAside(['Readable']);
    const broken = path.join(dir, 'newsmonger.db.corrupt-1000000000000');
    fs.writeFileSync(broken, Buffer.alloc(4096, 0x41));

    const found = listSetAside(dir);
    expect(found).toHaveLength(2);
    const bad = found.find((d) => d.file.endsWith('1000000000000'));
    expect(bad?.contents).toBeNull();
    expect(bad?.error).toBeTruthy();
    // The readable one is still reported, with its contents.
    expect(found.find((d) => d !== bad)?.contents?.topics).toBe(1);
  });

  it('survives a data directory that is not there', () => {
    expect(listSetAside(path.join(tmpDataDir(), 'nope'))).toEqual([]);
  });
});

describe('recoverSetAside (NEWS-342)', () => {
  it('replaces the live database with the set-aside one', () => {
    const { dir, file } = withSetAside(['Chips', 'Batteries']);
    const live = new Store(dir);
    live.addTopic('Typed since');

    const result = recoverSetAside(live, file);

    expect(result.topics).toBe(2);
    expect(live.listTopics().map((t) => t.name).sort()).toEqual(['Batteries', 'Chips']);
    live.close();
  });

  it('writes what it is about to replace to a safety copy first', () => {
    // Someone recovering has already lost data once. Whatever they typed in the
    // meantime is not silently the price of getting the rest back.
    const { dir, file } = withSetAside(['Chips']);
    const live = new Store(dir);
    live.addTopic('Typed since');

    const { safetyCopy } = recoverSetAside(live, file);

    expect(fs.existsSync(safetyCopy)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(safetyCopy, 'utf8')) as { topics: { name: string }[] };
    expect(saved.topics.map((t) => t.name)).toEqual(['Typed since']);
    live.close();
  });

  it('leaves the set-aside file in place, so it can be tried again', () => {
    const { dir, file } = withSetAside(['Chips']);
    const live = new Store(dir);

    recoverSetAside(live, file);

    expect(fs.existsSync(path.join(dir, file))).toBe(true);
    // And it is still listed, because recovering is a copy and not a move.
    expect(listSetAside(dir)).toHaveLength(1);
    live.close();
  });

  it('answers the quarantine notice', () => {
    const dir = tmpDataDir();
    const seed = new Store(dir);
    seed.addTopic('Chips');
    seed.close();
    const file = `newsmonger.db.corrupt-${String(Date.now())}`;
    fs.copyFileSync(dbPath(dir), path.join(dir, file));

    // Provoke a real quarantine so there is a genuine notice to answer.
    fs.writeFileSync(dbPath(dir), Buffer.alloc(fs.statSync(dbPath(dir)).size, 0x41));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const live = new Store(dir);
    expect(live.getQuarantine()).not.toBeNull();

    recoverSetAside(live, file);

    expect(live.getQuarantine()).toBeNull();
    expect(live.listTopics().map((t) => t.name)).toEqual(['Chips']);
    live.close();
  });

  it('refuses a name that is not a set-aside database', () => {
    const dir = tmpDataDir();
    const live = new Store(dir);
    expect(() => recoverSetAside(live, '../../etc/passwd')).toThrow(/not a set-aside database/);
    live.close();
  });
});

describe('the recovery API (NEWS-342)', () => {
  function appFor(dir: string, store: Store) {
    return createApp({ store, runner: new CheckRunner(store, asResolver(createMockProvider())), dataDir: dir });
  }

  it('lists candidates with their contents', async () => {
    const { dir, file } = withSetAside(['Chips', 'Batteries']);
    const res = await appFor(dir, new Store(dir)).request('/api/recover/candidates');
    const body = (await res.json()) as { databases: { file: string; contents: { topics: number } | null }[] };
    expect(body.databases[0]?.file).toBe(file);
    expect(body.databases[0]?.contents?.topics).toBe(2);
  });

  it('recovers through POST /api/recover', async () => {
    const { dir, file } = withSetAside(['Chips', 'Batteries']);
    const store = new Store(dir);
    const app = appFor(dir, store);

    const res = await app.request('/api/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { topics: number }).topics).toBe(2);
    expect(store.listTopics()).toHaveLength(2);
  });

  it('404s a file that is not there, and one that is not ours', async () => {
    const dir = tmpDataDir();
    const app = appFor(dir, new Store(dir));
    for (const file of ['newsmonger.db.corrupt-1', '../../etc/passwd', 'newsmonger.db']) {
      const res = await app.request('/api/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      });
      expect(res.status, file).toBe(404);
    }
  });

  it('422s a file it still cannot read, with the reason', async () => {
    const dir = tmpDataDir();
    const store = new Store(dir);
    store.addTopic('Kept');
    const broken = 'newsmonger.db.corrupt-1000000000000';
    fs.writeFileSync(path.join(dir, broken), Buffer.alloc(4096, 0x41));

    const res = await appFor(dir, store).request('/api/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: broken }),
    });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
    // And the live database is untouched — a failed recovery changes nothing.
    expect(store.listTopics().map((t) => t.name)).toEqual(['Kept']);
  });
});
