/**
 * Regenerates the inline README screenshots in `assets/stills/` (NEWS-214).
 *
 *   npm run demo:stills
 *
 * Sibling of `capture-demo.ts`, and **deliberately not part of it**. The hero is
 * one composed, animated, chrome-wrapped artifact telling a story in five beats;
 * these are flat single-scene screenshots of individual features. Sharing a
 * pipeline would mean every still carrying the animation machinery, and every
 * hero beat carrying the still machinery. Glassbox reached the same conclusion
 * and keeps its `capture-stills.ts` separate for the same reason.
 *
 * **Every still is the real running app.** The script boots a real server in
 * `--demo` mode, drives the live UI to each state with Playwright, and captures
 * what is on screen. A screenshot cannot drift from the product without this
 * script breaking — which is the entire argument for doing it this way rather
 * than cropping something by hand once and letting it rot.
 *
 * Each scene produces a **PNG** (what the README embeds) and a stand-alone
 * **SVG** (crisp at any zoom, and diffable — a text diff on an SVG shows what
 * actually changed in the UI, which a PNG cannot). `--demo` implies `--ai-test`,
 * so no lead images are ever fetched and every scene here qualifies for both.
 *
 * ### One server per scene
 *
 * Scenes **mutate real state** — flagging a story off-topic, promoting a topic.
 * Sharing one server would make each screenshot depend on which ones ran before
 * it, so reordering this array would silently change the pictures. A fresh
 * server and data directory per scene costs a few seconds each and buys genuine
 * independence: any scene can be run, reordered or removed without touching the
 * others.
 *
 * Which topics are followed is **per scene** for the same reason, and because it
 * is part of the state being photographed: discovery only ever suggests topics
 * you are *not* already following, so the discovery scenes have to leave one out.
 *
 * ### Two constraints inherited from `capture-demo.ts`, not rediscovered
 *
 * - **Must run outside the command sandbox** — Chromium needs Mach ports.
 * - Trees are captured live but **rendered to SVG after teardown**. domotion's
 *   macOS glyph-path extraction is flaky under contention and falls back
 *   *silently* to CSS `<text>`, which renders as tofu on a machine without the
 *   font. The `@font-face` assertion is what catches that.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Browser, Page } from '@playwright/test';
import {
  captureElementTree,
  clearEmbeddedFonts,
  elementTreeToSvg,
  launchChromium,
  optimizeSvg,
  setRenderTextMode,
} from 'domotion-svg';

import { BUILTIN_CATEGORIES } from '../../src/categories.js';
import { THREAD_ROW_CAP } from '../../src/client/thread-view.js';
import type { DemoTopic } from '../../src/demo.js';
import { DEMO_FIRST_CHECK_STORIES, DEMO_TOPICS } from '../../src/demo.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = resolve(ROOT, 'assets/stills');

/**
 * Review captures (NEWS-263) — **not** demo assets, and deliberately elsewhere.
 *
 * `assets/stills/` is git-tracked because those seven images are in the README.
 * These are throwaway inputs for `/design-review`, regenerated whenever someone
 * looks; tracking two more variants of each would triple the binary churn in the
 * repo to serve a workflow that reads them once. Ignored, and named like the
 * existing `.debug/` directory the hero already writes to.
 */
const REVIEW_DIR = resolve(ROOT, 'scripts/demo/.review');

/**
 * Wide enough for the multi-column feed (FR-3.36–3.39 switches layout on width),
 * which is one of the things worth showing and is invisible at the hero's size.
 */
const VIEWPORT = { width: 1440, height: 900 };

/**
 * What a review pass photographs, beyond the default.
 *
 * The demo stills are light mode at desktop width — the two conditions a design
 * critique needs *least*, because they are the ones already known to work. Dark
 * mode is a genuinely different palette ("pre-dawn slate-green", FR-3.7) and the
 * place contrast problems live; the narrow width crosses the 860px one-column
 * collapse, where composition breaks if it is going to.
 *
 * Uncropped on purpose. The demo crops frame one feature; a critique is judging
 * the whole composition, and a crop would hide the balance being assessed.
 */
const REVIEW_VARIANTS = [
  { suffix: 'dark', viewport: VIEWPORT, colorScheme: 'dark' as const },
  { suffix: 'narrow', viewport: { width: 720, height: 1000 }, colorScheme: 'light' as const },
];

/** `--review` also captures the dark and narrow variants (NEWS-263). */
const REVIEW = process.argv.includes('--review');

/**
 * `--only <scene>` captures one scene (NEWS-264).
 *
 * For CI, where the point is a *smoke* signal rather than fresh artwork: the hero
 * capture sat broken for weeks because a modal started swallowing its clicks, and
 * nothing ran the captures to notice. One non-soaking scene boots the real server,
 * drives the real UI and takes about fifteen seconds, which is enough to catch
 * that class of break. A full run is minutes, most of it the `topics` soak.
 *
 * Also useful by hand when iterating on a single scene.
 */
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i === -1 ? null : (process.argv[i + 1] ?? null);
})();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A region of the page to capture, or the whole viewport. */
interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Scene {
  /** File stem: `assets/stills/<name>.png`. */
  name: string;
  /** What it shows — becomes the README alt text, so it is written for a reader. */
  alt: string;
  /**
   * Topics to follow before the page opens. Defaults to all of them; a discovery
   * scene must hold one back, since discovery only suggests topics you are not
   * already following.
   */
  topics?: DemoTopic[];
  /**
   * Server-side state to arrange before the page opens, through the same HTTP
   * API the UI calls. For state the screenshot is *about* rather than state the
   * screenshot is *of* — promoting a topic here rather than right-clicking it
   * leaves no selection highlight on the rows being photographed.
   */
  arrange?: (base: string) => Promise<void>;
  /** Drives the live UI into the state being photographed. */
  setup: (page: Page) => Promise<void>;
  /**
   * Crop, as a CSS selector resolved at capture time. Omit for the whole
   * viewport. A selector rather than fixed numbers on purpose: pixel coordinates
   * rot the moment the layout moves, and silently — the crop still succeeds, it
   * just frames the wrong thing.
   */
  clipTo?: string;
  /** Padding around a `clipTo` box, so a cropped scene doesn't look guillotined. */
  clipPad?: number;
  /**
   * For a scene that needs *time* to have passed before it is worth a picture.
   *
   * The next-check dial drains from full over the check interval, so a topic
   * checked seconds ago shows a **full** ring — which is what every scene here
   * would otherwise get, since adding a topic checks it immediately (FR-1.12).
   * A visibly part-drained ring needs elapsed time, and the interval floor is
   * five minutes, so it needs *minutes*.
   *
   * Rather than sleeping for them outright, a soaking scene's server starts
   * **before** all the others and is photographed **after** them, so the wait
   * overlaps work that has to happen anyway. Measured, that overlap is smaller
   * than it sounds — the other six scenes take about 15 seconds between them —
   * so a two-minute soak still costs roughly 105 seconds of real waiting. It is
   * the cheapest option available, not a free one: the alternatives were a
   * demo-only way to backdate `lastCheckedAt` (a product affordance existing
   * solely for a screenshot, and one that writes a false timestamp) or shipping
   * a picture of a dial that never moves.
   */
  soak?: {
    /** Check interval to set, in ms. The dial's denominator. */
    intervalMs: number;
    /** How much of it must elapse before capturing. Must be under `intervalMs`. */
    minElapsedMs: number;
  };
}

/** Wait for the feed to actually show `n` stories, rather than guessing a delay. */
async function waitForStories(page: Page, atLeast: number): Promise<void> {
  await page.waitForFunction((n: number) => document.querySelectorAll('.item').length >= n, atLeast, {
    timeout: 30_000,
  });
}

/** Right-click a row and pick an action — the same path `tests/e2e/fixtures.ts` uses. */
async function menuAction(page: Page, rowSelector: string, action: string): Promise<void> {
  await page.locator(rowSelector).first().click({ button: 'right' });
  await page.waitForSelector('.menu', { timeout: 10_000 });
  await page.locator(`[data-menu-action=${action}]`).click();
  await page.waitForSelector('.menu', { state: 'detached', timeout: 10_000 });
}

/**
 * The section and subject chip the discovery scenes click through.
 *
 * Both come from **`BUILTIN_CATEGORIES`**, not from the demo topic's own
 * `category`/`subcategory` — those are free-text hints for the classifier, held
 * to the taxonomy by a test rather than by the type system. They did not all name
 * real chips until NEWS-395 repaired four that a taxonomy edit had orphaned, and
 * nothing here noticed. Reading the labels off the table that renders them is the
 * only way this can't click a chip that isn't there.
 *
 * Which section is picked doesn't change *what* is suggested: the demo provider
 * returns every unfollowed demo topic regardless of the section asked for. The
 * walk is here to photograph the real navigation path, not to filter — but it
 * should still pick the section the held-back topic actually files itself
 * under, or the screenshot shows a "World · Africa" heading above a result
 * grouped under Business, which reads as a bug.
 *
 * **That workaround only ever matched the category, not the subcategory**, which
 * is why the shipped screenshot still showed "Business · Markets" over a group
 * labelled "BUSINESS · OTHER" — `subcategories[0]` is a guess at the chip. The UI
 * now explains that gap itself with a "closest matches" note (NEWS-269, FR-24.5),
 * so the mismatch is no longer misread as a broken filter and this alignment is a
 * nicety rather than a requirement.
 */
// `.at(0)` rather than `[0]`: this project does not run
// `noUncheckedIndexedAccess`, so `BUILTIN_CATEGORIES[0]` is typed as definitely
// present and the guard below then reads as dead code. `.at()` returns
// `T | undefined`, which is the truth — the array could be empty — so the guard
// is honest and the linter agrees with it (NEWS-264).
const DISCOVER_CATEGORY =
  BUILTIN_CATEGORIES.find((c) => c.label === DEMO_TOPICS.at(-1)?.category) ?? BUILTIN_CATEGORIES.at(0);
const DISCOVER_SECTION = DISCOVER_CATEGORY?.label;
const DISCOVER_CHIP = DISCOVER_CATEGORY?.subcategories[0]?.label;
if (DISCOVER_SECTION === undefined || DISCOVER_CHIP === undefined) {
  throw new Error('BUILTIN_CATEGORIES[0] needs at least one subcategory for the discovery scenes');
}

/**
 * Discovery only ever suggests topics you are **not** already following, so the
 * discovery scenes hold one back. Without this they photograph an empty result.
 */
const ALL_BUT_DISCOVERABLE = DEMO_TOPICS.slice(0, -1);

/**
 * The one demo topic whose stories are a single unfolding subject (NEWS-292).
 *
 * Found by shape rather than named by index: the thread scene is about the
 * topic that *has* a thread, and a positional lookup would silently photograph
 * the wrong topic the moment the fixture list is reordered — which it was, when
 * this topic had to go second-to-last so the discover scene keeps holding back
 * the one it already held back.
 */
const THREAD_TOPIC = DEMO_TOPICS.find((t) => t.first.length + t.second.length > THREAD_ROW_CAP);
if (THREAD_TOPIC === undefined) {
  throw new Error('scene "thread": no demo topic produces more than THREAD_ROW_CAP stories');
}

const SCENES: Scene[] = [
  {
    name: 'feed',
    alt: 'The Newsmonger feed: watched topics in the sidebar, and summarized stories with links to their sources.',
    setup: async (page) => {
      await waitForStories(page, DEMO_FIRST_CHECK_STORIES);
      await sleep(600);
    },
  },
  {
    name: 'topics',
    alt: 'The topics sidebar: each watched topic with its category and a dial counting down to its next check, with one marked high priority.',
    // The sidebar alone. At full width the topics panel is a fifth of the frame,
    // and what this scene is about would be a few hundred pixels in the corner
    // of a 1440px image.
    clipTo: '#topics-panel',
    clipPad: 16,
    // Five minutes is the interval floor the settings API enforces; two of them
    // elapsed leaves the ring ~60% full, which reads as counting down rather
    // than as either extreme. Kept well under `intervalMs` on purpose — at the
    // interval the scheduler checks again and the ring resets to full.
    soak: { intervalMs: 5 * 60 * 1000, minElapsedMs: 2 * 60 * 1000 },
    // Through the API rather than the row's own menu: right-clicking a row
    // *selects* it, and the screenshot would ship with a highlight bar over the
    // thing it is meant to be showing. Same endpoint the menu calls.
    arrange: async (base) => {
      const res = await fetch(`${base}/api/state`);
      const state = (await res.json()) as { topics: { id: string }[] };
      const first = state.topics.at(0);
      if (first === undefined) throw new Error('scene "topics": no topics to promote');
      await fetch(`${base}/api/topics/${first.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ highPriority: true }),
      });
    },
    setup: async (page) => {
      await waitForStories(page, DEMO_FIRST_CHECK_STORIES);
      await sleep(800);
    },
  },
  {
    name: 'discover',
    alt: 'Topic discovery: browse by section and subject, with a reason given for every suggestion.',
    topics: ALL_BUT_DISCOVERABLE,
    setup: async (page) => {
      await page.click('[data-action=open-discover]');
      await page.waitForSelector('.dialog', { timeout: 15_000 });
      await page.click(`.section-tile:has-text("${DISCOVER_SECTION}")`);
      await page.click(`.section-chips .chip:has-text("${DISCOVER_CHIP}")`);
      await page.waitForSelector('.suggestion', { timeout: 30_000 });
      await sleep(700);
    },
  },
  {
    name: 'tuner',
    alt: 'The keep/skip tuner: one candidate topic at a time, with a round counter and a way out at any point.',
    topics: ALL_BUT_DISCOVERABLE,
    setup: async (page) => {
      await page.click('[data-action=open-discover]');
      await page.waitForSelector('.dialog', { timeout: 15_000 });
      // The tuner is a *depth control*, not an entry point (FR-24.5) — it is
      // reached by asking for "narrower" from a result. Walking down to it is
      // the point; jumping straight there would photograph a state the UI never
      // actually enters on its own.
      await page.click(`.section-tile:has-text("${DISCOVER_SECTION}")`);
      await page.click(`.section-chips .chip:has-text("${DISCOVER_CHIP}")`);
      await page.waitForSelector('.suggestion', { timeout: 30_000 });
      await page.locator('.suggestion .link-btn', { hasText: 'narrower' }).first().click();
      // Wait for the keep/skip pair rather than the dialog, or this shoots a spinner.
      await page.waitForSelector('[data-tuner=keep]', { timeout: 30_000 });
      await sleep(700);
    },
  },
  {
    name: 'review',
    alt: 'Review mode: the stories flagged off-topic, gathered so the topic can be corrected.',
    setup: async (page) => {
      await waitForStories(page, DEMO_FIRST_CHECK_STORIES);
      // Flag a story off-topic through its own menu, then open review for its
      // topic — the same two steps a person takes.
      const card = page.locator('.item').first();
      // Read which topic the card belongs to *before* flagging it. "Review
      // flagged" is disabled on a topic with nothing flagged, so opening it on
      // whichever row happens to be first only works when the feed's first story
      // happens to belong to it — true today, and a coin flip after any change
      // to the fixtures or the sort.
      const topic = ((await card.locator('.item-topic').first().textContent()) ?? '').trim();
      if (topic === '') throw new Error('scene "review": could not read the first story\'s topic');
      await card.click({ button: 'right' });
      await page.waitForSelector('.menu', { timeout: 10_000 });
      await page.click('[data-item-menu-action=flag]');
      await sleep(600);
      await menuAction(page, `[data-topic-row]:has-text("${topic}")`, 'review-flagged');
      await sleep(800);
    },
  },
  {
    name: 'thread',
    alt: 'An expanded story card showing the story so far: every earlier instalment on the same subject, dated and attributed, with a way to see the whole run.',
    // The card alone. The timeline is a detail *inside* one card in a two-column
    // feed, so a 1440px frame would make the thing this scene is about a few
    // hundred pixels in the middle of a page of other stories — the same reason
    // `export` and `topics` crop.
    clipTo: '.item.expanded',
    clipPad: 20,
    // A second check, so the thread outgrows THREAD_ROW_CAP (4) and the pane
    // shows what it is holding back. Six is the smallest number that makes
    // "Show all 6 stories" appear, and that affordance is half of what the
    // feature does — a capped list that never says it is capped looks like a
    // list. Through the API rather than the row's menu, per FR-28.5, and because
    // right-clicking a row leaves a selection highlight in the picture.
    arrange: async (base) => {
      const res = await fetch(`${base}/api/state`);
      const state = (await res.json()) as { topics: { id: string; name: string }[] };
      const topic = state.topics.find((t) => t.name === THREAD_TOPIC.name);
      if (topic === undefined) throw new Error(`scene "thread": ${THREAD_TOPIC.name} was not added`);
      await fetch(`${base}/api/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topicId: topic.id }),
      });
    },
    setup: async (page) => {
      // Every story from both checks, so the pane cannot be photographed while
      // the thread is still arriving — a timeline caught mid-fill would ship a
      // screenshot of the wrong number.
      await waitForStories(page, DEMO_FIRST_CHECK_STORIES + THREAD_TOPIC.second.length);
      // The newest instalment, which is the card a reader would open: it is the
      // one with the most history behind it, and its badge reads "6th update".
      const card = page
        .locator('.item:not(.flagged-row)', { has: page.locator('.item-topic', { hasText: THREAD_TOPIC.name }) })
        .first();
      await card.locator('[data-expand-item]').click();
      // Wait on the rows themselves: the timeline is a second request made on
      // expand (FR-29.30), so the pane is briefly open and empty.
      await page.waitForSelector('.item.expanded .thread-row', { timeout: 15_000 });
      await page.waitForSelector('.item.expanded [data-action=show-all-thread]', { timeout: 15_000 });
      await sleep(600);
    },
  },
  {
    name: 'settings-source',
    alt: 'Settings: which AI provider does the searching, at what reasoning effort, and where its API key goes.',
    setup: async (page) => {
      await page.click('[data-action=open-settings]');
      await page.waitForSelector('.dialog', { timeout: 10_000 });
      await page.locator('.settings-tab').filter({ hasText: 'Source' }).click();
      await page.waitForSelector('[data-action=provider]', { timeout: 10_000 });
      await sleep(600);
    },
  },
  {
    name: 'export',
    alt: 'The export dialog: stories out as Markdown or JSON, all of them or just the bookmarks.',
    // The dialog alone. Export opens *from* Settings → Data, so the full frame
    // shows it stacked on the settings dialog with that tab's prose bleeding out
    // around it — real, but it reads as a rendering fault rather than a feature.
    clipTo: '.export-dialog',
    clipPad: 24,
    setup: async (page) => {
      await waitForStories(page, DEMO_FIRST_CHECK_STORIES);
      await page.click('[data-action=open-settings]');
      await page.waitForSelector('.dialog', { timeout: 10_000 });
      await page.locator('.settings-tab').filter({ hasText: 'Data' }).click();
      await page.click('[data-action=open-export]');
      await page.waitForSelector('.export-dialog', { timeout: 10_000 });
      await sleep(700);
    },
  },
];

/** A running demo server, and the base URL it printed for itself. */
interface Server {
  proc: ChildProcess;
  base: string;
  dataDir: string;
}

/**
 * Boot a demo server on an ephemeral port and wait for its readiness line.
 *
 * The URL comes from the server's **own output**, never a hardcoded port.
 * `capture-demo.ts` learned that the hard way: with a fixed port and a stray
 * process already on it, the capture happily photographed whatever else was
 * answering there. `READY_RE` tracks the marker in `src/cli.ts`, which
 * `src-tauri/src/lib.rs` also depends on.
 */
/**
 * A port the OS says is free, and that `fetch` will actually talk to
 * (NEWS-285).
 *
 * The demo servers used to take whatever `--port` fell forward to from 4187.
 * The stills run holds **two** servers at once — the soaking scene's stays up
 * while the others shoot — so the second landed on 4190, and every `fetch` to it
 * died with `bad port`: **4190 is `sieve` on the WHATWG Fetch blocked-port
 * list**, which undici enforces. A perfectly healthy server that no `fetch` may
 * address, reported as a network error with no mention of the port.
 *
 * Binding to `0` sidesteps the whole class: the OS hands back an ephemeral port,
 * which on every platform we run sits far above the highest blocked port
 * (10080). The bind-close-reuse race is theoretical here — one process, two
 * servers, seconds apart — and `--strict-port` turns a lost race into a loud
 * failure rather than a silent fall-forward into the next blocked port.
 */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise<number>((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => {
        if (port === 0) rej(new Error('could not find a free port'));
        else res(port);
      });
    });
  });
}

async function startServer(): Promise<Server> {
  // Never `~/.newsmonger` — this creates topics and runs checks, and that is
  // someone's real install.
  const dataDir = mkdtempSync(resolve(tmpdir(), 'newsmonger-stills-'));
  const port = await freePort();
  const proc = spawn(
    // `node --import tsx/esm`, not the `tsx` CLI (NEWS-285, following NEWS-299).
    // Same loader, same source; the CLI additionally opens a unix socket to talk
    // to its own child, which a command sandbox refuses. Demo capture cannot run
    // sandboxed anyway (Chromium needs a Mach port, NEWS-311), but leaving the
    // one remaining CLI spawn here is how the rule gets forgotten.
    process.execPath,
    ['--import', 'tsx/esm', 'src/cli.ts', '--demo', '--no-open', '--strict-port', '--port', String(port), '--data-dir', dataDir],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // Accumulated, not matched per chunk (NEWS-285).
  //
  // `stdout` arrives in whatever pieces the pipe hands over, and a split inside
  // the readiness URL matches a *truncated* one: a break after the colon yields
  // `http://127.0.0.1:` and every later fetch dies with `bad port`. Intermittent
  // by nature — it depends on where the kernel breaks the buffer — which is why
  // it survived a working `--only feed` run and failed on the full set minutes
  // later.
  const READY_RE = /running at (\S+)\s/;
  let base = '';
  let out = '';
  let exited = false;
  proc.on('exit', () => {
    exited = true;
  });
  proc.stdout.on('data', (d: Buffer) => {
    out += d.toString();
    const m = READY_RE.exec(out);
    if (m?.[1] !== undefined && base === '') base = m[1];
  });
  proc.stderr.on('data', (d: Buffer) => process.stderr.write(`[server] ${d.toString()}`));

  /* eslint-disable @typescript-eslint/no-unnecessary-condition -- `base` and the exit flag are assigned by the `stdout` / `exit` handlers above. TypeScript narrows them to their initial literal values because its control-flow analysis cannot see a callback run, so it reads this wait as dead code. Annotating the declarations does not help: the *narrowed* type at this point is still the literal. Tried and reverted in NEWS-264. */
  for (let i = 0; i < 240 && base === '' && !exited; i++) await sleep(250);
  if (base === '') {
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(
      exited
        ? 'The demo server exited before printing its readiness line (see [server] output above).'
        : 'Timed out waiting for the demo server readiness line.',
    );
  }
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  return { proc, base, dataDir };
}

/**
 * Idempotent: a soaking scene is stopped in its own `finally` and again in the
 * outer one that exists to catch a mid-run throw. Killing a dead pid and
 * force-removing a gone directory both happen to be harmless, but relying on
 * that is not the same as saying it.
 */
const stopped = new Set<ChildProcess>();
function stopServer(s: Server): void {
  if (stopped.has(s.proc)) return;
  stopped.add(s.proc);
  s.proc.kill('SIGTERM');
  setTimeout(() => s.proc.kill('SIGKILL'), 2000).unref();
  rmSync(s.dataDir, { recursive: true, force: true });
}

/** Resolve a scene's crop against the live page, clamped to the viewport. */
async function clipFor(page: Page, scene: Scene): Promise<Clip> {
  if (scene.clipTo === undefined) return { x: 0, y: 0, ...VIEWPORT };
  const box = await page.locator(scene.clipTo).first().boundingBox();
  if (box === null) {
    throw new Error(`scene "${scene.name}": clipTo selector ${scene.clipTo} matched nothing`);
  }
  const pad = scene.clipPad ?? 0;
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  return {
    x,
    y,
    width: Math.min(VIEWPORT.width - x, Math.ceil(box.width + pad * 2)),
    height: Math.min(VIEWPORT.height - y, Math.ceil(box.height + pad * 2)),
  };
}

async function main(): Promise<void> {
  // Wiped only on a **full** run. The wipe is what removes a renamed scene's
  // stale file — `stills.test.ts` fails on a captured file belonging to no scene
  // — but with `--only` it would delete the six scenes this run is not
  // capturing. The first `--only feed` run did exactly that, and `git status`
  // was what noticed (NEWS-264).
  if (ONLY === null) rmSync(OUT_DIR, { recursive: true, force: true });
  if (ONLY !== null && !SCENES.some((sc) => sc.name === ONLY)) {
    // Loudly, because a typo would otherwise "pass" by capturing nothing — which
    // is the failure mode a smoke test exists to avoid.
    throw new Error(`--only ${ONLY}: no such scene. Have: ${SCENES.map((sc) => sc.name).join(', ')}`);
  }
  const scenes = ONLY === null ? SCENES : SCENES.filter((sc) => sc.name === ONLY);

  mkdirSync(OUT_DIR, { recursive: true });
  if (REVIEW) mkdirSync(REVIEW_DIR, { recursive: true });

  /** Captured live, rendered after teardown — see the header. */
  const captured: { name: string; tree: Awaited<ReturnType<typeof captureElementTree>>; clip: Clip }[] = [];
  const browser: Browser = await launchChromium();

  /** Seed a scene's server: topics, the soak interval, and its `arrange` step. */
  const prepare = async (scene: Scene, server: Server): Promise<void> => {
    // Seed topics through the real API, so the app reaches this state the way a
    // user would rather than by a fixture write behind its back. Adding a topic
    // fires an immediate first check (FR-1.12), so stories arrive on their own —
    // and, for a soaking scene, the dial starts draining from this moment.
    for (const t of scene.topics ?? DEMO_TOPICS) {
      await fetch(`${server.base}/api/topics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: t.name }),
      });
    }
    // Suppress the backup offer (NEWS-263). It appears once a third topic exists
    // (FR-27.4) and opens a modal with a backdrop that swallows every click —
    // which is exactly what broke the hero capture: the discover beat timed out
    // for 30s against an invisible interceptor. Set through the real settings API
    // rather than by dismissing the dialog, so the state is reached the way a user
    // who chose "don't ask again" reaches it (FR-28.5).
    await fetch(`${server.base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backupPromptNever: true }),
    });

    if (scene.soak) {
      await fetch(`${server.base}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkIntervalMs: scene.soak.intervalMs }),
      });
    }
    await scene.arrange?.(server.base);
  };

  /**
   * Open a page against a prepared server, run the scene, and capture it.
   *
   * With a `variant` this is a **review** capture (NEWS-263): the other palette
   * or the narrow layout, uncropped, into `.review/`, and it contributes nothing
   * to the SVG/README pipeline.
   */
  const shoot = async (
    scene: Scene,
    server: Server,
    variant?: (typeof REVIEW_VARIANTS)[number],
  ): Promise<void> => {
    const page = await browser.newPage({
      viewport: variant?.viewport ?? VIEWPORT,
      ...(variant === undefined ? {} : { colorScheme: variant.colorScheme }),
    });
    try {
      // Onboarding would cover every scene with a modal.
      await page.addInitScript(() => {
        localStorage.setItem('news:onboarding-seen', '1');
      });
      await page.goto(server.base, { waitUntil: 'networkidle' });
      await scene.setup(page);

      if (variant !== undefined) {
        const file = resolve(REVIEW_DIR, `${scene.name}-${variant.suffix}.png`);
        await page.screenshot({ path: file, fullPage: false });
        console.log(`[stills] ${scene.name}-${variant.suffix} (review)`);
        return;
      }

      const clip = await clipFor(page, scene);
      await page.screenshot({ path: resolve(OUT_DIR, `${scene.name}.png`), clip });
      captured.push({ name: scene.name, tree: await captureElementTree(page, undefined, clip), clip });
      console.log(`[stills] ${scene.name} (${String(clip.width)}×${String(clip.height)})`);
    } finally {
      await page.close().catch(() => undefined);
    }
  };

  /**
   * Shoot every review variant of a scene, **each on its own freshly prepared
   * server**.
   *
   * Not a loop over pages against one server, for the reason FR-28.10 gives: a
   * scene's `setup` mutates real state — flagging a story off-topic, promoting a
   * topic — so running it three times against one server would compound those
   * mutations and photograph the second and third variants in a state the first
   * never saw. The variants would then differ by more than the palette, which is
   * the one thing a theme comparison must not do.
   */
  const shootReviewVariants = async (scene: Scene): Promise<void> => {
    for (const variant of REVIEW_VARIANTS) {
      const server = await startServer();
      try {
        await prepare(scene, server);
        await shoot(scene, server, variant);
      } finally {
        stopServer(server);
      }
    }
  };

  // Soaking scenes start first and are shot last, so their wait overlaps the
  // other scenes instead of being added to the runtime.
  const soaking: { scene: Scene; server: Server; seededAt: number }[] = [];

  try {
    for (const scene of scenes.filter((sc) => sc.soak)) {
      const server = await startServer();
      await prepare(scene, server);
      soaking.push({ scene, server, seededAt: Date.now() });
      console.log(`[stills] ${scene.name}: soaking, will shoot after the others`);
    }

    for (const scene of scenes.filter((sc) => !sc.soak)) {
      const server = await startServer();
      try {
        await prepare(scene, server);
        await shoot(scene, server);
      } finally {
        stopServer(server);
      }
      if (REVIEW) await shootReviewVariants(scene);
    }

    for (const { scene, server, seededAt } of soaking) {
      const soak = scene.soak;
      if (!soak) continue;
      const elapsed = Date.now() - seededAt;
      if (elapsed < soak.minElapsedMs) {
        const wait = soak.minElapsedMs - elapsed;
        console.log(`[stills] ${scene.name}: waiting a further ${String(Math.ceil(wait / 1000))}s to drain the dial`);
        await sleep(wait);
      }
      // Past the interval the scheduler checks again and the ring resets to
      // full, which is the state this scene exists to avoid. Say so rather than
      // shipping a picture that quietly shows the wrong thing.
      if (Date.now() - seededAt >= soak.intervalMs) {
        console.warn(`[stills] ${scene.name}: soak exceeded the interval — the dial has reset to full`);
      }
      try {
        await shoot(scene, server);
      } finally {
        stopServer(server);
      }
      // Review variants of a soaking scene skip the soak: it costs minutes and
      // buys a drained dial, which is a demo detail rather than a design one. The
      // ring will read full in these — expected, not a bug.
      if (REVIEW) await shootReviewVariants(scene);
    }
  } finally {
    for (const { server } of soaking) stopServer(server);
    await browser.close().catch(() => undefined);
  }

  // --- Render, now that nothing is competing for the glyph helper ---
  clearEmbeddedFonts();
  setRenderTextMode('embedded-font');

  for (const { name, tree, clip } of captured) {
    const scene = SCENES.find((s) => s.name === name);
    let svg = elementTreeToSvg(tree, clip.width, clip.height, {
      title: `Newsmonger — ${name}`,
      desc: scene?.alt,
    });
    // Without an embedded font subset the captured text renders as tofu anywhere
    // the fonts aren't installed — which is most places a README is read. The
    // fallback to CSS `<text>` is silent, so assert rather than trust.
    if (!svg.includes('@font-face')) {
      throw new Error(`${name}: no embedded @font-face — captured text would render as tofu.`);
    }
    try {
      svg = optimizeSvg(svg);
    } catch (e) {
      console.warn(`optimizeSvg failed for ${name} (${(e as Error).message}); shipping unoptimized.`);
    }
    writeFileSync(resolve(OUT_DIR, `${name}.svg`), svg);
  }

  console.log(`\n✓ ${String(captured.length)} stills in ${OUT_DIR} (PNG + SVG each)`);
}

await main();
