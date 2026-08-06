import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { npmSpawn } from '../../scripts/npm-command.mjs';
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

/**
 * The CLI is spawned as `node dist/cli.js`, not `npx tsx src/cli.ts` (NEWS-295).
 *
 * Two reasons, and the second one is why this stopped being optional.
 *
 * **It is the artifact these tests are about.** Every assertion in this file is
 * about the *packaged* CLI — the `bin` entry, the usage line an installed user
 * sees, the exit code a script gets. `dist/cli.js` is literally what
 * `npm i -g newsmonger` puts on the PATH; `tsx src/cli.ts` is a different
 * program that happens to be built from the same source.
 *
 * **`npx tsx` cannot run in a sandbox.** tsx opens an IPC socket per invocation
 * (`createIpcServer`), and a sandbox that does not hand out `/tmp` denies it:
 * `listen EPERM ... /tmp/claude-501/tsx-501/NNNN.pipe`. Five of the fifteen tests
 * here died that way, and because `test:all` is sequential the unit failure
 * aborted the run before E2E — a red gate that says nothing about the change
 * being tested. `node` on a bundle needs no pipe. It is also several times
 * faster: no package resolve and no transpile of the whole server entry, per
 * spawn, fifteen times.
 *
 * The cost is a build dependency, and it is made explicit rather than implicit:
 * `scripts/test-all.sh` runs `npm run build` before the unit leg (beside the
 * `npm run build:client` that NEWS-191 added for the same class of reason), and
 * `ensureBuilt` below rebuilds on demand so a bare `npm test` on a clean
 * checkout still works.
 */
const CLI_BIN = path.join(root, 'dist/cli.js');

/** The newest mtime anywhere under `dir`, so a stale bundle can be spotted. */
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtimeMs(full) : fs.statSync(full).mtimeMs);
  }
  return newest;
}

/**
 * Build `dist/cli.js` if it is missing or older than any source file.
 *
 * Cached rather than unconditional — tsup takes about half a second, which is
 * not free when the answer is usually "already current". The comparison errs
 * toward rebuilding: anything but a bundle strictly newer than every file under
 * `src/` triggers one, because testing a stale artifact is the one outcome that
 * would make this whole file lie.
 */
function ensureBuilt(): void {
  const built = fs.existsSync(CLI_BIN) ? fs.statSync(CLI_BIN).mtimeMs : 0;
  if (built > newestMtimeMs(path.join(root, 'src'))) return;
  // `npmSpawn`, not a bare 'npm' — Windows needs the .cmd name and a shell
  // (NEWS-348/354/356). This runs in every `npm test`.
  const npm = npmSpawn();
  execFileSync(npm.command, ['run', 'build'], { cwd: root, stdio: 'pipe', shell: npm.shell });
}

/**
 * What the last `runCli` actually spawned.
 *
 * Recorded rather than assumed, so the guard test below asserts on the spawn
 * that happened instead of on this file's source text. A refactor that reaches
 * for a source entry point again fails there.
 */
let lastSpawn: { command: string; argv: string[] } | undefined;

/** Runs the packaged CLI the way a shell does, and returns stdout, stderr and the code. */
function runCli(...args: string[]): { stdout: string; stderr: string; code: number } {
  lastSpawn = { command: process.execPath, argv: [CLI_BIN, ...args] };
  try {
    const stdout = execFileSync(lastSpawn.command, lastSpawn.argv, {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 };
  }
}

beforeAll(ensureBuilt, 120_000);

/**
 * Every test that spawns the CLI gets far more than vitest's 5 s default.
 *
 * A `node dist/cli.js` start is fast — a fraction of the `npx tsx` cold start
 * this used to pay per spawn (NEWS-295) — but "fast" is not the claim being
 * made. Inside the full suite, competing with every other file for CPU, a
 * spawn-based test can still be slow enough to fail on load rather than on
 * behaviour. The number is deliberately generous: it exists to stop a false red,
 * not to assert anything about speed.
 */
const SPAWN_TIMEOUT_MS = 60_000;

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

  it('is exercised through that same built binary, not a source entry point (NEWS-295)', { timeout: SPAWN_TIMEOUT_MS }, () => {
    // The guard on the fix. Running the CLI as `npx tsx src/cli.ts` carried two
    // problems at once — tsx's IPC socket is denied inside a sandbox (five tests
    // here died with `listen EPERM`, and a sequential gate then aborts before
    // E2E ever starts), and a cold resolve-and-transpile per spawn is a real
    // share of unit wall time. Neither is visible in the assertions: they all
    // pass either way on a machine with a permissive /tmp, which is exactly how
    // a refactor could put it back without anyone noticing.
    //
    // So this asserts on the spawn that actually happened: node itself, running
    // the very file `bin` publishes.
    expect(runCli('--version').code).toBe(0);
    expect(lastSpawn?.command, 'the CLI must be run by node, with no loader in front of it').toBe(process.execPath);
    expect(lastSpawn?.argv[0], 'the spawned script must be the binary `bin` names').toBe(
      path.join(root, pkg().bin['newsmonger'] ?? ''),
    );
    // And that file must be the *build output*, not a copy of the source: the
    // bundle inlines every local import, so a surviving relative one would mean
    // node was handed something tsup had not processed.
    expect(fs.readFileSync(CLI_BIN, 'utf8')).not.toMatch(/from '\.\/[\w-]+\.js'/);
  });
});

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
    // One spawn path for the whole file (`runCli`), so the guard above covers
    // every invocation rather than the ones that happened to go through it.
    const { stdout, stderr } = runCli('--bogus');
    const out = `${stdout}${stderr}`;
    expect(out).toContain('usage: newsmonger');
    for (const name of PROVIDER_NAMES) {
      expect(out, `usage line omits ${name}`).toContain(name);
    }
    expect(out, 'ollama is not a provider').not.toContain('ollama');
  });
});

describe('the installed binary answers the first two things anyone types (NEWS-216)', () => {
  const run = runCli;

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
