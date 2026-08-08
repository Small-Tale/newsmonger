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
import type { IntraFrameAnimation } from 'domotion-svg';
import {
  captureElementTree,
  clearEmbeddedFonts,
  elementTreeToSvgInner,
  embedRemoteImages,
  generateAnimatedSvg,
  getEmbeddedFontFaceCss,
  gzipSvg,
  launchChromium,
  optimizeSvg,
  resizeEmbeddedImages,
  setRenderTextMode,
} from 'domotion-svg';

import { DEMO_FIRST_CHECK_STORIES, DEMO_TOPICS } from '../../src/demo.js';
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
   * Per-beat since NEWS-263, for two beats now.
   *
   * **The theme switch** uses a wipe. A crossfade between two frames of the same
   * layout in different colours just looks like a slow dim — the eye reads it as
   * one picture changing brightness. A wipe reads as what it is, the new theme
   * sweeping across the window, precisely because the geometry underneath does
   * not move.
   *
   * **The feed → stories handover is a `cut`** (NEWS-428). It was a crossfade
   * between two captures at different scroll positions, which dissolved one copy
   * of the text through the other — both legible at once, a few hundred pixels
   * apart, reading as a rendering fault. NEWS-425 made it a `scroll` transition,
   * which was still wrong: that slides two whole captured frames past each
   * other, chrome and sidebar included, so it is a slideshow push rather than a
   * page scrolling.
   *
   * The scroll now happens *inside* the second beat, as an intra-frame
   * animation (see `animations` below), so both beats are captured at the same
   * scroll position and there is nothing to dissolve between them.
   */
  transition?: { type: 'crossfade' | 'wipe' | 'cut'; duration: number; easing?: string };
  /**
   * Animations that run **while this frame is held**, on elements marked with
   * `data-domotion-anim` in the DOM before capture (NEWS-428).
   *
   * This is how the feed actually scrolls. A frame *transition* — `scroll`,
   * `push-up` — slides two whole captured frames past each other, chrome and
   * sidebar included, which is a slideshow push and not a page scrolling. An
   * intra-frame `translateY` on `#feed` moves the story column alone, while the
   * sticky topics rail and the window chrome stay exactly where they are, which
   * is what a reader scrolling this app actually sees.
   */
  animations?: IntraFrameAnimation[];
}

/**
 * How far the feed travels in the scrolling beat, and the id tying the marked
 * DOM element to the animation that moves it (NEWS-428).
 *
 * 680px is 85% of the 800px capture height — the distance the old two-capture
 * version jumped, kept so the same source links end up on screen.
 */
const FEED_SCROLL_ID = 'feed-scroll';
const RAIL_STICK_ID = 'rail-stick';
const FEED_SCROLL_PX = 680;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait for the feed to actually show `n` stories, rather than guessing at a delay. */
async function waitForStories(page: Page, atLeast: number): Promise<void> {
  await page.waitForFunction(
    (n: number) => document.querySelectorAll('.item').length >= n,
    atLeast,
    { timeout: 30_000 },
  );
}

/**
 * A port the OS says is free, and that `fetch` will actually talk to
 * (NEWS-285).
 *
 * The demo servers used to take whatever `--port` fell forward to from 4187,
 * and the stills run — which holds two servers at once — landed its second on
 * **4190**, `sieve` on the WHATWG Fetch blocked-port list. Every `fetch` to it
 * failed with `bad port`: a healthy server no `fetch` may address, reported as a
 * network error that never mentions the port.
 *
 * This script only runs one server, so it was never bitten. It shares the fix
 * anyway — the two scripts differing on how they choose a port is how one of
 * them silently regresses.
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

async function main(): Promise<void> {
  rmSync(DEBUG_DIR, { recursive: true, force: true });
  mkdirSync(DEBUG_DIR, { recursive: true });
  mkdirSync(dirname(OUT_SVG), { recursive: true });

  // Never `~/.newsmonger` — the capture creates topics and runs checks, and this
  // is someone's real install.
  const dataDir = mkdtempSync(resolve(tmpdir(), 'newsmonger-demo-'));
  const port = await freePort();

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
  let serverExited = false;
  server.on('exit', () => {
    serverExited = true;
  });
  server.stdout.on('data', (d: Buffer) => {
    const text = d.toString();
    process.stdout.write(`[server] ${text}`);
    out += text;
    const m = READY_RE.exec(out);
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

    const grab = async (
      title: string,
      caption: string,
      durationMs: number,
      name: string,
      animations?: IntraFrameAnimation[],
    ): Promise<void> => {
      await debugShot(name);
      const tree = await captureElementTree(page, undefined, {
        x: 0,
        y: 0,
        width: CONTENT_W,
        height: CONTENT_H,
      });
      // Inline the images while the server is still up (NEWS-376). domotion
      // serialises `<img src>` as `<image href>` carrying the page's absolute
      // URL — `http://127.0.0.1:<ephemeral port>/…` — which resolves to nothing
      // the moment this run ends, so every picture in a committed hero would be
      // a blank box. The tree holds URLs, not bytes; this is the pass that turns
      // one into the other, and after teardown there is nothing left to fetch.
      await embedRemoteImages(tree);
      // `hiDPIFactor: 2`, and that is the *smallest* output, which is not the
      // obvious answer. Measured across three captures of this file: factor 2
      // gives 2.8 MB, factor 1 gives 3.1 MB, and factor 1 is byte-identical to
      // running no resize at all — so at 1 the pass simply does not act, while
      // at 2 it re-encodes and wins. The recorder already caps sources at 900px
      // (2x a ~430px card), so there is little headroom left for it to reclaim.
      // Do not "optimise" this down without re-measuring; the intuition is
      // backwards here.
      await resizeEmbeddedImages(tree, { hiDPIFactor: 2 });
      beats.push({ tree, title, caption, durationMs, animations });
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
    await waitForStories(page, DEMO_FIRST_CHECK_STORIES);
    await sleep(600);

    await grab('Newsmonger', 'Follow topics, not feeds', 3200, 'feed');
    // Cut, not crossfade (NEWS-428). The next beat is captured at the *same*
    // scroll position — the movement happens inside it — so a crossfade would
    // dissolve a frame into its own twin and read as a stall.
    beats[beats.length - 1].transition = { type: 'cut', duration: 0 };

    // **The feed scrolls for real here** (NEWS-428), rather than this being a
    // second static capture that the previous frame slides away to reveal.
    //
    // Marking `#feed` and animating its `translateY` moves the story column
    // alone: the topics rail is `position: sticky` and the window chrome is
    // drawn by us, so both stay put while the stories travel underneath — which
    // is what someone scrolling this app actually sees. A frame transition
    // cannot express that, because it moves whole captured frames.
    //
    // Captured at scroll top, because the animation is what does the scrolling.
    // The tree has to carry the content that comes into view, which is why the
    // capture rect stays the full window and the reveal is a transform rather
    // than a second grab.
    // **The header travels with the feed, and that is not optional.** Marking
    // `#feed` alone left the app header where it was, so the rising stories
    // painted straight over "Search stories" and "Check all now" — the feed
    // covering the chrome rather than scrolling under it.
    //
    // A real window scroll in this app moves everything except the topics rail,
    // which is the only `position: sticky` region in the shell. So the marked
    // set is *the grid's non-sticky areas* — header, filters, banners, feed —
    // and `.topics-panel` is deliberately left out. Deriving it from the grid
    // rather than naming the feed alone is what keeps it honest: `#filter-slot`
    // has no `position` either, and leaving it behind stranded the section pills
    // in mid-air while the masthead above them slid away.
    //
    // Passed in, not closed over: this callback is serialised and runs in the
    // browser, where a Node-side constant does not exist.
    //
    // The rail is marked too, with its **own** id, because `sticky` is motion —
    // it rises with the page until it reaches its `top` offset and only then
    // parks. Left unmarked it sat at its resting position while everything above
    // it slid away, opening a blank band where the masthead had been. The travel
    // is measured rather than guessed: its distance to its own sticky `top`,
    // capped by how far the page actually scrolls.
    const railTravel = await page.evaluate(
      ([feedId, railId]: string[]) => {
        for (const sel of ['.app-header', '#filter-slot', '#banners', '#feed']) {
          document.querySelector(sel)?.setAttribute('data-domotion-anim', feedId);
        }
        const rail = document.querySelector('#topics-panel');
        if (rail === null) return 0;
        rail.setAttribute('data-domotion-anim', railId);
        const stickyTop = Number.parseFloat(getComputedStyle(rail).top) || 0;
        return Math.max(0, rail.getBoundingClientRect().top - stickyTop);
      },
      [FEED_SCROLL_ID, RAIL_STICK_ID],
    );
    await sleep(300);
    await grab('Newsmonger', 'Summaries with links to the sources', 3600, 'stories', [
      {
        animId: FEED_SCROLL_ID,
        property: 'translateY',
        from: '0px',
        to: `-${String(FEED_SCROLL_PX)}px`,
        duration: 2000,
        // Held still for a beat first, so the reader reads a headline before the
        // page moves under them; the motion is the point, not the destination.
        delay: 700,
        easing: 'ease-in-out',
      },
      {
        animId: RAIL_STICK_ID,
        property: 'translateY',
        from: '0px',
        to: `-${String(Math.min(railTravel, FEED_SCROLL_PX))}px`,
        // Proportionally shorter than the feed's, so the rail arrives at its
        // sticky offset partway through and stays there — which is what sticky
        // does — rather than drifting for the whole scroll.
        duration: Math.round(2000 * Math.min(1, railTravel / FEED_SCROLL_PX)),
        delay: 700,
        easing: 'ease-in',
      },
    ]);

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
      ...(b.animations === undefined ? {} : { animations: b.animations }),
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
