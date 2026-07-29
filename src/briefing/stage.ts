import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NewsItem } from '../db/schemas.js';
import { cachedImagePath, sniffImageType } from '../images/index.js';
import { type CardPhoto, type Scene, storyboardConfig, totalDurationMs } from './reel.js';

/**
 * Putting a reel on disk and handing it to domotion (NEWS-167).
 *
 * The filesystem and subprocess half of the generator; the markup rules live
 * in `reel.ts` so they stay testable without any of this.
 */

/** Where the checked-in card design lives, whether running from source or from dist. */
export function cardsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const dir of [path.join(here, 'cards'), path.join(here, '../../src/briefing/cards')]) {
    if (fs.existsSync(path.join(dir, 'cards.css'))) return dir;
  }
  throw new Error('cannot locate src/briefing/cards — the card stylesheet is missing');
}

/** Repo root, for reaching `assets/`. */
function assetsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const dir of [path.join(here, '../../assets'), path.join(here, '../../../assets')]) {
    if (fs.existsSync(path.join(dir, 'wordmark-dark.svg'))) return dir;
  }
  throw new Error('cannot locate assets/wordmark-dark.svg');
}

/** File extension for a cached image, from its magic bytes rather than its name. */
function extensionFor(bytes: Buffer): string | null {
  // The cache stores every image as `<hash>.bin`, so the browser would have no
  // idea what it is loading from a file:// URL. The type is sniffed from
  // content — the same thing `GET /api/image/:hash` does when serving it —
  // rather than trusted from the origin's header.
  const type = sniffImageType(bytes);
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/svg+xml': '.svg',
  };
  return map[type] ?? null;
}

/**
 * Copy a story's cached image into the staging directory.
 *
 * Returns null — meaning "render the no-photo card" — for every failure: no
 * image recorded, the cache file missing, or a format the browser would not
 * paint. FR-27.10 makes that a designed card rather than a degraded one, so a
 * missing picture costs the reel nothing and must never cost it a story.
 *
 * **A local copy, deliberately.** Pointing the page at the publisher's URL
 * would be less code and would silently put Chromium on the open internet
 * (FR-27.8).
 */
export function stagePhoto(opts: { item: NewsItem; dataDir: string; stageDir: string; index: number }): CardPhoto {
  const { item, dataDir, stageDir, index } = opts;
  if (item.image === null) return null;
  const source = cachedImagePath(dataDir, item.image.hash);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(source);
  } catch {
    return null;
  }
  const ext = extensionFor(bytes);
  if (ext === null) return null;
  const file = `photo-${String(index).padStart(2, '0')}${ext}`;
  fs.writeFileSync(path.join(stageDir, file), bytes);
  return { file };
}

/** Copy the design and the wordmark in beside the scenes. */
export function stageAssets(stageDir: string): { wordmarkFile: string } {
  fs.copyFileSync(path.join(cardsDir(), 'cards.css'), path.join(stageDir, 'cards.css'));
  const wordmark = 'wordmark-dark.svg';
  fs.copyFileSync(path.join(assetsDir(), wordmark), path.join(stageDir, wordmark));
  return { wordmarkFile: wordmark };
}

export interface RenderResult {
  outputPath: string;
  durationMs: number;
  bytes: number;
}

/**
 * Write the scenes and run `domotion storyboard`.
 *
 * The binary is resolved by the caller (NEWS-178) rather than looked up here,
 * so that the "which domotion, and is it new enough" question has exactly one
 * answer in the process.
 */
export function renderReel(opts: {
  binPath: string;
  scenes: readonly Scene[];
  stageDir: string;
  outputPath: string;
  width: number;
  height: number;
  background: string;
  /** Where to send domotion's own progress output. */
  stdio?: 'inherit' | 'ignore';
}): RenderResult {
  for (const scene of opts.scenes) {
    fs.writeFileSync(path.join(opts.stageDir, scene.file), scene.html);
  }

  const config = storyboardConfig({
    scenes: opts.scenes,
    width: opts.width,
    height: opts.height,
    output: opts.outputPath,
    background: opts.background,
  });
  const configPath = path.join(opts.stageDir, 'storyboard.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // `spawnSync` rather than `execFileSync` because the loop length we need is
  // on **stderr** — where domotion writes all its progress — and `execFileSync`
  // only hands back stdout. Both streams are captured and then replayed, so
  // nothing is lost from the console.
  const run = spawnSync(opts.binPath, ['storyboard', configPath, '-o', opts.outputPath], {
    encoding: 'utf8',
    // Scene `capture.file` paths are relative to the config, and the config
    // sits in the staging dir — so this is also what keeps every reference in
    // the reel local by construction.
    cwd: opts.stageDir,
  });
  const output = `${run.stdout}${run.stderr}`;
  if (opts.stdio !== 'ignore') process.stderr.write(output);
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) {
    throw new Error(`domotion storyboard exited ${String(run.status)}: ${run.stderr.trim().slice(-400)}`);
  }

  return {
    outputPath: opts.outputPath,
    durationMs: reportedLoopMs(output) ?? totalDurationMs(opts.scenes),
    bytes: fs.statSync(opts.outputPath).size,
  };
}

/**
 * The reel's play length, read from what domotion says rather than recomputed.
 *
 * Summing the scene durations is **wrong**: transitions add time on top, so a
 * six-scene reel whose scenes total 34.0 s actually plays for 36.4 s. That
 * 2.4 s gap matters because this number is what a caller passes to
 * `svg-to-video --duration` (FR-27.13) — too small and the export is silently
 * truncated mid-reel.
 *
 * Rather than replicate domotion's timing arithmetic and re-derive it every
 * time transitions change, ask the tool: it prints `… 36.4s loop` when it
 * writes the storyboard. The sum remains as a fallback for a future release
 * that phrases it differently, since a slightly short duration is better than
 * no reel at all — but the parsed value is the one to trust.
 */
export function reportedLoopMs(cliOutput: string): number | null {
  const found = /([\d.]+)s loop/.exec(cliOutput);
  if (found === null) return null;
  const seconds = Number(found[1]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}
