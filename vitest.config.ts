import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    /**
     * Five seconds everywhere except Windows, where it is thirty (NEWS-430).
     *
     * The Windows runner is slow enough that this suite sits near the default,
     * and **the tests that cross it change every run** — one CI round reported
     * `checks` / `discovery` / `retention` / `retry`, the next `keep-alive` and
     * `off-topic-prompt`. A moving set is the signature of a machine that is
     * uniformly slow, not of a few slow tests, and giving each of them its own
     * timeout as it surfaces is a game with no end.
     *
     * Platform-scoped rather than raised for everyone, because the timeout is a
     * proxy for "something is stuck" and what counts as stuck depends on the
     * machine. A developer and the Linux CI keep the short feedback loop; only
     * the runner that needs headroom gets it.
     */
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
    hookTimeout: process.platform === 'win32' ? 30_000 : 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage/unit',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/client/styles/**'],
    },
  },
});
