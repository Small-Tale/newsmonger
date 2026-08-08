import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, vi } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner } from '../../src/checks.js';
import { dbPath } from '../../src/db/sqlite.js';
import type { Store } from '../../src/db/store.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir, tmpStore } from '../helpers/tmp.js';

/**
 * Telling the user their database was set aside (NEWS-340).
 *
 * FR-4.9 answers a genuinely unreadable file by renaming it aside and starting
 * fresh. That is the right contract — the file cannot be repaired from in here,
 * and refusing to start would leave no way in — but until this existed the only
 * notice was a `console.error`, on a stream the desktop app does not show. The
 * user's entire account of what had happened was an empty topic list, which is
 * indistinguishable from total loss and invites them to type new data over it.
 *
 * The notice lives in `meta` rather than in memory because the moment someone
 * *notices* their topics are gone is usually the launch after the one that lost
 * them.
 */

/** Replace the database with bytes SQLite must reject, then reopen. */
function quarantine(dir: string): Store {
  const file = dbPath(dir);
  fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size, 0x41));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return tmpStore(dir);
}

describe('Store quarantine notice (NEWS-340)', () => {
  it('records the backup path and when it happened', () => {
    const dir = tmpDataDir();
    const first = tmpStore(dir);
    first.addTopic('Doomed');
    first.close();

    const recovered = quarantine(dir);
    const notice = recovered.getQuarantine();

    expect(notice).not.toBeNull();
    expect(notice?.backupPath).toMatch(/\.corrupt-\d+$/);
    // The path it names has to be a file that is actually there — this is the
    // only route back to the data, so a notice pointing at nothing is worse
    // than no notice at all.
    expect(fs.existsSync(notice?.backupPath ?? '')).toBe(true);
    expect(Date.parse(notice?.at ?? '')).not.toBeNaN();
    recovered.close();
  });

  it('is absent on an ordinary start', () => {
    const dir = tmpDataDir();
    const store = tmpStore(dir);
    expect(store.getQuarantine()).toBeNull();
    store.close();

    // And on a perfectly normal *reopen*, which is the common case by far.
    const again = tmpStore(dir);
    expect(again.getQuarantine()).toBeNull();
    again.close();
  });

  it('survives a restart, because that is when it gets read', () => {
    // Held in memory it would be gone by the time anyone looked. The launch
    // where the data disappears is rarely the launch where it is noticed.
    const dir = tmpDataDir();
    tmpStore(dir).close();
    quarantine(dir).close();

    const later = tmpStore(dir);
    expect(later.getQuarantine()).not.toBeNull();
    later.close();
  });

  it('stays dismissed once dismissed', () => {
    const dir = tmpDataDir();
    tmpStore(dir).close();
    const recovered = quarantine(dir);
    recovered.dismissQuarantine();
    expect(recovered.getQuarantine()).toBeNull();
    recovered.close();

    const later = tmpStore(dir);
    expect(later.getQuarantine()).toBeNull();
    later.close();
  });

  it('dismissing leaves the backup file exactly where it is', () => {
    // Dismissing says "I have read this", never "delete that copy".
    const dir = tmpDataDir();
    tmpStore(dir).close();
    const recovered = quarantine(dir);
    const backup = recovered.getQuarantine()?.backupPath ?? '';

    recovered.dismissQuarantine();

    expect(fs.existsSync(backup)).toBe(true);
    recovered.close();
  });

  it('dismissing twice is not an error', () => {
    const dir = tmpDataDir();
    tmpStore(dir).close();
    const recovered = quarantine(dir);
    recovered.dismissQuarantine();
    expect(() => {
      recovered.dismissQuarantine();
    }).not.toThrow();
    recovered.close();
  });

  it('treats an unreadable notice as no notice', () => {
    // This row is the thing that reports a storage problem. It must not become
    // a second storage problem.
    const dir = tmpDataDir();
    const store = tmpStore(dir);
    store.close();

    const raw = new DatabaseSync(dbPath(dir));
    raw.prepare(`INSERT INTO meta (key, value) VALUES ('quarantine', '{"nope":1}')`).run();
    raw.close();

    const reopened = tmpStore(dir);
    expect(reopened.getQuarantine()).toBeNull();
    reopened.close();
  });
});

describe('the quarantine notice through the API (NEWS-340)', () => {
  function appFor(dir: string, store: Store) {
    return createApp({ store, runner: new CheckRunner(store, asResolver(createMockProvider())), dataDir: dir });
  }

  it('rides along on /api/state so the poll picks it up', async () => {
    const dir = tmpDataDir();
    tmpStore(dir).close();
    const store = quarantine(dir);

    const res = await appFor(dir, store).request('/api/state');
    const body = (await res.json()) as { quarantine: { backupPath: string } | null };
    expect(body.quarantine?.backupPath).toMatch(/\.corrupt-\d+$/);
  });

  it('is null in the normal case, not absent', async () => {
    // The client parses the whole response with zod; a missing key would be a
    // parse failure that blanks every other thing on the page.
    const dir = tmpDataDir();
    const res = await appFor(dir, tmpStore(dir)).request('/api/state');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('quarantine');
    expect(body['quarantine']).toBeNull();
  });

  it('POST /api/quarantine/dismiss clears it for good', async () => {
    const dir = tmpDataDir();
    tmpStore(dir).close();
    const store = quarantine(dir);
    const app = appFor(dir, store);

    expect((await app.request('/api/quarantine/dismiss', { method: 'POST' })).status).toBe(200);

    const body = (await (await app.request('/api/state')).json()) as { quarantine: unknown };
    expect(body.quarantine).toBeNull();
  });

  it('dismissing when there is nothing to dismiss is still fine', async () => {
    const dir = tmpDataDir();
    const app = appFor(dir, tmpStore(dir));
    expect((await app.request('/api/quarantine/dismiss', { method: 'POST' })).status).toBe(200);
  });
});
