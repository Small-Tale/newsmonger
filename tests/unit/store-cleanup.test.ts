import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRelative, sourceFiles } from '../helpers/source-tree.js';

/**
 * Every unit test opens its `Store` through `tmpStore()` (NEWS-431).
 *
 * A scan rather than a convention, for the reason this family always gives: the
 * failure is invisible on the machine that introduces it. `new Store(tmpDataDir())`
 * leaves a SQLite handle open, POSIX lets the directory be removed anyway, and
 * **only Windows notices** — where it took out 46 of 126 test files on a release
 * tag, every one of them having passed its assertions.
 *
 * So the rule cannot be "remember to close it". It has to be enforceable here,
 * on any platform, before a release finds out.
 *
 * `tmpStore()` closes the store after the test, which is what lets
 * `tests/helpers/tmp.ts` remove the directory strictly rather than tolerating
 * `EBUSY`. This scan is what keeps that true.
 */
describe('unit tests open their Store through the helper (NEWS-431)', () => {
  // **This file excludes itself, and has to** — the same necessity
  // `windows-portability.test.ts` records: it quotes the banned pattern in its
  // own prose to explain the rule, so a scan that included itself would report
  // itself forever. The assertions below are what earn that exemption.
  const SELF = 'tests/unit/store-cleanup.test.ts';
  const unitTests = sourceFiles()
    .filter((f) => /tests[/\\]unit[/\\].*\.test\.ts$/.test(repoRelative(f)))
    .filter((f) => repoRelative(f) !== SELF);

  it('finds the unit suite, so a broken filter cannot pass vacuously', () => {
    // The failure mode of every scan in this repo: match nothing, assert
    // nothing, stay green forever.
    expect(unitTests.length).toBeGreaterThan(100);
    expect(unitTests.map((f) => repoRelative(f))).toContain('tests/unit/store.test.ts');
  });

  it('never constructs a Store directly', () => {
    // The helper takes an optional directory, so both shapes this suite had are
    // expressible: `tmpStore()` for a fresh one and `tmpStore(dir)` for
    // reopening the same directory, which is how the persistence tests check
    // that what was written comes back.
    const offenders = unitTests
      .filter((f) => /\bnew Store\s*\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => repoRelative(f));
    expect(offenders, 'use `tmpStore()` from tests/helpers/tmp.ts instead').toEqual([]);
  });

  it('leaves the E2E spec alone, which has no vitest hook to clean up after it', () => {
    // Scoped to the unit suite on purpose. `tests/e2e/recover.spec.ts` also
    // constructs a `Store`, under Playwright, where this `afterEach` does not
    // exist — so the rule cannot apply and pretending otherwise would mean
    // either a false failure or a special case nobody could explain.
    const e2e = path.join(path.dirname(unitTests[0] ?? ''), '../e2e/recover.spec.ts');
    expect(fs.existsSync(e2e), 'the exempt spec should still exist').toBe(true);
    expect(unitTests.map((f) => repoRelative(f))).not.toContain('tests/e2e/recover.spec.ts');
  });
});
