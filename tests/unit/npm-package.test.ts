import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PROVIDER_NAMES } from '../../src/ai/types.js';

/**
 * The published npm package is coherent (NEWS-204).
 *
 * Both bugs here were found by actually packing the tarball, installing it to a
 * temp prefix and running the binary — which nothing in the suite did, because
 * every other test imports source directly. The package is a separate artifact
 * from the code, in the same way the Tauri bundle is (NEWS-203), and it has the
 * same property: it can be broken while everything else is green.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

const pkg = (): { files: string[]; bin: Record<string, string>; scripts: Record<string, string> } =>
  z
    .object({
      files: z.array(z.string()),
      bin: z.record(z.string(), z.string()),
      scripts: z.record(z.string(), z.string()),
    })
    .parse(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')));

describe('the npm package would ship something usable (NEWS-204)', () => {
  it('builds before publishing', () => {
    // `files` is dist-only, so publishing without a build ships a package with
    // **no code at all** — LICENSE, README and package.json, 3.7 kB — rather than
    // one that is obviously broken. And `bin` would point at a dist/cli.js that
    // does not exist, so `npm i -g newsmonger` installs a broken binary. A first
    // publish cannot be undone or the version reused.
    expect(pkg().scripts['prepublishOnly'] ?? '').toContain('npm run build');
  });

  it('builds the client too, since the CLI serves it', () => {
    // `dist/cli.js` alone would start a server that 404s every asset.
    expect(pkg().scripts['prepublishOnly'] ?? '').toContain('build:client');
  });

  it('excludes sourcemaps at every depth', () => {
    // The bug: `!dist/*.map` matches one level only, so
    // `dist/client/app.global.js.map` shipped — 1.8 MB, 62% of the unpacked
    // package, and the client source with it.
    const { files } = pkg();
    const negations = files.filter((f) => f.startsWith('!'));
    expect(negations.length, 'no sourcemap exclusion at all').toBeGreaterThan(0);
    expect(
      negations.some((f) => f.includes('**')),
      `sourcemap exclusion must be recursive, got ${negations.join(', ')}`,
    ).toBe(true);
  });

  it('points bin at a path inside the published files', () => {
    const { bin, files } = pkg();
    for (const target of Object.values(bin)) {
      const rel = target.replace(/^\.\//, '');
      expect(
        files.some((f) => !f.startsWith('!') && rel.startsWith(f.replace(/\/$/, ''))),
        `${target} is not covered by files: ${files.join(', ')}`,
      ).toBe(true);
    }
  });
});

describe('the CLI usage line stays true (NEWS-204)', () => {
  const usage = (): string => fs.readFileSync(path.join(root, 'src/cli.ts'), 'utf8');

  it('names the binary, not the old product name', () => {
    // It said `usage: news` — a NEWS-164 rename artifact, and the third one found
    // (after `~/.newsmongermonger` in the docs and in the Settings panel).
    expect(usage()).toContain('usage: newsmonger');
    expect(usage()).not.toMatch(/usage: news\b(?!monger)/);
  });

  it('derives the provider list rather than hardcoding it', () => {
    // Hardcoded, it drifted twice over: it advertised `ollama`, which is not a
    // provider, and omitted `claude-cli` and `codex-cli`, which are. The one place
    // a user looks when they have got `--provider` wrong was itself wrong.
    expect(usage()).toContain('PROVIDER_NAMES.join');
    for (const name of PROVIDER_NAMES) {
      expect(usage(), `${name} should not be spelled out`).not.toContain(`|${name}|`);
    }
  });

  it('prints every real provider when it rejects a bad flag', () => {
    // Through the actual binary, since that is where the string is assembled.
    let out = '';
    try {
      execFileSync('npx', ['tsx', path.join(root, 'src/cli.ts'), '--bogus'], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(out).toContain('usage: newsmonger');
    for (const name of PROVIDER_NAMES) {
      expect(out, `usage line omits ${name}`).toContain(name);
    }
    expect(out, 'ollama is not a provider').not.toContain('ollama');
  });
});
