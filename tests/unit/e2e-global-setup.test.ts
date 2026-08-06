import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { npmSpawn } from '../e2e/global-setup.js';

/**
 * The E2E harness spawns npm in a way Windows will actually run (NEWS-348, NEWS-354).
 *
 * `globalSetup` builds the client bundle once before any worker starts, by
 * spawning npm. On Windows that needs **two** things, and getting one of them
 * cost a failed release each:
 *
 * 1. `npm.cmd`, not `npm` — `execFile`/`spawn` resolve real executables only,
 *    never `PATHEXT` shims. A bare name throws `spawnSync npm ENOENT`.
 * 2. `shell: true` — since CVE-2024-27980 (Node 18.20.2+), Node refuses to spawn
 *    a `.cmd` at all without one, and throws `spawnSync npm.cmd EINVAL`.
 *
 * NEWS-348 fixed the first and asserted the second must *not* be there, on the
 * belief that a shell was avoidable. It isn't, and that assertion is inverted
 * below — deliberately kept rather than deleted, because the wrong version of
 * this test passed on every developer machine and shipped a broken beta.
 *
 * Which is the reason any of this is unit-tested: on macOS and Linux a plain
 * `npm` with no shell works, so the local suite, `ci.yml` and every developer
 * agree with each other and are all wrong about Windows. Windows E2E runs once
 * per release. So these assertions are about a platform this test is almost
 * certainly not running on.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'tests/e2e/global-setup.ts'), 'utf8');

/**
 * The file with its comments removed.
 *
 * The doc comment discusses both failure modes by name, and a source scan that
 * could not tell prose from code would read the explanation of a bug as evidence
 * of the bug. It did, on the first run.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * Just the `globalSetup` body — the call site, not the helper.
 *
 * `npmSpawn` legitimately contains `shell: false` in its POSIX return, so a
 * whole-file scan for that string cannot tell a correct answer from a hardcoded
 * one. The distinction the assertions below care about is where it appears.
 */
const callSite = code.slice(code.indexOf('export default function globalSetup'), code.indexOf('export function npmSpawn'));

describe('npmSpawn (NEWS-348, NEWS-354)', () => {
  it('uses npm.cmd AND a shell on Windows', () => {
    // Both halves, in one assertion, because either alone is a broken release:
    // the name alone gives EINVAL, the shell alone gives ENOENT.
    expect(npmSpawn('win32')).toEqual({ command: 'npm.cmd', shell: true });
  });

  it('uses a plain npm and no shell everywhere else', () => {
    for (const platform of ['darwin', 'linux', 'freebsd'] as const) {
      expect(npmSpawn(platform), platform).toEqual({ command: 'npm', shell: false });
    }
  });

  it('defaults to the running platform', () => {
    expect(npmSpawn().command).toBe(process.platform === 'win32' ? 'npm.cmd' : 'npm');
  });
});

describe('the global setup spawns npm through the helper (NEWS-354)', () => {
  it('never passes a bare npm literal to execFile', () => {
    // A test that only exercised `npmSpawn` would pass while the call site went
    // back to the literal. Verified by reverting it — this fails alone.
    expect(callSite).not.toMatch(/execFileSync\(\s*['"]npm/);
  });

  it('passes the shell flag through rather than hardcoding it', () => {
    // The half NEWS-348 missed. Hardcoding `shell: false` would reintroduce the
    // EINVAL on Windows while every other assertion here still passed.
    expect(callSite).toMatch(/shell:\s*npm\.shell/);
    expect(callSite).not.toMatch(/shell:\s*(true|false)/);
  });
});
