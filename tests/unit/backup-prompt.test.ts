import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BACKUP_SUBDIR, suggestedBackupLocations } from '../../src/backup-locations.js';
import {
  OFFER_AFTER_TOPICS,
  shouldOfferBackup,
  SNOOZE_MS,
  snoozeUntil,
} from '../../src/client/backup-prompt.js';
import { tmpDataDir } from '../helpers/tmp.js';

const NOW = Date.parse('2026-07-31T12:00:00Z');

/** The state in which the offer *should* appear — each test breaks one thing. */
function offerable(over: Partial<Parameters<typeof shouldOfferBackup>[0]> = {}) {
  return {
    topicCount: OFFER_AFTER_TOPICS,
    backupDir: '',
    never: false,
    snoozedUntil: '',
    now: NOW,
    ...over,
  };
}

describe('shouldOfferBackup (NEWS-230, FR-27.2/27.4)', () => {
  it('offers once the third topic exists', () => {
    expect(shouldOfferBackup(offerable())).toBe(true);
    expect(shouldOfferBackup(offerable({ topicCount: OFFER_AFTER_TOPICS - 1 }))).toBe(false);
    expect(shouldOfferBackup(offerable({ topicCount: 0 }))).toBe(false);
    // And keeps offering past the threshold — someone who added ten topics in
    // one sitting should not have missed the offer by overshooting.
    expect(shouldOfferBackup(offerable({ topicCount: 10 }))).toBe(true);
  });

  it('never offers once a folder is chosen', () => {
    // The offer is "pick a folder". There is nothing left to ask.
    expect(shouldOfferBackup(offerable({ backupDir: '/somewhere' }))).toBe(false);
    // Even if a stale snooze or a large topic count would otherwise say yes.
    expect(shouldOfferBackup(offerable({ backupDir: '/somewhere', topicCount: 50 }))).toBe(false);
  });

  it('"Don\'t ask again" is permanent', () => {
    expect(shouldOfferBackup(offerable({ never: true }))).toBe(false);
    // Including a year later, which is the whole promise.
    expect(shouldOfferBackup(offerable({ never: true, now: NOW + 365 * 24 * 3600_000 }))).toBe(false);
  });

  it('"Not now" holds for a day and then lapses', () => {
    const snoozedUntil = snoozeUntil(NOW);
    expect(shouldOfferBackup(offerable({ snoozedUntil, now: NOW }))).toBe(false);
    expect(shouldOfferBackup(offerable({ snoozedUntil, now: NOW + SNOOZE_MS - 1 }))).toBe(false);
    expect(shouldOfferBackup(offerable({ snoozedUntil, now: NOW + SNOOZE_MS }))).toBe(true);
    expect(shouldOfferBackup(offerable({ snoozedUntil, now: NOW + SNOOZE_MS + 1 }))).toBe(true);
  });

  /**
   * The failure mode worth pinning: if an unreadable timestamp counted as
   * "expired", one corrupt field would produce a dialog on every single state
   * poll, which the user could not dismiss except by answering permanently.
   */
  it('treats an unparseable snooze as still snoozed, not as expired', () => {
    expect(shouldOfferBackup(offerable({ snoozedUntil: 'not a date' }))).toBe(false);
    expect(shouldOfferBackup(offerable({ snoozedUntil: 'not a date', now: NOW + 1e12 }))).toBe(false);
  });

  it('snoozeUntil is exactly a day out, in ISO form', () => {
    const iso = snoozeUntil(NOW);
    expect(Date.parse(iso) - NOW).toBe(SNOOZE_MS);
    expect(iso).toBe(new Date(NOW + SNOOZE_MS).toISOString());
  });
});

describe('suggestedBackupLocations (NEWS-230, FR-27.5)', () => {
  /** Build a fake home directory containing exactly the given subpaths. */
  function home(...dirs: string[]): string {
    const root = tmpDataDir();
    for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
    return root;
  }

  it('offers nothing when nothing is there', () => {
    // The whole point of probing: a machine with no sync client gets an empty
    // list, not a plausible-looking path that fails at the first write.
    expect(suggestedBackupLocations(home(), 'darwin')).toEqual([]);
    expect(suggestedBackupLocations(home(), 'win32')).toEqual([]);
    expect(suggestedBackupLocations(home(), 'linux')).toEqual([]);
  });

  it('finds iCloud Drive on macOS, and appends the app subfolder', () => {
    const h = home('Library/Mobile Documents/com~apple~CloudDocs');
    const found = suggestedBackupLocations(h, 'darwin');
    expect(found).toHaveLength(1);
    expect(found[0].label).toBe('iCloud Drive');
    expect(found[0].path).toBe(
      path.join(h, 'Library/Mobile Documents/com~apple~CloudDocs', BACKUP_SUBDIR),
    );
  });

  /**
   * The reason a plain path list isn't enough: modern macOS mounts carry the
   * account in the directory name, so there is no fixed path to test.
   */
  it('finds account-suffixed CloudStorage mounts on macOS', () => {
    const h = home(
      'Library/CloudStorage/GoogleDrive-someone@gmail.com',
      'Library/CloudStorage/OneDrive-Contoso',
    );
    const found = suggestedBackupLocations(h, 'darwin');
    expect(found.map((l) => l.label)).toEqual(['Google Drive', 'OneDrive']);
    expect(found[0].path).toContain('GoogleDrive-someone@gmail.com');
  });

  it('finds several accounts of one product', () => {
    const h = home(
      'Library/CloudStorage/GoogleDrive-work@example.com',
      'Library/CloudStorage/GoogleDrive-home@example.com',
    );
    const found = suggestedBackupLocations(h, 'darwin');
    expect(found).toHaveLength(2);
    // Sorted, so the order doesn't shuffle between runs on readdir order.
    expect(found[0].path).toContain('GoogleDrive-home@');
    expect(found[1].path).toContain('GoogleDrive-work@');
  });

  it('offers OneDrive first on Windows', () => {
    const h = home('OneDrive', 'Dropbox');
    const found = suggestedBackupLocations(h, 'win32');
    expect(found.map((l) => l.label)).toEqual(['OneDrive', 'Dropbox']);
  });

  it('offers the third-party clients on Linux', () => {
    const found = suggestedBackupLocations(home('Dropbox'), 'linux');
    expect(found.map((l) => l.label)).toEqual(['Dropbox']);
  });

  it('never offers the same folder twice', () => {
    // macOS lists Dropbox under both CloudStorage and the legacy home path, and
    // an install can genuinely have both names pointing at one place.
    const h = home('Library/CloudStorage/Dropbox', 'Dropbox');
    const found = suggestedBackupLocations(h, 'darwin');
    expect(new Set(found.map((l) => l.path)).size).toBe(found.length);
  });

  it('ignores a file sitting where a folder should be', () => {
    const h = tmpDataDir();
    fs.mkdirSync(path.join(h, 'Library/CloudStorage'), { recursive: true });
    fs.writeFileSync(path.join(h, 'Library/CloudStorage/GoogleDrive-x@y.com'), 'not a directory');
    fs.writeFileSync(path.join(h, 'Dropbox'), 'also not a directory');
    expect(suggestedBackupLocations(h, 'darwin')).toEqual([]);
  });
});
