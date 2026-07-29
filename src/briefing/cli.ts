import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { outletFor } from '../client/attribution.js';
import { defaultDataDir } from '../config.js';
import { Store } from '../db/store.js';
import { ExportScopeSchema, selectForExport } from '../export.js';
import { domotionMessage, domotionStatus } from './domotion.js';
import { buildScenes } from './reel.js';
import { renderReel, stageAssets, stagePhoto } from './stage.js';

/**
 * `npm run briefing` — render a briefing reel from the local database (NEWS-167).
 *
 * Deliberately **not** a product surface. It exists so the card design can be
 * iterated against real stories with no UI in the way, and because everything
 * it works out — the story→scene mapping, staging, the storyboard config — is
 * what `GET /api/briefing.svg` (NEWS-170) will call.
 *
 * Reads the database directly and does not start a server, so it cannot
 * disturb a running app.
 */

const REEL = { width: 1080, height: 1920, background: '#0f1513' };

function parseArgs(argv: readonly string[]): {
  scope: string;
  topicId: string;
  limit: number;
  output: string;
  dataDir: string | undefined;
  keep: boolean;
} {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    scope: get('--scope') ?? 'all',
    topicId: get('--topic') ?? '',
    limit: Number(get('--limit') ?? '6'),
    output: path.resolve(get('-o') ?? get('--output') ?? 'briefing.svg'),
    dataDir: get('--data-dir'),
    keep: argv.includes('--keep'),
  };
}

/** "29 Jul" — the compact form the attribution rail uses. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "Wednesday, 29 July" — the title card's fuller form. */
function longDate(now: Date): string {
  return now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const args = parseArgs(argv);

  const scope = ExportScopeSchema.safeParse(args.scope);
  if (!scope.success) {
    process.stderr.write(`briefing: --scope must be all, saved or topic (got "${args.scope}")\n`);
    return 2;
  }

  // Resolve the renderer before touching the database: if there is no usable
  // domotion, nothing else this command does is worth doing, and the user
  // needs the actionable message rather than a later failure.
  const probe = domotionStatus();
  if (probe.status !== 'ok') {
    process.stderr.write(`${domotionMessage(probe)}\n`);
    return 1;
  }
  process.stderr.write(`${domotionMessage(probe)}\n`);

  const dataDir = args.dataDir ?? defaultDataDir();
  const store = new Store(dataDir);
  try {
    const items = selectForExport({
      items: store.listItems(),
      scope: scope.data,
      topicId: args.topicId,
      limit: args.limit,
    });
    if (items.length === 0) {
      process.stderr.write('briefing: no stories match that selection — nothing to render.\n');
      return 1;
    }
    const topics = store.listTopics();

    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-briefing-'));
    try {
      const { wordmarkFile } = stageAssets(stageDir);
      const photos = new Map(
        items.map((item, index) => [item.id, stagePhoto({ item, dataDir, stageDir, index })] as const),
      );

      const scenes = buildScenes({
        items,
        topics,
        // A story is required to cite a source but the schema does not enforce
        // it, so an empty list has to name something rather than render blank.
        outletFor: (item) => {
          const first = item.sources.at(0);
          return first === undefined ? 'Unknown source' : outletFor(first);
        },
        dateLabelFor: shortDate,
        photoFor: (item) => photos.get(item.id) ?? null,
        headerDateLabel: longDate(new Date()),
        wordmarkFile,
      });

      const withPhoto = [...photos.values()].filter((p) => p !== null).length;
      process.stderr.write(
        `briefing: ${String(items.length)} stories (${String(withPhoto)} with a photo), ` +
          `${String(scenes.length)} scenes\n`,
      );

      const result = renderReel({
        binPath: probe.binPath,
        scenes,
        stageDir,
        outputPath: args.output,
        ...REEL,
      });

      process.stderr.write(
        `briefing: wrote ${result.outputPath} — ${(result.bytes / 1024).toFixed(0)} KB, ` +
          `${(result.durationMs / 1000).toFixed(1)}s\n`,
      );
      // The reel's own play length, so a later `svg-to-video --duration` never
      // has to fall back to the LCM default (FR-27.13).
      process.stderr.write(`briefing: pass --duration ${(result.durationMs / 1000).toFixed(2)} to svg-to-video\n`);
      return 0;
    } finally {
      if (args.keep) process.stderr.write(`briefing: staging kept at ${stageDir}\n`);
      else fs.rmSync(stageDir, { recursive: true, force: true });
    }
  } finally {
    store.close();
  }
}
