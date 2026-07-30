import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * The desktop bundle actually declares its icons (NEWS-182).
 *
 * `bundle.icon` in `tauri.conf.json` **defaults to an empty array** — confirmed
 * in the CLI's own `config.schema.json`. So omitting the field is not "use the
 * conventional icons", it is "ship no icons at all": Tauri writes no
 * `CFBundleIconFile`/`CFBundleIconName` into `Info.plist`, copies no `.icns`
 * into `Contents/Resources`, and macOS falls back to a generic icon in the
 * Dock, in Finder, and in the About panel.
 *
 * That is exactly what happened. `npx tauri icon` had been run and every icon
 * sat on disk unreferenced, which is the worst version of this bug — nothing
 * looks missing.
 *
 * Nothing structurally connects a config array to files on disk, and a full
 * `tauri build` needs a Rust toolchain and minutes, so it cannot be a unit
 * test. This is the cheap part that would have caught it: the declaration
 * exists, and every path in it resolves.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tauriDir = path.join(root, 'src-tauri');

/**
 * Validated rather than cast: this is a config file read off disk, and an
 * unparseable or reshaped `bundle` should fail loudly here rather than surface
 * as a confusing assertion error three lines down.
 */
const ConfSchema = z.object({
  bundle: z.object({
    icon: z.array(z.string()),
  }),
});

function bundleIcons(): string[] {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(tauriDir, 'tauri.conf.json'), 'utf8'));
  return ConfSchema.parse(raw).bundle.icon;
}

describe('the Tauri bundle declares its icons (NEWS-182)', () => {
  it('declares at least one icon', () => {
    // The whole bug in one assertion: the schema default is `[]`, so an absent
    // or empty `icon` array silently ships an iconless app.
    expect(bundleIcons().length).toBeGreaterThan(0);
  });

  it('every declared icon exists on disk', () => {
    // Paths are relative to `src-tauri/`. A typo or a renamed asset would make
    // the bundle fall back to the generic icon with nothing obviously wrong.
    const missing = bundleIcons().filter((rel) => !fs.existsSync(path.join(tauriDir, rel)));
    expect(missing, 'declared but absent').toEqual([]);
  });

  it('includes an .icns, which is the file macOS actually reads', () => {
    // The PNGs are what other platforms and the installers use; macOS wants the
    // .icns, and it is the one whose absence produced the reported symptom.
    expect(bundleIcons().some((rel) => rel.endsWith('.icns'))).toBe(true);
  });

  it('includes an .ico for Windows', () => {
    // Windows has never been bundle-verified (NEWS-20), so this is the one thing
    // about it we can hold true cheaply rather than discovering later.
    expect(bundleIcons().some((rel) => rel.endsWith('.ico'))).toBe(true);
  });

  it('declares no icon that is empty or unreadably small', () => {
    // A zero-byte or truncated icon is accepted by the bundler and then renders
    // as nothing — the same visible outcome as declaring none.
    for (const rel of bundleIcons()) {
      const full = path.join(tauriDir, rel);
      if (!fs.existsSync(full)) continue; // covered by the existence test above
      expect(fs.statSync(full).size, `${rel} is suspiciously small`).toBeGreaterThan(256);
    }
  });

  it('the .icns is a real Mac icon file, not a renamed PNG', () => {
    // `tauri icon` also writes icon.png next to icon.icns, and copying the
    // wrong one over would pass every check above while shipping a file macOS
    // cannot read. ICNS begins with the magic `icns`.
    const icns = bundleIcons().find((rel) => rel.endsWith('.icns'));
    if (icns === undefined) throw new Error('no .icns declared');
    const magic = fs.readFileSync(path.join(tauriDir, icns)).subarray(0, 4).toString('ascii');
    expect(magic).toBe('icns');
  });
});
