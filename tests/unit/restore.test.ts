import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/mock.js';
import { buildBackup, readBackup, restoreBackup, writeBackup } from '../../src/backup.js';
import { CheckRunner } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

/**
 * Restoring from a backup folder (NEWS-252).
 *
 * Backups were write-only. The only way back in was the legacy `data.json`
 * importer, which reads a **different filename** in a **different directory**
 * and only into an **empty** database — so a user who opened the app once on a
 * new machine was locked out of their own backup, silently. The user's verdict
 * on the workaround: *"we shouldn't have to move data around."*
 */
function seeded() {
  const dir = tmpDataDir();
  const store = new Store(dir);
  const runner = new CheckRunner(store, asResolver(createMockProvider()));
  return { dir, store, runner, app: createApp({ store, runner }) };
}

describe('readBackup', () => {
  it('reports what is in the folder', () => {
    const { store } = seeded();
    store.addTopic('Fusion Energy');
    store.addTopic('Ancient Rome');
    const dest = tmpDataDir();
    writeBackup(store, dest);

    const { preview, data } = readBackup(dest);
    expect(preview.topics).toBe(2);
    expect(preview.path).toBe(path.join(dest, 'newsmonger-backup.json'));
    expect(Date.parse(preview.savedAt)).not.toBeNaN();
    expect(data.topics.map((t) => t.name)).toEqual(['Fusion Energy', 'Ancient Rome']);
  });

  it('names an empty folder as an empty folder', () => {
    // "No backup found in that folder" sends someone to look at the folder,
    // where the answer is. "Restore failed" sends them nowhere.
    expect(() => readBackup(tmpDataDir())).toThrow(/no newsmonger-backup\.json/);
  });

  it('names an unreadable file as unreadable', () => {
    const dest = tmpDataDir();
    fs.writeFileSync(path.join(dest, 'newsmonger-backup.json'), '{ not json');
    expect(() => readBackup(dest)).toThrow(/not a readable Newsmonger backup/);
  });
});

describe('restoreBackup replaces everything (NEWS-252)', () => {
  it('brings back topics, stories, guidance and settings', () => {
    const source = seeded();
    const t = source.store.addTopic('Fusion Energy', { guidance: 'reactors only' });
    source.store.addItems([
      {
        topicId: t.id,
        title: 'A milestone',
        summary: 'S',
        sources: [],
        dedupeKey: 'a-milestone',
        foundAt: '2026-07-01T00:00:00Z',
      },
    ]);
    source.store.updateSettings({ checkIntervalMs: 3_600_000, effort: 'high' });
    const dest = tmpDataDir();
    writeBackup(source.store, dest);

    // A different machine: different data, already used.
    const target = seeded();
    target.store.addTopic('Something Else');
    target.store.updateSettings({ backupDir: dest, effort: 'low' });

    restoreBackup(target.store, dest);

    const topics = target.store.listTopics();
    expect(topics.map((x) => x.name)).toEqual(['Fusion Energy']);
    expect(topics[0]?.guidance).toBe('reactors only');
    expect(target.store.listItems()).toHaveLength(1);
    expect(target.store.getSettings().checkIntervalMs).toBe(3_600_000);
    expect(target.store.getSettings().effort).toBe('high');
  });

  it('keeps the backup folder this machine is configured with', () => {
    // The path inside a snapshot is where the *old* machine wrote, which on a
    // new one is usually a folder that doesn't exist. Adopting it would quietly
    // stop backups on exactly the machine that just proved it needs them —
    // silently, since backup failures are best-effort by design.
    const source = seeded();
    source.store.updateSettings({ backupDir: '/old/machine/path' });
    const dest = tmpDataDir();
    writeBackup(source.store, dest);

    const target = seeded();
    target.store.updateSettings({ backupDir: dest });
    restoreBackup(target.store, dest);

    expect(target.store.getSettings().backupDir).toBe(dest);
  });

  it('saves what was there first', () => {
    // The one action in the app that destroys data the user didn't ask to
    // delete. "I clicked restore and lost the topics I'd added since" has no
    // answer unless the old state is still somewhere.
    const source = seeded();
    source.store.addTopic('Restored Topic');
    const dest = tmpDataDir();
    writeBackup(source.store, dest);

    const target = seeded();
    target.store.addTopic('About To Be Replaced');
    const { safetyCopy } = restoreBackup(target.store, dest);

    expect(fs.existsSync(safetyCopy)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(safetyCopy, 'utf8')) as { topics: { name: string }[] };
    expect(saved.topics.map((x) => x.name)).toEqual(['About To Be Replaced']);
    // In the data directory, not the backup folder: it must not be mistaken for
    // a backup to restore *from*, nor be clobbered by the sync client that owns
    // that folder.
    expect(path.dirname(safetyCopy)).toBe(target.store.dataDir);
  });

  it('leaves the database untouched when the snapshot is unusable', () => {
    // Half-applied — topics replaced, stories not — would be worse than either
    // state on its own.
    const target = seeded();
    target.store.addTopic('Still Here');
    const dest = tmpDataDir();
    fs.writeFileSync(path.join(dest, 'newsmonger-backup.json'), '{ not json');

    expect(() => restoreBackup(target.store, dest)).toThrow();
    expect(target.store.listTopics().map((x) => x.name)).toEqual(['Still Here']);
  });

  it('round-trips: restore a backup of a restore', () => {
    // A stateful path deserves a sequence, not one operation from a clean start.
    const a = seeded();
    a.store.addTopic('Alpha');
    const dest = tmpDataDir();
    writeBackup(a.store, dest);

    const b = seeded();
    restoreBackup(b.store, dest);
    b.store.addTopic('Beta');
    const dest2 = tmpDataDir();
    writeBackup(b.store, dest2);

    const c = seeded();
    restoreBackup(c.store, dest2);
    expect(c.store.listTopics().map((x) => x.name).sort()).toEqual(['Alpha', 'Beta']);
  });
});

describe('the restore routes (NEWS-252)', () => {
  it('previews the configured folder', async () => {
    const { store, app } = seeded();
    store.addTopic('Fusion Energy');
    const dest = tmpDataDir();
    writeBackup(store, dest);
    store.updateSettings({ backupDir: dest });

    const res = await app.request('/api/backup/preview');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ preview: { topics: 1 } });
  });

  it('400s with no folder chosen, 404s with an empty one', async () => {
    // Different problems with different fixes, so different answers — not one
    // "restore unavailable".
    const { store, app } = seeded();
    expect((await app.request('/api/backup/preview')).status).toBe(400);
    store.updateSettings({ backupDir: tmpDataDir() });
    expect((await app.request('/api/backup/preview')).status).toBe(404);
  });

  it('422s on a file it cannot read', async () => {
    const { store, app } = seeded();
    const dest = tmpDataDir();
    fs.writeFileSync(path.join(dest, 'newsmonger-backup.json'), 'nonsense');
    store.updateSettings({ backupDir: dest });
    expect((await app.request('/api/backup/preview')).status).toBe(422);
  });

  it('restores through the route and reports the safety copy', async () => {
    const source = seeded();
    source.store.addTopic('Fusion Energy');
    const dest = tmpDataDir();
    writeBackup(source.store, dest);

    const target = seeded();
    target.store.addTopic('Replace Me');
    target.store.updateSettings({ backupDir: dest });

    const res = await target.app.request('/api/backup/restore', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { safetyCopy: string; preview: { topics: number } };
    expect(body.preview.topics).toBe(1);
    expect(fs.existsSync(body.safetyCopy)).toBe(true);
    expect(target.store.listTopics().map((x) => x.name)).toEqual(['Fusion Energy']);
  });

  it('refuses while a check is running', async () => {
    // A check finishing mid-restore would write stories belonging to the old
    // data into the new — neither snapshot, and it would look like it worked.
    const dir = tmpDataDir();
    const store = new Store(dir);
    let release = (): void => undefined;
    const provider = createMockProvider();
    const runner = new CheckRunner(
      store,
      asResolver({
        ...provider,
        checkTopic: () => new Promise((resolve) => (release = () => { resolve({ items: [], usage: null }); })),
      }),
    );
    const app = createApp({ store, runner });
    const dest = tmpDataDir();
    writeBackup(store, dest);
    store.updateSettings({ backupDir: dest });

    const topic = store.addTopic('Slow Topic');
    const inFlight = runner.checkTopic(topic.id, { manual: true });
    await new Promise((r) => setTimeout(r, 10));

    const res = await app.request('/api/backup/restore', { method: 'POST' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('check is running');

    release();
    await inFlight;
  });
});

describe('buildBackup still excludes credentials', () => {
  it('has no key-shaped fields', () => {
    // Restoring makes the backup travel between machines, so this promise
    // matters more than it did when the file only ever sat in a folder.
    const { store } = seeded();
    store.addTopic('Fusion Energy');
    expect(JSON.stringify(buildBackup(store))).not.toMatch(/"(apiKey|api_key|secret|token)"/i);
  });
});
