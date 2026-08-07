/**
 * Capture real news, once, as the fixture `--demo` renders (NEWS-376).
 *
 *   npm run record:demo-data
 *
 * **Why this exists.** The demo used invented prose with `example.org` links, so
 * every captured screenshot had no article images and no favicons: the real
 * pipeline ran, tried to fetch from a domain that serves neither, and correctly
 * returned nothing. A reader of the README saw a news app that cannot show a
 * picture. Recording real coverage fixes the cause rather than drawing the
 * missing pictures in by hand.
 *
 * **The capture is frozen, and that is the point.** Screenshots have to be
 * reproducible: `npm run demo:stills` must render the same thing next month, on a
 * machine with no subscription and no network. So this script runs the real
 * provider and the real image pipeline *once*, then writes everything it learned
 * — the stories, the article-URL-to-image mapping, the origin-to-favicon mapping,
 * and the image bytes themselves — into `assets/demo-data/`. `--demo` replays it
 * with no network at all, the same bargain `tests/fixtures/cli-sessions/` strikes.
 *
 * Re-run it when the demo topics change or the pictures go stale. Read the
 * fixture diff as what the news actually did.
 *
 * Runs outside the sandbox: it spawns the real CLI and reaches the network.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEMO_TOPICS } from '../src/demo.js';
import { npmSpawn } from './npm-command.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets/demo-data');
const PORT = 4931;
const CHECK_TIMEOUT_MS = 11 * 60 * 1000;

/**
 * How many of a topic's stories become the *second* check's haul.
 *
 * The demo needs a "re-checking found something new" beat — it is the product's
 * whole claim — and a second real check minutes after the first correctly returns
 * nothing, because nothing has happened yet. So one real capture is dealt across
 * two checks: the newest few are held back as what the second check finds.
 *
 * The staging is the fiction; every headline, link, outlet and picture is real.
 * That is the line this script draws, and the line the old fixture crossed.
 */
const HELD_BACK = 2;

interface CapturedSource {
  title: string;
  url: string;
  favicon: { hash: string; sourceUrl: string } | null;
}

interface CapturedStory {
  title: string;
  summary: string;
  publishedAt: string | null;
  sources: CapturedSource[];
  image: { hash: string; sourceUrl: string } | null;
}

interface StateItem {
  topicId: string;
  title: string;
  summary: string;
  publishedAt: string | null;
  sources: CapturedSource[];
  image: { hash: string; sourceUrl: string } | null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api<T>(base: string, pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${pathname}`, init);
  if (!res.ok) throw new Error(`${pathname} → ${String(res.status)} ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Downscale a captured image to what the card actually renders.
 *
 * A publisher's lead image is routinely 2000px and a couple of megabytes; the
 * feed draws it into a card about 430px wide at 16/9. Committing the original
 * would put several megabytes of pixels nobody sees into the repository forever
 * — one capture arrived at 5.3 MB, of which a single image was 2.1 MB.
 *
 * `MAX_WIDTH` is 2x the widest a card gets, so a retina still is still sharp.
 *
 * The cache is keyed by a hash of the image **URL**, not of the bytes, so
 * re-encoding here cannot invalidate anything, and the image route sniffs the
 * type from magic bytes rather than trusting an extension.
 *
 * `sips` is macOS-only and this is a record-once script that already needs a
 * signed-in CLI, so its absence is a silent no-op rather than a failure — a
 * bigger fixture is a worse outcome, not a broken one.
 */
const MAX_WIDTH = 900;

function shrink(file: string): void {
  const before = fs.statSync(file).size;
  if (before < 64 * 1024) return; // favicons and small art: leave them alone
  try {
    execFileSync('sips', ['--resampleWidth', String(MAX_WIDTH), file, '--out', file], { stdio: 'ignore' });
  } catch {
    // No `sips`, or an image it will not decode. Keep the original.
  }
}

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-demo-'));
  const base = `http://127.0.0.1:${String(PORT)}`;

  // The packaged CLI, not `tsx`: same artifact the app ships, and it starts far
  // faster (CLAUDE.md, NEWS-295).
  // `npmSpawn()`, never a bare `npm`: on Windows that is `npm.cmd`, a shell shim
  // Node has refused to spawn without a shell since CVE-2024-27980 (NEWS-348).
  // Pinned tree-wide by `windows-portability.test.ts`, which caught this file.
  const npm = npmSpawn();
  execFileSync(npm.command, ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: npm.shell });
  // `--no-open`, or the server launches a browser window at the user's desktop
  // every time this runs — the recorder drives it over HTTP and never needs one.
  const server = spawn(
    process.execPath,
    ['dist/cli.js', '--data-dir', dataDir, '--port', String(PORT), '--no-open', '--strict-port'],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.on('data', (d: Buffer) => process.stdout.write(`[server] ${d.toString()}`));
  server.stderr.on('data', (d: Buffer) => process.stderr.write(`[server] ${d.toString()}`));

  try {
    // Wait for the readiness the Tauri shell watches for.
    for (let i = 0; i < 60; i++) {
      try {
        await api(base, '/api/state');
        break;
      } catch {
        await wait(500);
      }
    }

    await api(base, '/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'claude-cli', effort: '' }),
    });

    const created: { id: string; name: string }[] = [];
    for (const topic of DEMO_TOPICS) {
      const row = await api<{ id: string; name: string }>(base, '/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          topic.captureGuidance === undefined
            ? { name: topic.name }
            : { name: topic.name, guidance: topic.captureGuidance },
        ),
      });
      created.push(row);
      process.stdout.write(`[record] created "${topic.name}"\n`);
    }

    // Every topic fires its own check on create (FR-1.12), so this waits for all
    // four at once rather than serialising them.
    const deadline = Date.now() + CHECK_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) throw new Error('checks did not finish in time');
      await wait(5000);
      const state = await api<{ checking: string[]; runs: { status: string }[] }>(base, '/api/state');
      if (state.checking.length === 0 && state.runs.length >= created.length) break;
      process.stdout.write(`[record] ${String(state.checking.length)} still checking…\n`);
    }

    const { items } = await api<{ items: StateItem[] }>(base, '/api/items?limit=200');
    process.stdout.write(`[record] ${String(items.length)} stories\n`);

    const byTopic = new Map<string, CapturedStory[]>();
    for (const item of items) {
      const topic = created.find((t) => t.id === item.topicId);
      if (topic === undefined) continue;
      const list = byTopic.get(topic.name) ?? [];
      list.push({
        title: item.title,
        summary: item.summary,
        publishedAt: item.publishedAt,
        sources: item.sources,
        image: item.image,
      });
      byTopic.set(topic.name, list);
    }

    // The two mappings `--demo` replays instead of reaching the network. Keyed by
    // what the real fetchers are *asked* — an article URL and an origin — so the
    // demo fetchers are drop-in replacements rather than a different shape.
    const imagesByArticle: Record<string, { hash: string; sourceUrl: string }> = {};
    const faviconsByOrigin: Record<string, { hash: string; sourceUrl: string }> = {};
    for (const stories of byTopic.values()) {
      for (const story of stories) {
        // `.at(0)` rather than `[0]`: without `noUncheckedIndexedAccess` the
        // index is typed as definitely present, so the guard reads as dead code.
        const first = story.sources.at(0);
        if (story.image !== null && first !== undefined) imagesByArticle[first.url] = story.image;
        for (const source of story.sources) {
          if (source.favicon === null) continue;
          try {
            faviconsByOrigin[new URL(source.url).origin] = source.favicon;
          } catch {
            // A source URL that will not parse cannot be keyed by origin; the
            // demo falls back to the arrow glyph, exactly as the app does.
          }
        }
      }
    }

    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(OUT_DIR, 'images'), { recursive: true });

    let bytes = 0;
    for (const { hash } of [...Object.values(imagesByArticle), ...Object.values(faviconsByOrigin)]) {
      const from = path.join(dataDir, 'images', `${hash}.bin`);
      if (!fs.existsSync(from)) continue;
      const to = path.join(OUT_DIR, 'images', `${hash}.bin`);
      fs.copyFileSync(from, to);
      shrink(to);
      bytes += fs.statSync(to).size;
    }

    const topics = DEMO_TOPICS.map((topic) => {
      const stories = byTopic.get(topic.name) ?? [];
      const held = stories.length > HELD_BACK ? HELD_BACK : 0;
      return {
        name: topic.name,
        first: stories.slice(held),
        second: stories.slice(0, held),
      };
    });

    fs.writeFileSync(
      path.join(OUT_DIR, 'stories.json'),
      `${JSON.stringify({ capturedAt: new Date().toISOString(), topics, imagesByArticle, faviconsByOrigin }, null, 2)}\n`,
    );

    const withImage = Object.keys(imagesByArticle).length;
    process.stdout.write(
      `\n✓ ${String(topics.length)} topics, ${String(withImage)} lead images, ` +
        `${String(Object.keys(faviconsByOrigin).length)} favicons, ${String(Math.round(bytes / 1024))} KB\n` +
        `  ${path.relative(ROOT, OUT_DIR)}\n`,
    );
    if (withImage === 0) {
      throw new Error('no lead images were captured — the fixture would reproduce the bug it exists to fix');
    }
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
