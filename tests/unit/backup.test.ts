import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BACKUP_FILE, Backups, buildBackup, MIN_BACKUP_INTERVAL_MS, writeBackup } from '../../src/backup.js';
import { DataFileSchema } from '../../src/db/schemas.js';
import type { Store } from '../../src/db/store.js';
import { tmpDataDir, tmpStore } from '../helpers/tmp.js';

function seeded(): { store: Store; dir: string } {
  const dir = tmpDataDir();
  const store = tmpStore(dir);
  const topic = store.addTopic('Comets');
  store.addItems([
    {
      topicId: topic.id,
      title: 'A comet arrives',
      summary: 'It is bright.',
      sources: [{ title: 'Example', url: 'https://example.com/comet', outlet: null, publishedAt: null, favicon: null }],
      dedupeKey: 'comet-arrives',
      foundAt: '2026-07-01T00:00:00Z',
    },
  ]);
  store.updateSettings({ checkIntervalMs: 90 * 60 * 1000 });
  return { store, dir };
}

describe('buildBackup', () => {
  it('captures topics, items, settings and runs', () => {
    const { store } = seeded();
    const backup = buildBackup(store);
    expect(backup.topics.map((t) => t.name)).toEqual(['Comets']);
    expect(backup.items).toHaveLength(1);
    expect(backup.settings.checkIntervalMs).toBe(90 * 60 * 1000);
    expect(Array.isArray(backup.runs)).toBe(true);
    store.close();
  });

  /**
   * The whole point of the format choice: a backup must be restorable by the
   * legacy `data.json` import path (FR-4.8a) with no restore-specific code. If
   * this ever stops parsing, backups have quietly become unrestorable.
   */
  it('produces an artifact the legacy data.json importer accepts', () => {
    const { store, dir } = seeded();
    const at = writeBackup(store, path.join(dir, 'backups'));
    store.close();

    const parsed = DataFileSchema.safeParse(JSON.parse(fs.readFileSync(at, 'utf8')));
    expect(parsed.success).toBe(true);

    // And end to end: drop it into an empty data dir as data.json and the
    // store should come up with the same content.
    const restoreDir = tmpDataDir();
    fs.writeFileSync(path.join(restoreDir, 'data.json'), fs.readFileSync(at));
    const restored = tmpStore(restoreDir);
    expect(restored.listTopics().map((t) => t.name)).toEqual(['Comets']);
    expect(restored.listItems()).toHaveLength(1);
    expect(restored.getSettings().checkIntervalMs).toBe(90 * 60 * 1000);
    restored.close();
  });

  /**
   * API keys live in the keychain, never in `Settings` — but a future settings
   * field could change that silently, and this backup lands in a folder the
   * user syncs to a third party. Assert on the serialised bytes, not the type.
   */
  it('never carries anything key-shaped', () => {
    const { store, dir } = seeded();
    const at = writeBackup(store, dir);
    const text = fs.readFileSync(at, 'utf8');
    store.close();
    expect(text).not.toMatch(/sk-ant-/);
    expect(text).not.toMatch(/"(apiKey|api_key|secret|token|credential)"/i);
  });
});

describe('writeBackup', () => {
  it('creates the destination folder and leaves no temp file behind', () => {
    const { store, dir } = seeded();
    const dest = path.join(dir, 'nested', 'backups');
    const at = writeBackup(store, dest);
    store.close();
    expect(at).toBe(path.join(dest, BACKUP_FILE));
    expect(fs.readdirSync(dest)).toEqual([BACKUP_FILE]);
  });

  it('replaces an earlier backup rather than appending to it', () => {
    const { store, dir } = seeded();
    const dest = path.join(dir, 'backups');
    writeBackup(store, dest);
    store.addTopic('Eclipses');
    const at = writeBackup(store, dest);
    store.close();
    const parsed = DataFileSchema.parse(JSON.parse(fs.readFileSync(at, 'utf8')));
    expect(parsed.topics.map((t) => t.name).sort()).toEqual(['Comets', 'Eclipses']);
  });
});

describe('Backups', () => {
  it('does nothing while no folder is chosen', () => {
    const { store } = seeded();
    const backups = new Backups(store, () => '');
    expect(backups.maybeWrite()).toBeNull();
    expect(backups.write()).toBeNull();
    store.close();
  });

  it('throttles repeated writes, and picks up a folder chosen later', () => {
    const { store, dir } = seeded();
    const dest = path.join(dir, 'backups');
    let chosen = '';
    let now = 1_000_000;
    const backups = new Backups(
      store,
      () => chosen,
      () => now,
    );

    // Off, then on: the setting is read fresh, so no restart is needed.
    expect(backups.maybeWrite()).toBeNull();
    chosen = dest;
    expect(backups.maybeWrite()).not.toBeNull();

    // A sweep of many topics finishing back to back writes once.
    now += 1000;
    expect(backups.maybeWrite()).toBeNull();
    now += MIN_BACKUP_INTERVAL_MS;
    expect(backups.maybeWrite()).not.toBeNull();

    // ...but an explicit "back up now" ignores the throttle entirely.
    expect(backups.write()).not.toBeNull();
    store.close();
  });

  /**
   * The throttle has to survive a restart, or an app quit and reopened a few
   * times an hour rewrites the whole snapshot on each launch.
   */
  it('honours a backup written by an earlier process', () => {
    const { store, dir } = seeded();
    const dest = path.join(dir, 'backups');
    writeBackup(store, dest);
    const at = path.join(dest, BACKUP_FILE);
    const before = fs.statSync(at).mtimeMs;

    // Fresh instance: nothing in memory says a backup was just written.
    const backups = new Backups(store, () => dest);
    expect(backups.maybeWrite()).toBeNull();
    expect(fs.statSync(at).mtimeMs).toBe(before);

    // Anchor the simulated clock to the timestamp the production code reads.
    // On Windows a freshly-written file's mtime can sit slightly ahead of a
    // separate Date.now() sample, so advancing that different clock by one
    // interval does not reliably make the file stale.
    const boundary = new Backups(
      store,
      () => dest,
      () => before + MIN_BACKUP_INTERVAL_MS - 1,
    );
    expect(boundary.maybeWrite()).toBeNull();

    // Once the file is old enough, it writes again.
    const stale = new Backups(store, () => dest, () => before + MIN_BACKUP_INTERVAL_MS);
    expect(stale.maybeWrite()).not.toBeNull();
    store.close();
  });

  it('reports a failed write without throwing', () => {
    const { store, dir } = seeded();
    // A file where the folder should be: mkdirSync fails, and a check that
    // triggered this must still succeed.
    const blocked = path.join(dir, 'not-a-folder');
    fs.writeFileSync(blocked, 'x');
    const errors: string[] = [];
    const backups = new Backups(
      store,
      () => blocked,
      () => Date.now(),
      (m) => errors.push(m),
    );
    expect(backups.maybeWrite()).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('backup');
    store.close();
  });
});
