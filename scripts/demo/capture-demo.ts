/**
 * Regenerates `assets/demo.svg` (+ `.svgz`) — the animated hero in the README.
 *
 *   npm run demo:capture
 *
 * Modelled on `~/Documents/glassbox/scripts/demo/capture-demo.ts`. It boots a real
 * Newsmonger server in `--demo` mode, drives the live UI with Playwright, captures
 * each beat as an element tree, and composes one infinitely-looping SVG.
 *
 * **The hero is the real app.** Nothing here is mocked up — every frame is the
 * actual rendered UI, so the hero cannot drift from the product without this
 * script breaking. That is the whole reason to do it this way rather than in a
 * design tool.
 *
 * Storyboard — Newsmonger's story is *time passing and news arriving*, which is a
 * different shape from glassbox's review loop, so the beats are not a port:
 *
 *   0. topics being watched, feed empty
 *   1. the first check lands — summarized stories with source links
 *   2. topic discovery: sections and suggestions
 *   3. a later check reports **only what's new** — dedup is the product
 *   4. the same frame in dark mode, revealed by a left-to-right wipe
 *   5. an end card
 *
 * ### Two constraints learned from glassbox, not rediscovered here
 *
 * - **Must run outside the command sandbox** — Chromium needs Mach ports.
 * - Trees are captured live but **rendered to SVG after the browser and server are
 *   torn down**. domotion's macOS glyph-path extraction is flaky under contention
 *   and silently falls back to CSS `<text>`, which renders as tofu on a machine
 *   without the font. Rendering once everything else is gone makes it reliable,
 *   and the `@font-face` assertion at the end is what stops a silent regression.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Browser, Page } from '@playwright/test';
import {
  captureElementTree,
  clearEmbeddedFonts,
  elementTreeToSvgInner,
  generateAnimatedSvg,
  getEmbeddedFontFaceCss,
  gzipSvg,
  launchChromium,
  optimizeSvg,
  setRenderTextMode,
} from 'domotion-svg';

import { DEMO_TOPICS } from '../../src/demo.js';
import { CANVAS_H, CANVAS_W, chromeWrap, CONTENT_H, CONTENT_W, endCard } from './chrome.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_SVG = resolve(ROOT, 'assets/demo.svg');
const OUT_SVGZ = resolve(ROOT, 'assets/demo.svgz');
const DEBUG_DIR = resolve(ROOT, 'scripts/demo/.debug');

/** One captured beat, held until after teardown to be rendered. */
interface Beat {
  tree: Awaited<ReturnType<typeof captureElementTree>> | null;
  /** Pre-rendered full-canvas markup (the end card), if there's no tree. */
  fullSvg?: string;
  title: string;
  caption: string;
  durationMs: number;
  /**
   * How this beat hands over to the **next** one. Defaults to the crossfade
   * every other beat uses.
   *
   * Per-beat since NEWS-263, for one beat: the theme switch. A crossfade
   * between two frames of the same layout in different colours just looks like
   * a slow dim — the eye reads it as one picture changing brightness. A wipe
   * reads as what it is, the new theme sweeping across the window, precisely
   * because the geometry underneath does not move.
   */
  transition?: { type: 'crossfade' | 'wipe'; duration: number; easing?: string };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait for the feed to actually show `n` stories, rather than guessing at a delay. */
async function waitForStories(page: Page, atLeast: number): Promise<void> {
  await page.waitForFunction(
    (n: number) => document.querySelectorAll('.item').length >= n,
    atLeast,
    { timeout: 30_000 },
  );
}

async function main(): Promise<void> {
  rmSync(DEBUG_DIR, { recursive: true, force: true });
  mkdirSync(DEBUG_DIR, { recursive: true });
  mkdirSync(dirname(OUT_SVG), { recursive: true });

  // Never `~/.newsmonger` — the capture creates topics and runs checks, and this
  // is someone's real install.
  const dataDir = mkdtempSync(resolve(tmpdir(), 'newsmonger-demo-'));

  // No fixed port, and the URL is read from the server's **own readiness line**
  // rather than assumed.
  //
  // The first version hard-coded 4197 with `--strict-port`. A stray process was
  // already on it, our server died with EADDRINUSE — and the capture carried on
  // and photographed *whatever else was answering there*. Reading the URL the
  // spawned process prints means we can only ever talk to the process we started.
  // `READY_RE` tracks the marker in `src/cli.ts`, which `src-tauri/src/lib.rs`
  // also depends on.
  const server = spawn(
    resolve(ROOT, 'node_modules/.bin/tsx'),
    ['src/cli.ts', '--demo', '--no-open', '--data-dir', dataDir],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const READY_RE = /running at (\S+)/;
  let base = '';
  let serverExited = false;
  server.on('exit', () => {
    serverExited = true;
  });
  server.stdout.on('data', (d: Buffer) => {
    const text = d.toString();
    process.stdout.write(`[server] ${text}`);
    const m = READY_RE.exec(text);
    if (m?.[1] !== undefined && base === '') base = m[1];
  });
  server.stderr.on('data', (d: Buffer) => process.stderr.write(`[server] ${d.toString()}`));

  const beats: Beat[] = [];
  let browser: Browser | null = null;
  let shot = 0;

  try {
    // Wait for the readiness line, and **fail loudly** if it never comes.
    //
    // The first version gave up quietly after N tries and kept going, which is how
    // it ended up capturing a different server. A capture that cannot reach its own
    // app has nothing useful to do.
    /* eslint-disable @typescript-eslint/no-unnecessary-condition -- `base` and the exit flag are assigned by the `stdout` / `exit` handlers above. TypeScript narrows them to their initial literal values because its control-flow analysis cannot see a callback run, so it reads this wait as dead code. Annotating the declarations does not help: the *narrowed* type at this point is still the literal. Tried and reverted in NEWS-264. */
    for (let i = 0; i < 240 && base === '' && !serverExited; i++) await sleep(250);
    if (base === '') {
      throw new Error(
        serverExited
          ? 'The demo server exited before printing its readiness line (see [server] output above).'
          : 'Timed out waiting for the demo server readiness line.',
      );
    }
    console.log(`[capture] using ${base}`);

    browser = await launchChromium();
    const page = await browser.newPage({ viewport: { width: CONTENT_W, height: CONTENT_H } });

    const debugShot = async (name: string): Promise<void> => {
      await page.screenshot({
        path: resolve(DEBUG_DIR, `${String(shot++).padStart(2, '0')}-${name}.png`),
      });
    };

    const grab = async (title: string, caption: string, durationMs: number, name: string): Promise<void> => {
      await debugShot(name);
      const tree = await captureElementTree(page, undefined, {
        x: 0,
        y: 0,
        width: CONTENT_W,
        height: CONTENT_H,
      });
      beats.push({ tree, title, caption, durationMs });
    };

    // Onboarding would cover the first beat with a modal.
    await page.addInitScript(() => {
      localStorage.setItem('news:onboarding-seen', '1');
    });

    // Seed the topics through the real API, so the app reaches this state the way
    // a user would rather than by a fixture write behind its back.
    for (const t of DEMO_TOPICS) {
      await fetch(`${base}/api/topics`, {
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
    await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backupPromptNever: true }),
    });

    await page.goto(base, { waitUntil: 'networkidle' });

    // Adding a topic fires an immediate first check (FR-1.12), so by now stories
    // are arriving on their own — two per topic from the demo fixtures.
    await waitForStories(page, DEMO_TOPICS.length * 2);
    await sleep(600);

    await grab('Newsmonger', 'Follow topics, not feeds', 3200, 'feed');

    // Scroll the feed rather than `scrollIntoView` on the first card — that was a
    // no-op, because the card was already on screen, and the beat came out
    // byte-identical to the one before it. A frame that shows nothing new is worse
    // than no frame: it reads as the animation having stalled.
    await page.evaluate(() => {
      window.scrollTo({ top: window.innerHeight * 0.85, behavior: 'instant' as ScrollBehavior });
    });
    await sleep(600);
    await grab('Newsmonger', 'Summaries with links to the sources', 3200, 'stories');

    // Topic discovery.
    await page.click('[data-action=open-discover]');
    await page.waitForSelector('.dialog', { timeout: 10_000 });
    await sleep(900);
    await grab('Newsmonger', 'Find topics worth following', 3000, 'discover');
    await page.keyboard.press('Escape');
    await sleep(400);

    // A later check reports only what is new — this is the beat that shows the
    // product's actual claim, so it runs a real second check rather than faking it.
    const before = await page.locator('.item').count();
    await page.click('[data-action=check-all]');
    await page.waitForFunction(
      (n: number) => document.querySelectorAll('.item').length > n,
      before,
      { timeout: 30_000 },
    );
    await sleep(900);
    await grab('Newsmonger', 'Later checks report only what is new', 3400, 'dedup');

    // Dark mode (NEWS-263), captured at the **same scroll position and state** as
    // the beat before it. That is the whole trick: the wipe has to reveal the
    // identical layout in the other palette, so it reads as the theme changing
    // rather than as a jump to a different screen. Anything that moves between
    // the two frames turns a theme switch into a scene change.
    //
    // `emulateMedia` rather than a UI control because there is no theme toggle to
    // click — the app follows `prefers-color-scheme` (FR-3.7), so emulating the
    // media query *is* how a user gets here.
    beats[beats.length - 1].transition = { type: 'wipe', duration: 900, easing: 'ease-in-out' };
    await page.emulateMedia({ colorScheme: 'dark' });
    // Long enough for the CSS custom properties to settle and any transition on
    // them to finish, so the frame is fully dark rather than caught mid-change.
    await sleep(900);
    await grab('Newsmonger', 'Dark mode for the small hours', 3200, 'dark');

    beats.push({
      tree: null,
      fullSvg: endCard('Follow topics, not feeds.'),
      title: 'Newsmonger',
      caption: '',
      durationMs: 2400,
    });
  } finally {
    if (browser !== null) await browser.close().catch(() => undefined);
    server.kill('SIGTERM');
    setTimeout(() => server.kill('SIGKILL'), 2000).unref();
    rmSync(dataDir, { recursive: true, force: true });
  }

  // --- Render, now that nothing else is competing for the glyph helper ---
  clearEmbeddedFonts();
  setRenderTextMode('embedded-font');

  const frames = beats.map((b, i) => {
    const svgContent =
      b.fullSvg ??
      chromeWrap(elementTreeToSvgInner(b.tree ?? [], CONTENT_W, CONTENT_H), {
        title: b.title,
        id: `f${String(i)}`,
        caption: b.caption,
      });
    return {
      svgContent,
      duration: b.durationMs,
      transition: b.transition ?? { type: 'crossfade' as const, duration: 450 },
    };
  });

  let svg = generateAnimatedSvg({
    width: CANVAS_W,
    height: CANVAS_H,
    frames,
    fontFaceCss: getEmbeddedFontFaceCss(),
    title: 'Newsmonger — follow topics, not feeds',
    desc: 'An animated walkthrough: topics being watched, summarized stories with source links, topic discovery, a later check reporting only what is new, and the same view in dark mode.',
  });

  writeFileSync(resolve(DEBUG_DIR, '_raw.svg'), svg);
  try {
    svg = optimizeSvg(svg);
  } catch (e) {
    console.warn(`optimizeSvg failed (${(e as Error).message}); shipping unoptimized.`);
  }

  // Without an embedded font subset the captured text renders as tofu anywhere
  // the fonts aren't installed — which is most places a README is read. Assert
  // rather than trust: the fallback to CSS `<text>` is silent.
  if (!svg.includes('@font-face')) {
    throw new Error('No embedded @font-face in the output — captured text would render as tofu.');
  }

  const gz = gzipSvg(svg);
  writeFileSync(OUT_SVG, svg);
  writeFileSync(OUT_SVGZ, gz);

  console.log(`\n✓ ${OUT_SVG} (${(svg.length / 1024).toFixed(1)} KB, ${String(frames.length)} frames)`);
  console.log(`✓ ${OUT_SVGZ} (${(gz.length / 1024).toFixed(1)} KB gzipped)`);
  console.log(`  debug screenshots in ${DEBUG_DIR}`);
}

await main();
