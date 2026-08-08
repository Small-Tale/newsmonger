import fs from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { cliSearchPath, resolveCliBinary } from '../../src/ai/providers/cli-path.js';
import { describePosixOnly } from '../helpers/posix-only.js';
import { tmpDataDir } from '../helpers/tmp.js';

/**
 * The bug these guard (NEWS-240): a macOS app launched from Finder does not
 * inherit the shell's `PATH`. It gets launchd's — `/usr/bin:/bin:/usr/sbin:/sbin`
 * — while `claude` and `codex` install to `~/.local/bin`. So `spawn('claude')`
 * works in a terminal and in `npm run dev`, and fails with `ENOENT` in the
 * packaged app, which is what shipped in v0.2.0-beta.8.
 *
 * Every test here passes an explicit `home`, `platform` and `PATH` so it
 * exercises the resolution rather than this machine's actual environment — the
 * developer's `PATH` is exactly the thing that hides this bug.
 */

/** A fake home with `dir/name` present and executable. */
function homeWith(dir: string, name: string): { home: string; full: string } {
  const home = tmpDataDir();
  const full = path.join(home, dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '#!/bin/sh\n');
  fs.chmodSync(full, 0o755);
  return { home, full };
}

describePosixOnly(
  'resolveCliBinary (NEWS-240)',
  'these cases simulate a POSIX platform against a real filesystem — `chmod 0o644` does not ' +
    'remove executability on NTFS, and a `C:\\…` PATH splits at the drive colon under a `:` separator',
  () => {
  it('finds a binary in ~/.local/bin when PATH is the launchd minimum', () => {
    // The exact failing case: the real install location, and the PATH a
    // Finder-launched app actually gets.
    const { home, full } = homeWith('.local/bin', 'claude');
    expect(resolveCliBinary('claude', home, 'darwin', '/usr/bin:/bin:/usr/sbin:/sbin')).toBe(full);
  });

  it('finds it with an empty PATH', () => {
    const { home, full } = homeWith('.local/bin', 'codex');
    // `''` is how "no PATH" is expressed, not `undefined` — passing `undefined`
    // triggers the default parameter, which reads the *real* `process.env.PATH`.
    // That distinction matters here more than usual: the developer's own PATH is
    // precisely what hides this bug, so a test that accidentally fell back to it
    // would pass while proving nothing. (This test caught exactly that.)
    expect(resolveCliBinary('codex', home, 'darwin', '')).toBe(full);
  });

  it('prefers PATH over the fallbacks', () => {
    // In a terminal or CI, PATH is already right, and whatever it names is what
    // the user would get by typing the command. The fallback must not override
    // an explicit choice — someone with two installs means the one on PATH.
    const { home } = homeWith('.local/bin', 'claude');
    const other = tmpDataDir();
    const onPath = path.join(other, 'claude');
    fs.writeFileSync(onPath, '#!/bin/sh\n');
    fs.chmodSync(onPath, 0o755);
    expect(resolveCliBinary('claude', home, 'darwin', other)).toBe(onPath);
  });

  it('searches Homebrew on both architectures', () => {
    const dirs = cliSearchPath('/Users/x', 'darwin');
    expect(dirs).toContain('/opt/homebrew/bin'); // Apple Silicon
    expect(dirs).toContain('/usr/local/bin'); // Intel, and manual installs
  });

  it('returns the bare name when nothing is found', () => {
    // Deliberate: `spawn` then produces its usual ENOENT and the caller's
    // existing "is it installed?" error is still right. This function removes a
    // *false* negative; it must not invent a new failure mode.
    expect(resolveCliBinary('claude', tmpDataDir(), 'darwin', '')).toBe('claude');
  });

  it('ignores a directory or a non-executable file with the right name', () => {
    const home = tmpDataDir();
    // A directory called `claude` must not be mistaken for the binary.
    fs.mkdirSync(path.join(home, '.local/bin/claude'), { recursive: true });
    expect(resolveCliBinary('claude', home, 'darwin', '')).toBe('claude');

    const home2 = tmpDataDir();
    const notExec = path.join(home2, '.local/bin/codex');
    fs.mkdirSync(path.dirname(notExec), { recursive: true });
    fs.writeFileSync(notExec, 'text');
    fs.chmodSync(notExec, 0o644);
    expect(resolveCliBinary('codex', home2, 'darwin', '')).toBe('codex');
  });

  it('prefers the .cmd shim on Windows', () => {
    // npm installs an extensionless script plus a `.cmd`; only the latter is
    // something `spawn` can launch on Windows.
    const home = tmpDataDir();
    const dir = path.join(home, 'AppData/Roaming/npm');
    fs.mkdirSync(dir, { recursive: true });
    for (const n of ['claude', 'claude.cmd']) {
      fs.writeFileSync(path.join(dir, n), 'x');
      fs.chmodSync(path.join(dir, n), 0o755);
    }
    expect(resolveCliBinary('claude', home, 'win32', '')).toBe(path.join(dir, 'claude.cmd'));
  });

  it('splits PATH with the platform separator', () => {
    // `;` on Windows, `:` elsewhere. Getting this wrong makes the whole PATH
    // read as one nonexistent directory, and the fallbacks would quietly hide it.
    const home = tmpDataDir();
    const dir = tmpDataDir();
    const exe = path.join(dir, 'claude.cmd');
    fs.writeFileSync(exe, 'x');
    fs.chmodSync(exe, 0o755);
    expect(resolveCliBinary('claude', home, 'win32', `C:\\nope;${dir}`)).toBe(exe);
  });
  },
);
