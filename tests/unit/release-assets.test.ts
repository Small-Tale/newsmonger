import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// A dynamic `import()` of a URL rather than a static specifier: the module is
// plain `.mjs` with no declaration file, and a static import makes tsc demand
// one (TS7016). Same approach glassbox's equivalent test uses.
//
// `fileURLToPath` is not needed here because the URL is passed straight to
// `import()`, which wants a URL rather than a path.
const modUrl = new URL('../../scripts/release/release-assets.mjs', import.meta.url).href;
const { downloadEntries, downloadSection, friendlyName, shippedAssetNames } = (await import(modUrl)) as {
  downloadEntries: (v: string) => Record<string, { file: string; label: string; note: string }[]>;
  downloadSection: (v: string, repo: string, tag: string) => string;
  friendlyName: (name: string) => string;
  shippedAssetNames: (v: string) => string[];
};

/**
 * The release notes' download links match the assets actually published (NEWS-201).
 *
 * `release-desktop.yml` uses this module twice: once to write the "## Download"
 * block into the release body, and once to rename the uploaded `.dmg` files. The
 * two halves live in one module so they cannot drift — and this is the test that
 * makes "cannot" true rather than aspirational.
 *
 * The bug being guarded against is a download link that 404s because it names a
 * file the build never produced. It is invisible until a real person clicks it,
 * by which point the release is public.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODULE = path.join(root, 'scripts/release/release-assets.mjs');

describe('release-assets: links and shipped names agree (NEWS-201)', () => {
  it('every download link points at a name that will actually be published', () => {
    // The whole point of the module. If a rename rule changes but the link
    // generator does not, this fails.
    const shipped = new Set(shippedAssetNames('0.1.0'));
    const linked = Object.values(downloadEntries('0.1.0'))
      .flat()
      .map((e) => e.file);
    expect(linked.length).toBeGreaterThan(0);
    for (const file of linked) {
      expect(shipped.has(file), `${file} is linked but never shipped`).toBe(true);
    }
  });

  it('renames only the .dmg files', () => {
    // Deliberate: the updater's latest.json references the .exe/.msi/.deb/
    // .AppImage/.rpm assets by their original filenames, so renaming one would
    // break auto-update. macOS updates use the .app.tar.gz, which is why the dmg
    // is free to be renamed.
    expect(friendlyName('Newsmonger_0.1.0_aarch64.dmg')).toBe('Newsmonger-0.1.0-macOS-Apple-Silicon.dmg');
    expect(friendlyName('Newsmonger_0.1.0_x64.dmg')).toBe('Newsmonger-0.1.0-macOS-Intel.dmg');
    for (const untouched of [
      'Newsmonger_0.1.0_amd64.deb',
      'Newsmonger_0.1.0_amd64.AppImage',
      'Newsmonger-0.1.0-1.x86_64.rpm',
      'Newsmonger_0.1.0_x64-setup.exe',
      'Newsmonger_0.1.0_x64_en-US.msi',
      'latest.json',
      'Newsmonger.app.tar.gz',
      'Newsmonger.app.tar.gz.sig',
    ]) {
      expect(friendlyName(untouched), `${untouched} must not be renamed`).toBe(untouched);
    }
  });

  it('is idempotent — renaming an already-renamed asset is a no-op', () => {
    // The rename step runs over every asset on the release, and a re-run (or a
    // retried job) would otherwise mangle names it had already fixed.
    const once = friendlyName('Newsmonger_0.1.0_aarch64.dmg');
    expect(friendlyName(once)).toBe(once);
  });

  it('covers all four built targets', () => {
    // The workflow's matrix builds macOS arm64 + x64, Linux x64 and Windows x64.
    // A link section missing a platform means a silent "no download for you".
    expect(Object.keys(downloadEntries('0.1.0'))).toEqual(['macOS', 'Linux', 'Windows']);
    expect(shippedAssetNames('0.1.0')).toHaveLength(7);
  });

  it('builds a download section with resolvable absolute URLs', () => {
    const md = downloadSection('0.1.0', 'Small-Tale/newsmonger', 'v0.1.0');
    expect(md).toMatch(/^## Download/);
    for (const platform of ['### macOS', '### Linux', '### Windows']) {
      expect(md).toContain(platform);
    }
    // Every link must be an absolute release-download URL for this exact tag —
    // a relative or wrong-tag link renders fine and 404s.
    const urls = [...md.matchAll(/\]\((.*?)\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(
        /^https:\/\/github\.com\/Small-Tale\/newsmonger\/releases\/download\/v0\.1\.0\//,
      );
    }
  });

  it('interpolates the version everywhere rather than hardcoding one', () => {
    const md = downloadSection('9.9.9', 'Small-Tale/newsmonger', 'v9.9.9');
    expect(md).not.toContain('0.1.0');
    expect(md).toContain('9.9.9');
  });

  it('runs as a CLI, which is how the workflow invokes it', () => {
    // The create-release job calls this with the runner's bare `node` — no npm
    // install, no tsx. A syntax or import error would surface only there.
    const out = execFileSync('node', [MODULE, 'download-section', '0.1.0', 'Small-Tale/newsmonger', 'v0.1.0'], {
      encoding: 'utf8',
    });
    expect(out).toMatch(/^## Download/);
    // No trailing newline — the workflow appends one before its heredoc
    // delimiter precisely because of this, so pin it.
    expect(out.endsWith('\n')).toBe(false);
  });

  it('exits non-zero on a bad CLI invocation', () => {
    for (const args of [[], ['download-section'], ['nonsense']]) {
      expect(() => execFileSync('node', [MODULE, ...args], { stdio: 'pipe' })).toThrow();
    }
  });
});
