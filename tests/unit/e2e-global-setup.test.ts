import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { npmCommand } from '../e2e/global-setup.js';

/**
 * The E2E harness spawns npm by a name Windows can resolve (NEWS-348).
 *
 * `globalSetup` builds the client bundle once before any worker starts, by
 * spawning npm. On Windows npm is `npm.cmd` — a shell shim, not an executable —
 * and `execFile`/`spawn` without `shell: true` resolve only real executables. A
 * bare `'npm'` throws `spawnSync npm ENOENT` before a single test runs.
 *
 * This is the `sandboxable.test.ts` shape, and the reason it deserves a test at
 * all: **on every machine anyone develops on, both spellings work.** macOS and
 * Linux have a real `npm` executable, so the local suite passes, `ci.yml` (Ubuntu)
 * passes, and the only thing that disagrees is the Windows E2E job — which runs
 * once per release. It cost a failed `v0.2.0-beta.16` to find, three days after
 * the code landed.
 *
 * So the assertion is about a platform this test is almost certainly not running
 * on. That is deliberate.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'tests/e2e/global-setup.ts'), 'utf8');

/**
 * The file with its comments removed.
 *
 * The doc comment on `npmCommand` discusses `shell: true` at length, and a
 * source scan that could not tell prose from code would read the explanation of
 * why we don't do a thing as evidence that we do.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('npmCommand (NEWS-348)', () => {
  it('is npm.cmd on Windows', () => {
    expect(npmCommand('win32')).toBe('npm.cmd');
  });

  it('is plain npm everywhere else', () => {
    for (const platform of ['darwin', 'linux', 'freebsd'] as const) {
      expect(npmCommand(platform), platform).toBe('npm');
    }
  });

  it('defaults to the running platform', () => {
    expect(npmCommand()).toBe(process.platform === 'win32' ? 'npm.cmd' : 'npm');
  });
});

describe('the global setup spawns nothing Windows cannot resolve (NEWS-348)', () => {
  it('never passes a bare npm to execFile', () => {
    // The regression, spelled as the source line that caused it. A test that
    // only exercised `npmCommand` would pass while the call site went back to
    // the literal.
    expect(code).not.toMatch(/execFileSync\(\s*['"]npm['"]/);
    expect(code).toMatch(/execFileSync\(\s*npmCommand\(\)/);
  });

  it('does not reach for a shell instead', () => {
    // `shell: true` also fixes the ENOENT, and brings cmd.exe's quoting rules
    // into a path that has no need of them.
    expect(code).not.toMatch(/shell:\s*true/);
  });
});
