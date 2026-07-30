import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * The release plumbing is wired and `set-version.mjs` writes every file (NEWS-194).
 *
 * The release flow cannot be tested end to end here — it commits, tags and
 * pushes. But its most dangerous *pure* part can be: writing one version into
 * five files, three of which nothing else checks.
 *
 * That matters because of an asymmetry. `.github/workflows/release.yml` guards
 * the tag against `package.json` and `tauri.conf.json` only, so a version that
 * lands in those two and misses `Cargo.toml` sails through the guard and ships a
 * bundle whose Rust crate disagrees with its own bundle version. And `Cargo.lock`
 * records the workspace package's own version, so missing it means `cargo build`
 * silently rewrites the lockfile — every release then carries an unexplained
 * lockfile diff, and a future `--locked` build hard-fails.
 *
 * So these tests run the real script against real copies of the real files.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Every file `set-version.mjs` is responsible for, and how to read its version. */
const VERSIONED = [
  { rel: 'src-tauri/tauri.conf.json', read: (s: string) => z.object({ version: z.string() }).parse(JSON.parse(s)).version },
  { rel: 'src-tauri/Cargo.toml', read: (s: string) => /^version = "([^"]+)"$/m.exec(s)?.[1] },
  {
    rel: 'src-tauri/Cargo.lock',
    read: (s: string) => /\[\[package\]\]\nname = "newsmonger"\nversion = "([^"]+)"/.exec(s)?.[1],
  },
] as const;

const pkg = (): { scripts: Record<string, string> } =>
  z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')));

describe('the release scripts are wired up (NEWS-194)', () => {
  it.each([
    ['release', 'bash scripts/release.sh'],
    ['release:beta', 'bash scripts/release.sh --beta'],
    ['release:beta:auto', 'bash scripts/release-beta-auto.sh'],
  ])('npm run %s -> %s', (name, command) => {
    expect(pkg().scripts[name]).toBe(command);
  });

  it.each([
    'scripts/release.sh',
    'scripts/release-beta-auto.sh',
    'scripts/set-version.mjs',
    'scripts/add-changelog-entry.mjs',
  ])(
    '%s exists and is executable',
    (rel) => {
      const full = path.join(root, rel);
      expect(fs.existsSync(full), `${rel} should exist`).toBe(true);
      // The POSIX owner-execute bit. `npm run …` invokes these via `bash`, so a
      // missing bit is harmless there — but it makes `./scripts/release.sh` fail
      // confusingly, and git tracks the bit, so set it once and hold it.
      expect((fs.statSync(full).mode & 0o100) !== 0, `${rel} should be executable`).toBe(true);
    },
  );

  it.each(['scripts/release.sh', 'scripts/release-beta-auto.sh'])('%s parses as bash', (rel) => {
    // `bash -n` catches an unclosed quote or `fi`/`done` mismatch without running
    // anything. These scripts commit and push, so a syntax error found by
    // executing them is found too late.
    expect(() => execFileSync('bash', ['-n', path.join(root, rel)])).not.toThrow();
  });

  it('keeps .release-state.json out of git', () => {
    // The interactive flow writes it at the repo root, and it holds draft release
    // notes. Committing it would be noise at best.
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('.release-state.json');
  });

  it('has a CHANGELOG.md for the flow to prepend to', () => {
    // Both flows insert above the newest `## [` entry. A missing file is handled
    // (they create one), but the seeded header is what makes the first release
    // read like the others.
    expect(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')).toMatch(/^# Changelog/);
  });
});

describe('add-changelog-entry.mjs (NEWS-194)', () => {
  let sandbox: string;

  /**
   * Run the real script in a temp repo with a seeded CHANGELOG.
   *
   * The script resolves CHANGELOG.md relative to its **own** location, so the
   * copy has to sit in a `scripts/` dir inside the sandbox — running the
   * repo's copy with a different cwd would edit the real changelog. It did,
   * once, when a sandboxed `mktemp` failed and the fallback was the repo root.
   */
  function addEntry(version: string, notes: string): { status: number; output: string } {
    try {
      const stdout = execFileSync('node', [path.join(sandbox, 'scripts/add-changelog-entry.mjs'), version], {
        input: notes,
        encoding: 'utf8',
      });
      return { status: 0, output: stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  const changelog = (): string => fs.readFileSync(path.join(sandbox, 'CHANGELOG.md'), 'utf8');

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-changelog-'));
    fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
    fs.copyFileSync(
      path.join(root, 'scripts/add-changelog-entry.mjs'),
      path.join(sandbox, 'scripts/add-changelog-entry.mjs'),
    );
    fs.copyFileSync(path.join(root, 'CHANGELOG.md'), path.join(sandbox, 'CHANGELOG.md'));
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('keeps entries newest-first across successive releases', () => {
    // The trap worth a test: appending instead of inserting silently inverts the
    // order, and nobody notices until someone reads the changelog from the top
    // and finds the oldest release.
    expect(addEntry('0.1.0', '- older\n').status).toBe(0);
    expect(addEntry('0.2.0', '- newer\n').status).toBe(0);
    const headings = [...changelog().matchAll(/^## \[([^\]]+)]/gm)].map((m) => m[1]);
    expect(headings).toEqual(['0.2.0', '0.1.0']);
  });

  it('preserves markdown that a shell argument would mangle', () => {
    // Why notes arrive on stdin rather than argv.
    const nasty = '- `backticks`, "quotes", $dollars and \\backslashes\n';
    addEntry('0.3.0', nasty);
    expect(changelog()).toContain('- `backticks`, "quotes", $dollars and \\backslashes');
  });

  it('keeps the file header above the newest entry', () => {
    addEntry('0.4.0', '- a change\n');
    const text = changelog();
    expect(text.indexOf('# Changelog')).toBeLessThan(text.indexOf('## [0.4.0]'));
  });

  it('creates the file when it is missing', () => {
    fs.rmSync(path.join(sandbox, 'CHANGELOG.md'));
    expect(addEntry('0.5.0', '- from scratch\n').status).toBe(0);
    expect(changelog()).toMatch(/^# Changelog\n\n## \[0\.5\.0]/);
  });

  it('refuses empty notes rather than writing a bare heading', () => {
    const result = addEntry('0.6.0', '');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('Refusing to write an empty changelog entry');
    expect(changelog()).not.toContain('0.6.0');
  });

  it.each(['', '1.2', 'v1.2.3', '1.2.3-beta.1'])('rejects %o as a version', (bad) => {
    expect(addEntry(bad, '- x\n').status).not.toBe(0);
    expect(changelog()).not.toContain(`[${bad}]`);
  });
});

describe('set-version.mjs writes every file that states a version (NEWS-194)', () => {
  let sandbox: string;

  /** Run the real script against copies of the real files, in a temp repo. */
  function runInSandbox(version: string): { status: number; stdout: string } {
    try {
      const stdout = execFileSync('node', [path.join(sandbox, 'scripts/set-version.mjs'), version], {
        cwd: sandbox,
        encoding: 'utf8',
      });
      return { status: 0, stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, stdout: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-setversion-'));
    fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'src-tauri'), { recursive: true });
    fs.copyFileSync(path.join(root, 'scripts/set-version.mjs'), path.join(sandbox, 'scripts/set-version.mjs'));
    for (const { rel } of VERSIONED) fs.copyFileSync(path.join(root, rel), path.join(sandbox, rel));
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('sets the version in all three files', () => {
    expect(runInSandbox('9.8.7').status).toBe(0);
    for (const { rel, read } of VERSIONED) {
      expect(read(fs.readFileSync(path.join(sandbox, rel), 'utf8')), `${rel} should say 9.8.7`).toBe('9.8.7');
    }
  });

  it('changes exactly one line per file', () => {
    // The real risk in Cargo.lock: ~400 other `[[package]]` blocks, and more than
    // one of them shares whatever version this crate happens to be on. A regex
    // that matched on the version instead of the name would rewrite those too.
    const before = VERSIONED.map(({ rel }) => fs.readFileSync(path.join(sandbox, rel), 'utf8'));
    runInSandbox('9.8.7');
    VERSIONED.forEach(({ rel }, i) => {
      const after = fs.readFileSync(path.join(sandbox, rel), 'utf8').split('\n');
      const changed = before[i].split('\n').filter((line, n) => line !== after[n]);
      expect(changed.length, `${rel} changed ${changed.length} lines: ${changed.join(' | ')}`).toBe(1);
    });
  });

  it('leaves dependency version pins in Cargo.toml alone', () => {
    // `[package]` and `tauri = { version = "2" }` both contain `version =`, so an
    // unanchored replace would rewrite every dependency pin in the file.
    runInSandbox('9.8.7');
    const toml = fs.readFileSync(path.join(sandbox, 'src-tauri/Cargo.toml'), 'utf8');
    expect(toml).toContain('tauri = { version = "2"');
    expect(toml).not.toContain('version = "9.8.7" }');
  });

  it('is idempotent', () => {
    runInSandbox('9.8.7');
    const first = VERSIONED.map(({ rel }) => fs.readFileSync(path.join(sandbox, rel), 'utf8'));
    const second = runInSandbox('9.8.7');
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already 9.8.7');
    VERSIONED.forEach(({ rel }, i) => {
      expect(fs.readFileSync(path.join(sandbox, rel), 'utf8')).toBe(first[i]);
    });
  });

  it.each(['', '1.2', 'v1.2.3', '1.2.3-beta.1', 'nonsense'])('rejects %o as a version', (bad) => {
    // `1.2.3-beta.1` is the one worth calling out: it is valid semver and invalid
    // here, because macOS bundle version fields reject prerelease suffixes. The
    // suffix belongs on the git tag.
    const result = runInSandbox(bad);
    expect(result.status).not.toBe(0);
    for (const { rel, read } of VERSIONED) {
      expect(read(fs.readFileSync(path.join(sandbox, rel), 'utf8'))).not.toBe(bad);
    }
  });

  it('fails loudly when a file it expects to edit no longer matches', () => {
    // Silent partial success is the failure mode worth engineering against: the
    // release workflow only guards package.json and tauri.conf.json, so a
    // Cargo.toml this script quietly skipped would ship.
    fs.writeFileSync(path.join(sandbox, 'src-tauri/Cargo.toml'), '[package]\nname = "newsmonger"\n');
    const result = runInSandbox('9.8.7');
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('NO MATCH');
  });
});
