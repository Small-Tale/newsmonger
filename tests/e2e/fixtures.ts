import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrowserContext, Locator, Page } from '@playwright/test';
import { expect, request as playwrightRequest, test as base } from '@playwright/test';

import { serverAlive } from '../helpers/server-alive.js';

export { expect } from '@playwright/test';

/**
 * Put the shared server back to the state a spec file expects to find it in
 * (NEWS-101, widened in NEWS-313).
 *
 * The whole suite runs against **one** server and **one** data dir, and every
 * spec file is `mode: 'serial'` — so when a test fails, Playwright replays the
 * *entire group from the top* without resetting anything. A test that failed
 * before reaching its own cleanup leaves its state behind, and the replayed
 * early tests then fail on state they never created. The run blames an innocent
 * test and hides the one that actually broke, which is far more expensive than
 * the flake itself.
 *
 * Calling this from `beforeAll` gives every attempt — first run or retry — the
 * same precondition the first attempt had.
 *
 * **Named for the state, not for topics** (NEWS-313). This was `resetTopics`,
 * and that name was already a half-truth — it has silenced the backup offer
 * since NEWS-230 — but the widening is what made it misleading. A helper called
 * `resetTopics` that also deletes API keys is its own trap.
 *
 * Uses its own request context rather than the `request` fixture: `beforeAll`
 * only sees worker-scoped fixtures. No `Origin` header is sent, which the
 * cross-origin guard allows by design (FR-4.5a) — a non-browser caller.
 */
export async function resetSharedState(baseURL: string): Promise<void> {
  const ctx = await playwrightRequest.newContext({ baseURL });
  try {
    const state = (await (await ctx.get('/api/state')).json()) as { topics: { id: string }[] };
    for (const topic of state.topics) {
      await ctx.delete(`/api/topics/${encodeURIComponent(topic.id)}`);
    }
    // Assert rather than assume: a silent failure here would put the pollution
    // back, and it would look exactly like the bug this exists to prevent.
    const after = (await (await ctx.get('/api/state')).json()) as { topics: unknown[] };
    expect(after.topics, 'server should start each attempt with no topics').toHaveLength(0);

    // Silence the backup offer (NEWS-230). It fires on the third topic, and
    // most specs here create three or more — so without this a modal appears
    // partway through an unrelated test and swallows the next click, failing
    // something that has nothing to do with backups.
    //
    // Suppressed in the *harness*, not in the product: the app has no test-only
    // branch for this. `backup-prompt.spec.ts` clears the flag and tests the
    // offer for real.
    //
    // The provider config goes back to its defaults in the same breath
    // (NEWS-313). NEWS-101 said "nothing else is reset (settings, runs), because
    // nothing else has caused this" — and then something else did. Fourteen
    // places across six spec files end with a hand-written "leave the app as the
    // rest of the suite expects it", and **every one of them is skipped when its
    // test fails early**. `discover.spec.ts` removing a stored Anthropic key in
    // its last four lines is what made `keys.spec.ts` — a different file,
    // minutes later — fail on "lists both keyed providers as unconfigured".
    // `mode: 'serial'` stops the rest of a *file*; it has no reach into the next
    // one.
    await ctx.patch('/api/settings', {
      data: { backupPromptNever: true, provider: 'auto', model: '', endpoint: '', effort: '' },
    });
    for (const provider of ['anthropic', 'openai']) {
      await ctx.delete(`/api/keys/${provider}`);
    }

    // Named here rather than left to whichever assertion trips on it later. A
    // reset that silently failed would reproduce the exact bug this widening is
    // for, and the point of NEWS-298's work is that a misattributed failure
    // costs an investigation while a named one costs a sentence.
    const keys = (await (await ctx.get('/api/keys')).json()) as {
      keys: { provider: string; configured: boolean; source: string | null }[];
    };
    // `env` is not ours to clear — a developer with ANTHROPIC_API_KEY exported
    // is a legitimate way to run this, and `keys.spec.ts` asserts that state
    // reads as "from the environment" rather than as unconfigured.
    const stored = keys.keys.filter((k) => k.configured && k.source !== 'env').map((k) => k.provider);
    expect(stored, 'a stored API key survived the reset — a later spec will fail on it').toEqual([]);
  } finally {
    await ctx.dispose();
  }
}

/**
 * Accept the in-app confirmation dialog (NEWS-39).
 *
 * The app no longer uses `window.confirm`, which is a silent no-op in the Tauri
 * WKWebView — and which Playwright would auto-accept in headless, hiding that
 * very bug. Driving the real in-DOM dialog makes the test take the same path a
 * user does.
 */
export async function acceptConfirm(page: Page): Promise<void> {
  await expect(page.locator('.dialog.confirm')).toBeVisible();
  await page.locator('[data-action=confirm-ok]').click();
  await expect(page.locator('.dialog.confirm')).toHaveCount(0);
}

export async function cancelConfirm(page: Page): Promise<void> {
  await expect(page.locator('.dialog.confirm')).toBeVisible();
  await page.locator('[data-action=confirm-cancel]').click();
  await expect(page.locator('.dialog.confirm')).toHaveCount(0);
}

/**
 * Run a topic action through the right-click menu.
 *
 * Topic actions moved out of always-visible row buttons and into a context
 * menu (NEWS-29), so specs drive them the way a user does. Lives here rather
 * than in a spec because Playwright forbids one test file importing another.
 */
export async function topicAction(
  page: Page,
  row: Locator,
  action: 'check' | 'pause' | 'priority' | 'solo' | 'guidance' | 'rename' | 'delete',
): Promise<void> {
  await row.click({ button: 'right' });
  await expect(page.locator('.menu')).toBeVisible();
  await page.locator(`[data-menu-action=${action}]`).click();
  await expect(page.locator('.menu')).toHaveCount(0);
  // Delete now raises an in-app confirmation; accept it so the action completes.
  if (action === 'delete') await acceptConfirm(page);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const browserCovDir = path.join(projectRoot, '.coverage-tmp/browser');
const appBundle = path.join(projectRoot, 'dist/client/app.global.js');
let covFileCounter = 0;

/**
 * Write a failure diagnostic into the test's own output directory (NEWS-238).
 *
 * **Not `testInfo.attach()`, which silently does nothing here.** Attaching from
 * a fixture teardown reports success — the promise resolves, no error — and the
 * attachment never reaches the report or `test-results/`. That is why the last
 * round's console capture "came back empty": it was never written, and I read
 * an absent file as an absent problem, which cost a whole CI cycle.
 *
 * A plain file in `outputPath()` has no such timing: `test-results/` is what CI
 * uploads, so whatever lands here is in the artifact. Failures to write are
 * swallowed for the same reason the `evaluate` above is — a diagnostic must
 * never replace the failure it exists to explain.
 */
function writeDiagnostic(name: string, body: string): void {
  try {
    fs.writeFileSync(test.info().outputPath(name), body);
  } catch {
    // Nothing useful to do about it, and nothing worth failing the run over.
  }
}

/** This suite adds no test-scoped fixtures of its own — only the worker one. */
type TestFixtures = Record<never, never>;
interface WorkerFixtures {
  sharedContext: BrowserContext;
}

/**
 * Test fixture that collects browser V8 JS coverage for the app bundle when
 * E2E_COVERAGE=1 (set by scripts/test-all.sh). Entries are rewritten from the
 * served URL to the built bundle's file:// path and written in
 * NODE_V8_COVERAGE format, so `c8 report` can source-map them back to
 * `src/client/*`. Chromium-only (the only browser we run).
 */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  /**
   * **One browser context for the whole run** (NEWS-246).
   *
   * Playwright's default is a fresh context per test, and a context owns its own
   * connection pool — so closing one drops every socket it held and 183 tests
   * churn through them. Measured against this server, ten navigations cost:
   *
   *   fresh context each time  → 39 connections
   *   one shared context       →  0
   *
   * They land in `TIME_WAIT`, which macOS releases after 30 s and **Windows
   * after 120**, four times the backlog from the same rate. That is the leading
   * explanation for a Windows runner failing `page.goto` with
   * `ERR_NO_BUFFER_SPACE` while every other platform is fine.
   *
   * Pages stay **per-test** — a new one each time, closed after — so per-test
   * listeners, coverage and page state are unchanged. Only the pool is shared,
   * and a page closing does not disturb it (measured: still 0).
   *
   * The isolation a fresh context gave is restored explicitly in teardown:
   * `localStorage` cleared and permissions revoked. Doing it there rather than
   * in `addInitScript` matters — an init script runs on *every* navigation, so
   * clearing there would wipe state mid-test and break the specs that assert a
   * dismissal survives a reload.
   */
  sharedContext: [
    async ({ browser }, use) => {
      const context = await browser.newContext();
      // Suppress the first-run wizard's *auto*-open (NEWS-193).
      //
      // `maybeOpenOnboarding()` opens it when there are no topics AND no usable
      // provider AND it hasn't been seen on this device. Every test starts with
      // empty storage and specs reset topics, so the only term that varied was
      // "usable provider" — and that is decided by whether the *host* has a
      // signed-in `claude` or `codex` CLI.
      //
      // So the suite passed on a dev machine and could never pass on a CI
      // runner: there, onboarding opened and `.onboarding-backdrop` intercepted
      // pointer events for the rest of the run. The tell was that read-only a11y
      // scans passed and the first test that *clicked* timed out.
      //
      // Seeding the flag costs no coverage. No test asserts the auto-open, and
      // the specs that exercise onboarding open it explicitly via Settings →
      // `[data-action=rerun-onboarding]`. Deliberately not "give CI an API key":
      // that would paper over it and assert a state no first-run user is in.
      //
      // On the context, so it applies to every page it makes.
      await context.addInitScript(() => {
        try {
          localStorage.setItem('news:onboarding-seen', '1');
        } catch {
          // Storage disabled — the wizard reappears, which is the pre-fix state.
        }
      });
      await use(context);
      await context.close();
    },
    { scope: 'worker' },
  ],

  context: async ({ sharedContext }, use) => {
    // Specs that ask for `context` (permission grants) get the shared one, so a
    // grant and the page it affects are the same context.
    await use(sharedContext);
  },

  page: async ({ sharedContext, baseURL }, use) => {
    const page = await sharedContext.newPage();

    const collect = process.env['E2E_COVERAGE'] === '1';
    if (collect) await page.coverage.startJSCoverage({ resetOnNavigation: false });

    // The E2E bundle is built with kerf's dev diagnostics and
    // `invariants: 'throw'` (NEWS-100), which audits kerf's list bookkeeping
    // against the live DOM after every render. That throw surfaces here as an
    // uncaught page error — and without this listener it would be swallowed,
    // leaving the suite green while the DOM was quietly wrong. Collecting them
    // is what turns Playwright into a morph-correctness harness rather than
    // only a behaviour harness.
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    // Console output, written beside the failure (NEWS-238).
    //
    // Two CI failures were diagnosed from artifacts that contained no console
    // at all: the trace records network, DOM snapshots and steps, but Playwright
    // does not capture `console` unless something asks it to. kerf's dev
    // warnings — stale binding, list rebind, narrowed set — go to the console
    // and nowhere else, so precisely the diagnostics built to explain a
    // misbehaving morph were the ones being thrown away.
    //
    // Kept in memory and written only when the test fails, so a green run pays
    // nothing and a red one carries the evidence. Written as a file rather than
    // attached — see `writeDiagnostic`, and note that the *first* attempt at
    // this used `attach()` and produced nothing at all.
    //
    // One warning is promoted to a *failure* — see `memoWarnings`.
    const consoleLines: string[] = [];
    // kerf's duplicate-cacheKey warning, which is a bug report rather than
    // advice (NEWS-238). Its own text says what it costs: "duplicate values
    // cause some rows to return stale cached HTML when external state that
    // affects their render changes" — which is this ticket's entire failure
    // class, stated by the framework.
    //
    // It fired for months in CI and nobody read it, because a warning that only
    // ever lands in a console nobody collects is indistinguishable from silence.
    // Failing on it is the difference between a diagnostic and a guard.
    //
    // Matched on the phrase rather than the whole message so a reworded warning
    // still trips it, and narrow enough that ordinary kerf advice does not.
    const memoWarnings: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      consoleLines.push(`[${msg.type()}] ${text}`);
      if (text.includes('duplicate cacheKey')) memoWarnings.push(text);
    });

    // Poll timeline, attached on failure (NEWS-238).
    //
    // The open question about that failure family is *which half* is stuck: the
    // client polls `/api/state` every 4 s and re-renders from the answer, so a
    // UI that stays stale for 30 s is either not receiving polls or receiving
    // them and not rendering them. Those have nothing in common, and the console
    // capture added first came back empty — it can only speak if something
    // throws, and nothing does.
    //
    // A timestamped list of every `/api/state` response separates them outright.
    // A gap covering the stall means the poll stopped, and the suspect is the
    // `document.visibilityState === 'visible'` guard in `startPolling` — which
    // has no `visibilitychange` refresh behind it, so a page that goes hidden
    // stops updating and does not catch up. Polls continuing across the stall
    // means the data arrived and the render dropped it, which points at the
    // store or the morph instead.
    const polls: number[] = [];
    const started = Date.now();
    page.on('response', (res) => {
      if (res.url().includes('/api/state')) polls.push(Date.now() - started);
    });

    await use(page);

    const info = test.info();
    if (info.status !== info.expectedStatus) {
      // Is the failure even real? (NEWS-298.)
      //
      // Asked first, and printed loudest, because it decides whether anything
      // below is worth reading. When the shared server dies mid-file, every
      // later assertion in that file is testing nothing and Playwright reports
      // whichever one came next — during NEWS-280/281 that was a dirty-select
      // assertion for a feature nobody had touched, and the investigation went
      // there. One probe converts that whole class into a sentence.
      //
      // `console.error` and an annotation rather than a thrown error: this test
      // has already failed and its own message is the one a reader should see
      // first. Adding a second *error* would bury it.
      const verdict = await serverAlive(baseURL ?? '', {
        probe: async (url: string) => {
          const res = await page.request.get(url, { timeout: 5_000 });
          return { ok: res.ok(), status: res.status() };
        },
      });
      if (verdict.message !== '') {
        console.error(verdict.message);
        info.annotations.push({
          type: verdict.alive ? 'server-note' : 'void-run',
          description: verdict.alive ? verdict.message : 'the E2E server went away — later failures are not real',
        });
        writeDiagnostic('server-alive.txt', verdict.message);
      }

      // The file-level dependency, said *here* rather than only at the top of a
      // 2,000-line spec (NEWS-298). Someone reading one failing test in the HTML
      // report is 1,500 lines from that prose note and has no reason to look for
      // it. Attached on failure only: on every test it would be noise, and noise
      // is how a warning stops being read.
      info.annotations.push({
        type: 'state-dependent',
        description:
          'This file is mode: serial against one shared server, and its specs build on each other. ' +
          'If an earlier test in the file also failed, check that one first — this may be its consequence.',
      });

      // Best-effort: the page may already be closing, and a diagnostic must
      // never turn a real failure into a confusing one of its own.
      const visibility = await page
        .evaluate(() => ({ state: document.visibilityState, focused: document.hasFocus() }))
        .catch(() => null);
      const gaps = polls.slice(1).map((t, i) => t - (polls[i] ?? 0));
      writeDiagnostic(
        'poll-timeline.txt',
        [
          `visibility: ${JSON.stringify(visibility)}`,
          `/api/state responses: ${String(polls.length)} over ${String(Date.now() - started)}ms`,
          `largest gap: ${String(Math.max(0, ...gaps))}ms`,
          `offsets: ${polls.join(', ')}`,
        ].join('\n'),
      );
      writeDiagnostic('console.log', consoleLines.join('\n') || '(the page logged nothing)');

      // Store versus DOM, for the failures where the poll timeline shows the
      // data arriving and the UI not moving (NEWS-238). The timeline answers
      // "did it arrive"; this answers "then who dropped it".
      //
      // For every <select> on the page it records the live `value` — the
      // property a user sees — beside the option carrying the `selected`
      // *attribute*, which is what a morph writes. Those two disagreeing is the
      // signature of the HTML dirty-select rule, and agreeing rules it out and
      // points at the store instead. `settings` comes from the app's own store,
      // so a stale render can be told apart from stale state.
      const selects = await page
        .evaluate(() =>
          [...document.querySelectorAll('select')].map((el) => ({
            action: el.getAttribute('data-action'),
            value: el.value,
            selectedIndex: el.selectedIndex,
            attrOn: [...el.options].find((o) => o.hasAttribute('selected'))?.value ?? null,
          })),
        )
        .catch(() => null);
      // What the server says right now, fetched rather than scraped from the
      // page — so "the server clamped and the UI didn't" and "the server never
      // clamped" cannot be confused for each other.
      const serverSettings = await page
        .request.get('/api/state')
        .then((r) => r.json())
        .then((b: unknown) => (b as { settings?: unknown }).settings ?? null)
        .catch(() => null);
      writeDiagnostic('dom-state.json', JSON.stringify({ serverSettings, selects }, null, 2));
    }
    expect(pageErrors.map((e) => e.message), 'uncaught errors in the page').toEqual([]);
    expect(memoWarnings, 'kerf reported colliding each() cacheKeys — rows will serve each other stale HTML').toEqual(
      [],
    );
    if (collect) {
      const entries = await page.coverage.stopJSCoverage();
      const result = entries
        .filter((e) => e.url.endsWith('/static/app.js'))
        .map((e) => ({ ...e, url: `file://${appBundle}`, source: undefined }));
      if (result.length > 0) {
        fs.mkdirSync(browserCovDir, { recursive: true });
        const file = path.join(browserCovDir, `playwright-${process.pid}-${covFileCounter++}.json`);
        fs.writeFileSync(file, JSON.stringify({ result }));
      }
    }

    // Put back the isolation a fresh context used to give (NEWS-246). Both are
    // best-effort: a test that already failed must not be reported as failing
    // here instead, and the next test's own `goto` re-seeds what it needs.
    await page.evaluate(() => { localStorage.clear(); }).catch(() => undefined);
    await sharedContext.clearPermissions().catch(() => undefined);
    await page.close().catch(() => undefined);
  },
});

/**
 * Open the settings dialog on a given tab (NEWS-118).
 *
 * Settings is tabbed now, so a control is only in the DOM while its own tab is
 * showing. Tests that reach for a control have to say which tab it lives on —
 * which is also a readable statement of where the feature belongs.
 */
export async function openSettingsTab(page: Page, tab: 'Schedule' | 'Source' | 'Data' | 'App'): Promise<void> {
  await page.click('[data-action=open-settings]');
  await expect(page.locator('.dialog')).toBeVisible();
  await page.locator('.settings-tab').filter({ hasText: tab }).click();
  await expect(page.locator('.settings-tab.active')).toHaveText(tab);
}
