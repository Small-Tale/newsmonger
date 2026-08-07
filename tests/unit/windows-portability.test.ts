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
 *
 * ## The fourth break, and why it is pinned rather than scanned (NEWS-419)
 *
 * `tests/helpers/source-tree.ts` held its "must be scanned" list as `/`-separated
 * strings and compared them against raw `path.relative` output, which is
 * `\`-separated on Windows. Every "is scanned" assertion in all three text-hygiene
 * guards would have failed there — the assertions whose entire job is to stop a
 * broken walk passing silently.
 *
 * **A scan for it was attempted and rejected.** The obvious rule is "a path built
 * with `path.*` must not be compared against a `/`-separated literal", and it cannot
 * be written cleanly, for a reason specific to how this bug is shaped: the literal
 * is in a *different module* from the comparison. `MUST_BE_SCANNED` lives in
 * `tests/helpers/`, the `toContain(required)` in `tests/unit/`, and the file holding
 * the defect contains no `/` literal at the comparison at all. A text scan cannot
 * see the pair, and neither can an AST pattern — it needs dataflow. Every
 * approximation tried was worse than nothing: keying on `path.relative(` plus a
 * comparison verb flags this file's own correct `toEqual([])` and still misses
 * `sandboxable.test.ts`, where the walk and the assertion are thirty lines apart;
 * keying on a `/`-bearing literal anywhere in the file flags the right files for
 * entirely unrelated reasons — a doc-comment path, an expected error message — which
 * is how a rule decays into noise and then into being switched off.
 *
 * **What was fixable is the reason nobody noticed.** `npm test` ran on
 * `ubuntu-latest` and nowhere else, so every guard in this repo that asserts *about*
 * Windows was only ever executed on Linux and macOS — including this file. The
 * defect was one red test away from being obvious and no machine was ever going to
 * run it. So the Windows CI jobs now run the unit suite, and the test below pins
 * that: it is the one thing here that, if it regresses, takes the rest of the file's
 * value with it silently.
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

/**
 * The `runs-on: windows-latest` jobs of a workflow, as `{ id, body }`.
 *
 * A deliberately small parser rather than a YAML dependency: it needs to answer one
 * question about two files, and the shape it relies on — jobs at two-space indent
 * under `jobs:` — is the one GitHub Actions mandates.
 */
function windowsJobs(workflow: string): { id: string; body: string }[] {
  const text = fs.readFileSync(path.join(root, '.github/workflows', workflow), 'utf8');
  const starts = [...text.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)];
  return starts
    .map(({ 0: header, index, 1: id }) => ({
      id,
      body: text.slice(index + header.length, starts.find((s) => s.index > index)?.index ?? text.length),
    }))
    .filter(({ body }) => /runs-on:\s*windows-latest/.test(body));
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

  it('never spawns a bare npm or npx, anywhere (NEWS-348, NEWS-354, NEWS-356)', () => {
    // Both need the `.cmd` name *and* a shell on Windows. Every caller now goes
    // through `scripts/npm-command.mjs`, so this is the whole tree rather than
    // just what the Windows CI job happens to run — the scoped version was a
    // placeholder for exactly this, kept narrow while three call sites were
    // still unfixed.
    const pattern = /(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*['"]np[mx]['"]/;
    const offenders = sourceFiles().filter((f) => pattern.test(codeOf(f)));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });

  it('scans a plausible number of files, so a broken walk cannot pass silently', () => {
    // The failure mode of a scan-based test: find nothing, assert nothing, stay
    // green forever.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(path.join('tests', 'e2e', 'server.ts')))).toBe(true);
  });

  it('actually runs the unit suite on Windows, or none of the above is ever executed there (NEWS-419)', () => {
    // The assertions in this file describe Windows and run on Linux and macOS. That
    // is the point of them — but it only pays off if *something* eventually runs
    // them on the platform they are about, and until NEWS-419 nothing did: both
    // Windows jobs ran `npm run test:e2e` and `npm test` was ubuntu-only. A guard
    // whose failure mode is "the machine that would notice never runs it" is the
    // exact shape of defect this whole family exists for, so it gets pinned rather
    // than trusted.
    const jobs = [
      ...windowsJobs('ci.yml').map((j) => ({ ...j, workflow: 'ci.yml' })),
      ...windowsJobs('release-candidate.yml').map((j) => ({ ...j, workflow: 'release-candidate.yml' })),
    ];
    // The failure mode of a parse-based test: find no jobs and assert nothing.
    expect(jobs.map((j) => `${j.workflow}:${j.id}`)).toEqual([
      'ci.yml:test-e2e-windows',
      'release-candidate.yml:test-e2e-windows',
    ]);
    for (const job of jobs) {
      expect(job.body, `${job.workflow}:${job.id} runs the unit suite`).toMatch(/run:\s*npm test$/m);
      // `dist/client` first, or several suites 404 on `/static/...` (NEWS-191).
      expect(job.body, `${job.workflow}:${job.id} builds the client first`).toMatch(/npm run build:client/);
    }
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
