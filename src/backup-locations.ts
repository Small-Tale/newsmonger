import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Find the sync folders that actually exist on this machine (NEWS-230, FR-27.5).
 *
 * The backup prompt offers somewhere to put the snapshot, and the only useful
 * suggestion is one the user really has. **Every candidate is probed, never
 * assumed** — offering "iCloud Drive" to someone who has never turned it on is
 * worse than offering nothing, because the path looks authoritative and then
 * fails at the first write with an error about a directory that was never there.
 *
 * This is server-side by necessity: a browser cannot see the filesystem, and the
 * File System Access API hands back a sandboxed handle rather than a path the
 * Node server could open (see `docs/27-data-location.md`).
 */

/** A folder the user could keep backups in. */
export interface BackupLocation {
  /** What to call it in the UI — the product's name, not the path. */
  label: string;
  /** Absolute path, with the app's own subfolder already appended. */
  path: string;
}

/** The subfolder appended to every suggestion, so backups don't litter the root. */
export const BACKUP_SUBDIR = 'Newsmonger';

/**
 * Candidate roots per platform, most-likely first.
 *
 * A candidate is either a literal path or a **prefix match** within a parent
 * directory. macOS needs the latter: modern iCloud/Drive/OneDrive mounts live
 * under `~/Library/CloudStorage` with the account baked into the folder name
 * (`GoogleDrive-someone@gmail.com`, `OneDrive-Contoso`), so there is no fixed
 * path to test — only a parent to scan.
 */
interface Candidate {
  label: string;
  /** Path relative to home, tested as-is. */
  at?: string;
  /** Parent (relative to home) to scan, plus the prefix its entries start with. */
  scan?: { in: string; startsWith: string };
}

function candidates(platform: NodeJS.Platform): Candidate[] {
  if (platform === 'darwin') {
    return [
      { label: 'iCloud Drive', at: 'Library/Mobile Documents/com~apple~CloudDocs' },
      { label: 'Google Drive', scan: { in: 'Library/CloudStorage', startsWith: 'GoogleDrive-' } },
      { label: 'OneDrive', scan: { in: 'Library/CloudStorage', startsWith: 'OneDrive-' } },
      { label: 'Dropbox', scan: { in: 'Library/CloudStorage', startsWith: 'Dropbox' } },
      // The pre-CloudStorage locations, still present on older installs.
      { label: 'Google Drive', at: 'Google Drive' },
      { label: 'Dropbox', at: 'Dropbox' },
    ];
  }
  if (platform === 'win32') {
    return [
      { label: 'OneDrive', at: 'OneDrive' },
      { label: 'Google Drive', at: 'Google Drive' },
      { label: 'Dropbox', at: 'Dropbox' },
    ];
  }
  // Linux and anything else. No first-party iCloud or OneDrive client, but the
  // third-party sync clients use plain home directories.
  return [
    { label: 'Dropbox', at: 'Dropbox' },
    { label: 'OneDrive', at: 'OneDrive' },
    { label: 'Google Drive', at: 'GoogleDrive' },
  ];
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false; // missing, or a permission error — either way, not offerable
  }
}

/**
 * Probe for sync folders, most-likely first.
 *
 * `home` and `platform` are injectable so this is testable without a real
 * iCloud account — the alternative is a function that can only be exercised on
 * the developer's own machine, which is the same as untested.
 */
export function suggestedBackupLocations(
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): BackupLocation[] {
  const found: BackupLocation[] = [];
  const seen = new Set<string>();

  const add = (label: string, root: string): void => {
    const full = path.join(root, BACKUP_SUBDIR);
    // Two candidates can resolve to one folder (a Dropbox that is both under
    // CloudStorage and symlinked into home). Offering it twice looks broken.
    if (seen.has(full)) return;
    seen.add(full);
    found.push({ label, path: full });
  };

  for (const c of candidates(platform)) {
    if (c.at !== undefined) {
      const root = path.join(home, c.at);
      if (isDir(root)) add(c.label, root);
      continue;
    }
    if (c.scan === undefined) continue;
    const parent = path.join(home, c.scan.in);
    let entries: string[];
    try {
      entries = fs.readdirSync(parent);
    } catch {
      continue; // no CloudStorage directory at all
    }
    for (const entry of entries.sort()) {
      if (!entry.startsWith(c.scan.startsWith)) continue;
      const root = path.join(parent, entry);
      if (isDir(root)) add(c.label, root);
    }
  }
  return found;
}
