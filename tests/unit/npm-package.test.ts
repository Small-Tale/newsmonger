import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

/**
 * Every test that spawns the CLI needs far more than vitest's 5 s default.
 *
 * Each `run()` is an `npx tsx` cold start — resolving the package, then
 * compiling the whole server entry — and one test does three of them. Alone
 * that is comfortably under the default; inside the full suite, competing with
 * every other file for CPU, it is not, and the test failed on load rather than
 * on behaviour. The number is deliberately generous: it exists to stop a false
 * red, not to assert anything about speed.
 */
const SPAWN_TIMEOUT_MS = 60_000;

describe('the CLI usage line stays true (NEWS-204)', () => {
  // The usage line and the help text live in `src/config.ts` since NEWS-216, so
  // `--help` can answer before the args are parsed at all.
  const usage = (): string => fs.readFileSync(path.join(root, 'src/config.ts'), 'utf8');

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

  it('prints every real provider when it rejects a bad flag', { timeout: SPAWN_TIMEOUT_MS }, () => {
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

describe('the installed binary answers the first two things anyone types (NEWS-216)', () => {
  /** Runs the CLI the way a shell does, and returns stdout, stderr and the code. */
  const run = (...args: string[]): { stdout: string; stderr: string; code: number } => {
    try {
      const stdout = execFileSync('npx', ['tsx', path.join(root, 'src/cli.ts'), ...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { stdout, stderr: '', code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 };
    }
  };

  it('prints help on stdout and exits 0', { timeout: SPAWN_TIMEOUT_MS }, () => {
    // It used to exit 1 with "unknown argument: --help" — after `npm install -g
    // newsmonger`, that is very likely the first command someone runs, and the
    // answer was that asking for help was an error. stdout so `--help | less`
    // works; exit 0 so a script asking "is this thing installed" gets a yes.
    const { stdout, code } = run('--help');
    expect(code).toBe(0);
    expect(stdout).toContain('usage: newsmonger');
    expect(stdout).toContain('--data-dir');
    for (const name of PROVIDER_NAMES) expect(stdout, `help omits ${name}`).toContain(name);
  });

  it('prints the package version on --version, and the same for -h/-v', { timeout: SPAWN_TIMEOUT_MS }, () => {
    const version = z
      .object({ version: z.string() })
      .parse(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))).version;
    const long = run('--version');
    expect(long.code).toBe(0);
    expect(long.stdout.trim()).toBe(version);
    expect(run('-v').stdout.trim()).toBe(version);
    expect(run('-h').stdout).toContain('usage: newsmonger');
  });

  it('starts no server and writes no data directory when it is only answering', { timeout: SPAWN_TIMEOUT_MS }, () => {
    // Both paths return before the Store is constructed. Pointing --data-dir at a
    // directory that does not exist proves it: creating it would be the giveaway.
    const dir = path.join(os.tmpdir(), `newsmonger-help-${String(process.pid)}`);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(run('--data-dir', dir, '--version').code).toBe(0);
    expect(fs.existsSync(dir), 'answering --version should not create a data dir').toBe(false);
  });

  it('still rejects a bad flag with the usage line on stderr and a non-zero exit', { timeout: SPAWN_TIMEOUT_MS }, () => {
    // The other half of FR-4.2 — help being free must not make errors free too.
    const { stderr, code } = run('--bogus');
    expect(code).not.toBe(0);
    expect(stderr).toContain('unknown argument: --bogus');
    expect(stderr).toContain('usage: newsmonger');
  });
});

describe('the README documents the install path, not just the source path (NEWS-216)', () => {
  const readme = (): string => fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const quickStart = (): string => {
    const s = readme();
    const start = s.indexOf('## Quick start');
    expect(start, 'README should have a Quick start section').toBeGreaterThan(-1);
    return s.slice(start, s.indexOf('\n## ', start + 5));
  };

  it('leads with the global install and the bare command', () => {
    // It used to open with `npm install && npm run dev`, which is how you work
    // *on* Newsmonger, not how you use it — a reader following it needed a clone
    // they hadn't been told to make. The published package is the product.
    const qs = quickStart();
    expect(qs).toContain('npm install -g newsmonger');
    expect(qs).toMatch(/```sh\nnpm install -g newsmonger\nnewsmonger\n```/);
  });

  it('names a bin that matches what the quick start tells people to type', () => {
    // The whole quick start is one command, and that command is this key. A
    // rename here without a README edit leaves the first instruction wrong.
    const bin = z
      .object({ bin: z.record(z.string(), z.string()) })
      .parse(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))).bin;
    expect(Object.keys(bin)).toContain('newsmonger');
    expect(quickStart()).toContain('\nnewsmonger\n');
  });

  it('keeps the README free of developer instructions', () => {
    // The README is for people *using* Newsmonger. Build and test commands read
    // as "how to run this" to someone who just wants the app, which is how the
    // quick start ended up telling readers to clone a repo they hadn't cloned.
    const s = readme();
    for (const devOnly of ['npm run dev', 'npm run test:all', 'npm test', 'git clone']) {
      expect(s, `README should not carry "${devOnly}"`).not.toContain(devOnly);
    }
  });

  it('moves the developer material to CONTRIBUTING.md rather than dropping it', () => {
    // Contributors still need it; it just isn't the front door.
    const contributing = fs.readFileSync(path.join(root, 'CONTRIBUTING.md'), 'utf8');
    expect(contributing).toContain('git clone');
    expect(contributing).toContain('npm run test:all');
    expect(readme()).toContain('CONTRIBUTING.md');
  });
});
