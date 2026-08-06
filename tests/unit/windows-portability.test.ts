import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Conventions that only Windows disagrees with (NEWS-348, NEWS-354, NEWS-355).
 *
 * Three Windows-only breaks landed in a row, all in harness code, all invisible
 * on macOS and Linux, and each one was a different wall behind the last:
 *
 * - `spawn('npm')` → `ENOENT`, because `.cmd` shims are not executables.
 * - `spawn('npm.cmd')` → `EINVAL`, because Node refuses to spawn a `.cmd`
 *   without a shell (CVE-2024-27980).
 * - `cwd` from `new URL(import.meta.url).pathname` → `spawn …\node.exe ENOENT`,
 *   because that pathname is `/D:/a/repo/...` and resolves to nothing. Windows
 *   reports a missing *cwd* as ENOENT on the *executable*, so the error names
 *   the one thing that was fine.
 *
 * Fixing them one at a time cost two failed releases. These are scans over the
 * *class*, because the individual fix keeps turning out to be one step of
 * several, and because every one of these passes on a developer machine
 * regardless — Windows CI is path-filtered (NEWS-350) and cannot run on a change
 * it does not match.
 */

const SELF = fileURLToPath(import.meta.url);
const root = path.join(path.dirname(SELF), '../..');

/**
 * Every source file that could plausibly spawn a process or resolve a path.
 *
 * **This file is excluded**, and has to be: it carries both defects verbatim as
 * fixtures, so a scan that included itself would report itself forever. The
 * self-pinning assertions at the bottom are how those fixtures earn their keep.
 */
function sourceFiles(): string[] {
  const skip = new Set(['node_modules', '.git', 'dist', 'target', 'coverage', 'test-results', 'playwright-report']);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && p !== SELF) out.push(p);
    }
  };
  for (const sub of ['src', 'tests', 'scripts']) walk(path.join(root, sub));
  return out;
}

/** Source with comments stripped — prose about a bug is not the bug. */
function codeOf(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('Windows portability conventions', () => {
  it('never turns a file: URL into a path with .pathname (NEWS-355)', () => {
    // `new URL(import.meta.url).pathname` keeps the leading slash and the
    // percent-encoding, so on Windows it is not a path at all. `fileURLToPath`
    // is the conversion that knows about drive letters.
    const offenders = sourceFiles().filter((f) => /new URL\([^)]*\)\s*\.pathname/.test(codeOf(f)));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });

  it('never spawns a bare npm or npx from anything Windows CI runs (NEWS-348, NEWS-354)', () => {
    // Both need `.cmd` *and* a shell on Windows. `tests/e2e/global-setup.ts`
    // routes through `npmSpawn()`, which is checked in its own test.
    //
    // **Scoped to the E2E harness on purpose.** `npm-package.test.ts`,
    // `scripts/merge-coverage.mjs` and `scripts/e2e-scramble.mjs` still spawn a
    // bare tool; none of them runs in the Windows job (which runs `test:e2e`
    // only), so widening this today would assert something false about work
    // nobody has done. They are NEWS-357 — this stays narrow and true rather
    // than broad and skipped.
    const pattern = /(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*['"]np[mx]['"]/;
    const onWindowsCI = (f: string): boolean =>
      /tests[\\/](e2e|helpers)[\\/]/.test(f) || f.endsWith('playwright.config.ts');
    const offenders = sourceFiles().filter((f) => onWindowsCI(f) && pattern.test(codeOf(f)));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });

  it('scans a plausible number of files, so a broken walk cannot pass silently', () => {
    // The failure mode of a scan-based test: find nothing, assert nothing, stay
    // green forever.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(path.join('tests', 'e2e', 'server.ts')))).toBe(true);
  });

  it('catches the exact spawn NEWS-348 fixed', () => {
    const wasBroken = `execFileSync('npm', ['run', 'build:client:dev'], { cwd: root });`;
    expect(/(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*['"]np[mx]['"]/.test(wasBroken)).toBe(true);
  });

  it('catches the exact line NEWS-355 fixed', () => {
    // Pins the regex against the real defect, so a scan that quietly stopped
    // matching would fail here rather than everywhere.
    const wasBroken = "cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'),";
    expect(/new URL\([^)]*\)\s*\.pathname/.test(wasBroken)).toBe(true);
  });
});
