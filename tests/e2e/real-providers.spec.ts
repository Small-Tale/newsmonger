import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { CHECK_TIMEOUT_MS as CLAUDE_CEILING, hasSubscriptionCredentials } from '../../src/ai/providers/claude-cli.js';
import { CHECK_TIMEOUT_MS as CODEX_CEILING, hasChatGptCredentials } from '../../src/ai/providers/codex-cli.js';
import { E2E_REAL_SERVER, e2ePort } from '../helpers/e2e-port.js';

/**
 * The real subscriptions, not the mock (NEWS-276).
 *
 * **Why this file exists.** Two bugs reached the user in one day and neither was
 * findable from the rest of the suite:
 *
 * - `codex-cli` dropped `--search`, so every Codex check died on a usage dump
 *   (NEWS-272).
 * - The shared JSON schema omitted declared properties from `required`, which
 *   OpenAI's strict structured outputs reject — so with the argv fixed, every
 *   check then died on a 400.
 *
 * Both were found by hand against the real CLI and neither has any automated
 * guard, because the provider unit tests **inject a runner**: the argv and the
 * schema never meet a real binary. That is the class of bug a mock cannot see,
 * and it is the expensive class — the app's one job silently stops working.
 *
 * It also closes NEWS-227's gap. The mock hardcodes `effort: ''` (correctly: it
 * takes no level), and a run records `provider.effort`, so every `--ai-test` run
 * lands on one level while an effort comparison needs two.
 *
 * ### How it stays out of the way
 *
 * - **Its own server**, on its own port and temp data dir, with no `--ai-test`.
 *   The shared server the rest of the suite uses must stay mocked and hermetic.
 * - **Skips rather than fails** when the CLI holds no credentials, and always in
 *   CI. Deciding that reads the credential file rather than probing, so the
 *   decision itself costs no quota.
 * - **Deliberately small.** A real check takes 60–90 seconds and spends plan
 *   quota. This is not "the suite against a live provider"; it is the few
 *   assertions that need one.
 *
 * Run it with `npm run test:e2e:real`. It is **not** in `test:all`, on purpose —
 * see `docs/ai/code-summary.md`.
 */

// The second port in this checkout's window (NEWS-287). It was the constant
// 4191, which collided across checkouts exactly the way the shared server's 4189
// did — and this spec boots its own server, so it needs its own port, not the
// shared one.
const PORT = e2ePort(E2E_REAL_SERVER);

/**
 * How long to wait for one real check, derived rather than guessed.
 *
 * It must exceed the providers' own ceiling, or the test declares failure on a
 * check the app still considers healthy. The first version waited 4 minutes
 * against a 10-minute ceiling and duly failed a slow-but-fine Claude check —
 * while the effort test's own table was reporting medians of 61–76s with a long
 * tail, which is precisely the variance being tripped over.
 */
const CHECK_TIMEOUT = Math.max(CLAUDE_CEILING, CODEX_CEILING) + 60_000;

/** Nothing here can work in CI, and a red suite there would say nothing true. */
const inCI = process.env['CI'] !== undefined && process.env['CI'] !== '';

let server: ChildProcess | null = null;
let dataDir = '';
let base = '';

/** Boot a server with the real providers available, and return its URL. */
async function startRealServer(): Promise<string> {
  dataDir = mkdtempSync(resolve(tmpdir(), 'newsmonger-e2e-real-'));
  const proc = spawn(
    'npx',
    ['tsx', 'src/cli.ts', '--no-open', '--strict-port', '--port', String(PORT), '--data-dir', dataDir],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      // A fake keychain even here: these tests use subscription CLIs, which need
      // no key, and must never touch the developer's own keychain.
      env: { ...process.env, NEWSMONGER_FAKE_KEYCHAIN: '1', NEWSMONGER_SCHEDULER_TICK_MS: String(24 * 60 * 60 * 1000) },
    },
  );
  server = proc;
  return new Promise<string>((res, rej) => {
    const timer = setTimeout(() => {
      rej(new Error('the real-provider server never printed its readiness line'));
    }, 60_000);
    proc.stdout.on('data', (b: Buffer) => {
      const m = /running at (\S+)/.exec(String(b));
      if (m?.[1] !== undefined) {
        clearTimeout(timer);
        res(m[1]);
      }
    });
    proc.stderr.on('data', (b: Buffer) => {
      const s = String(b);
      if (/error/i.test(s)) process.stderr.write(`[real-server] ${s}`);
    });
  });
}

async function patchSettings(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.ok, 'settings PATCH').toBe(true);
}

interface RunRow {
  status: string;
  error: string | null;
  effort: string | null;
  provider: string | null;
}

/** Add a topic, wait for the check it triggers, and return the finished run. */
async function checkNewTopic(name: string): Promise<RunRow> {
  const res = await fetch(`${base}/api/topics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(res.ok, 'topic POST').toBe(true);

  const deadline = Date.now() + CHECK_TIMEOUT;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`the check for "${name}" never finished`);
    await new Promise((r) => setTimeout(r, 3000));
    const state = (await (await fetch(`${base}/api/state`)).json()) as { runs: RunRow[] };
    // `.at(0)` rather than `[0]`: without `noUncheckedIndexedAccess` the index is
    // typed as definitely present, so the guard reads as dead code.
    const run = state.runs.at(0);
    if (run !== undefined && run.status !== 'running') return run;
  }
}

/**
 * **No retries, and deliberately not serial** (NEWS-276).
 *
 * No retries because a real check costs minutes and plan quota to re-learn what
 * the first failure already said — the first run of this file took 17 minutes
 * mostly on a replay.
 *
 * Not serial because these tests are independent (each makes its own topic and
 * sets its own provider), and `mode: 'serial'` **skips the rest of the file after
 * a failure**. One slow Claude check therefore hid the Codex result entirely,
 * which is the opposite of what a provider smoke test is for: when one vendor
 * breaks, the other's verdict is the most useful thing on screen.
 */
test.describe.configure({ retries: 0 });

test.beforeAll(async () => {
  test.skip(inCI, 'real subscriptions are not available in CI, and the mock is the point there');
  base = await startRealServer();
  // The backup offer opens at the third topic (FR-27.4) and its backdrop swallows
  // every click. This file creates four, so the settings button became
  // unclickable and the test burned its whole timeout waiting on it.
  //
  // **The same trap as the demo capture in NEWS-263**, which I fixed there,
  // documented as FR-28.17, and then walked into again in a new file. Suppressed
  // the same way: through the real settings API, which is the state a user who
  // chose "don't ask again" is in.
  await patchSettings({ backupPromptNever: true });
});

test.afterAll(() => {
  server?.kill('SIGTERM');
  if (dataDir !== '') rmSync(dataDir, { recursive: true, force: true });
});

for (const [provider, label, credentials] of [
  ['claude-cli', 'Claude subscription', hasSubscriptionCredentials],
  ['codex-cli', 'ChatGPT subscription', () => Promise.resolve(hasChatGptCredentials())],
] as const) {
  test(`a real check on the ${label} succeeds and stores sourced stories (NEWS-276)`, async () => {
    test.skip(!(await credentials()), `${provider} is not signed in on this machine`);
    test.setTimeout(CHECK_TIMEOUT + 60_000);

    await patchSettings({ provider, effort: '' });
    const run = await checkNewTopic(`Real ${provider} probe`);

    // A dead flag and a rejected schema both surfaced as a *failed run* — so the
    // status plus the error text is precisely the assertion that would have
    // caught NEWS-272 twice over.
    expect(run.status, `the check failed: ${run.error ?? '(no error text)'}`).toBe('succeeded');
    expect(run.provider).toBe(provider);

    const items = (await (await fetch(`${base}/api/items?limit=5`)).json()) as {
      items: { title: string; sources: { url: string }[] }[];
    };
    expect(items.items.length, 'a real check should find something').toBeGreaterThan(0);
    // Sourced, because a provider that silently lost its web-search tool answers
    // from training data — plausible prose with no usable link, which is the
    // quiet failure FR-9.12b warns about and the one a status check misses.
    expect(items.items.some((i) => i.sources.some((s) => s.url.startsWith('http')))).toBe(true);
  });
}

test('a real run records the effort level it ran at (NEWS-226, NEWS-276)', async () => {
  test.skip(!(await hasSubscriptionCredentials()), 'claude-cli is not signed in on this machine');
  test.setTimeout(CHECK_TIMEOUT * 2 + 60_000);

  // Two levels, which is the point: the mock records one, so "the level is
  // stored, and stored *per run*" was only ever observable against a real
  // provider.
  //
  // This used to walk Settings → App → Diagnostics and read the effort
  // comparison table. That view was removed in NEWS-333; the **recording** it
  // read is FR-6.15 and unaffected, so the assertions moved down to the run
  // rows, which is where the property actually lives.
  await patchSettings({ provider: 'claude-cli', effort: 'low' });
  const low = await checkNewTopic('Effort probe low');
  expect(low.status, `low-effort check failed: ${low.error ?? ''}`).toBe('succeeded');
  expect(low.effort, 'the run must record the level it ran at').toBe('low');

  await patchSettings({ effort: 'high' });
  const high = await checkNewTopic('Effort probe high');
  expect(high.status, `high-effort check failed: ${high.error ?? ''}`).toBe('succeeded');
  expect(high.effort).toBe('high');

  // Two runs of the same provider at different levels are distinguishable, which
  // is the whole reason the column exists — and neither collapses to `null` (a
  // run from before the column) or `''` (ran at the model's default).
  expect(new Set([low.effort, high.effort]).size).toBe(2);

  // The old version also checked that a subscription run reports no token count,
  // by reading "tokens not reported" out of the comparison table. That is a
  // property of `usage`, not of the run row this helper returns, and is already
  // covered by the provider unit tests — not re-asserted here through a shape
  // this file does not fetch.
});
