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
import type { DemoTopic } from '../../src/demo.js';
import { DEMO_TOPICS } from '../../src/demo.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = resolve(ROOT, 'assets/stills');

/**
 * Wide enough for the multi-column feed (FR-3.36–3.39 switches layout on width),
 * which is one of the things worth showing and is invisible at the hero's size.
 */
const VIEWPORT = { width: 1440, height: 900 };

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
    /** How much of it must elapse before capturing. Must be < `intervalMs`. */
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
 * `category`/`subcategory` — those are free-text hints for the classifier, and
 * they do not all name real chips (a fixture says `Climate`; the taxonomy says
 * `Climate & Environment`). Reading the labels off the table that renders them
 * is the only way this can't click a chip that isn't there.
 *
 * Which section is picked doesn't change *what* is suggested: the demo provider
 * returns every unfollowed demo topic regardless of the section asked for. The
 * walk is here to photograph the real navigation path, not to filter — but it
 * should still pick the section the held-back topic actually files itself
 * under, or the screenshot shows a "World · Africa" heading above a result
 * grouped under Business, which reads as a bug.
 */
const DISCOVER_CATEGORY =
  BUILTIN_CATEGORIES.find((c) => c.label === DEMO_TOPICS.at(-1)?.category) ?? BUILTIN_CATEGORIES[0];
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

const SCENES: Scene[] = [
  {
    name: 'feed',
    alt: 'The Newsmonger feed: watched topics in the sidebar, and summarized stories with links to their sources.',
    setup: async (page) => {
      await waitForStories(page, DEMO_TOPICS.length * 2);
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
      const first = state.topics[0];
      if (first === undefined) throw new Error('scene "topics": no topics to promote');
      await fetch(`${base}/api/topics/${first.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ highPriority: true }),
      });
    },
    setup: async (page) => {
      await waitForStories(page, DEMO_TOPICS.length * 2);
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
      await waitForStories(page, DEMO_TOPICS.length * 2);
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
      await waitForStories(page, DEMO_TOPICS.length * 2);
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
async function startServer(): Promise<Server> {
  // Never `~/.newsmonger` — this creates topics and runs checks, and that is
  // someone's real install.
  const dataDir = mkdtempSync(resolve(tmpdir(), 'newsmonger-stills-'));
  const proc = spawn(
    resolve(ROOT, 'node_modules/.bin/tsx'),
    ['src/cli.ts', '--demo', '--no-open', '--data-dir', dataDir],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const READY_RE = /running at (\S+)/;
  let base = '';
  let exited = false;
  proc.on('exit', () => {
    exited = true;
  });
  proc.stdout?.on('data', (d: Buffer) => {
    const m = READY_RE.exec(d.toString());
    if (m?.[1] !== undefined && base === '') base = m[1];
  });
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[server] ${d.toString()}`));

  for (let i = 0; i < 240 && base === '' && !exited; i++) await sleep(250);
  if (base === '') {
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(
      exited
        ? 'The demo server exited before printing its readiness line (see [server] output above).'
        : 'Timed out waiting for the demo server readiness line.',
    );
  }
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
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

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
    if (scene.soak) {
      await fetch(`${server.base}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkIntervalMs: scene.soak.intervalMs }),
      });
    }
    await scene.arrange?.(server.base);
  };

  /** Open a page against a prepared server, run the scene, and capture it. */
  const shoot = async (scene: Scene, server: Server): Promise<void> => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    try {
      // Onboarding would cover every scene with a modal.
      await page.addInitScript(() => {
        localStorage.setItem('news:onboarding-seen', '1');
      });
      await page.goto(server.base, { waitUntil: 'networkidle' });
      await scene.setup(page);

      const clip = await clipFor(page, scene);
      await page.screenshot({ path: resolve(OUT_DIR, `${scene.name}.png`), clip });
      captured.push({ name: scene.name, tree: await captureElementTree(page, undefined, clip), clip });
      console.log(`[stills] ${scene.name} (${String(clip.width)}×${String(clip.height)})`);
    } finally {
      await page.close().catch(() => undefined);
    }
  };

  // Soaking scenes start first and are shot last, so their wait overlaps the
  // other scenes instead of being added to the runtime.
  const soaking: { scene: Scene; server: Server; seededAt: number }[] = [];

  try {
    for (const scene of SCENES.filter((sc) => sc.soak)) {
      const server = await startServer();
      await prepare(scene, server);
      soaking.push({ scene, server, seededAt: Date.now() });
      console.log(`[stills] ${scene.name}: soaking, will shoot after the others`);
    }

    for (const scene of SCENES.filter((sc) => !sc.soak)) {
      const server = await startServer();
      try {
        await prepare(scene, server);
        await shoot(scene, server);
      } finally {
        stopServer(server);
      }
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
