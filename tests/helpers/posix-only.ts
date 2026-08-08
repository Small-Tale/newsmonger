import { describe } from 'vitest';

/**
 * A suite that cannot mean anything on Windows, and says why (NEWS-430).
 *
 * NEWS-419 put the unit suite on the Windows runner so that guards asserting
 * *about* Windows would finally be executed there. That was right, and it
 * immediately found real defects. It also swept in a handful of suites whose
 * subject is **POSIX itself** — an execute bit, a `#!` line, a `:`-separated
 * `PATH`, a bash stub on `PATH`. Those are not testable on Windows because the
 * thing they test does not exist there.
 *
 * Skipping is the honest answer for those, and it is a narrow one: it applies to
 * the suite's *subject*, never to a test that merely happens to fail. The
 * distinction matters, because "skip it on Windows" is exactly how a real
 * portability defect would get hidden — the `\` -vs- `/` bug NEWS-419 fixed
 * would have been silenced by a careless skip here.
 *
 * So each caller states what POSIX thing it needs. If the reason is not a
 * property of the platform, the test is wrong and the skip is a bug.
 *
 * @param reason - The POSIX-only thing this suite depends on.
 */
export function describePosixOnly(name: string, reason: string, fn: () => void): void {
  const skip = process.platform === 'win32';
  describe(skip ? `${name} [skipped on Windows: ${reason}]` : name, () => {
    if (skip) return;
    fn();
  });
}
