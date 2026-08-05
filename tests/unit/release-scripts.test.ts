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
  { rel: 'src-tauri/Cargo.toml', read: (s: string) => /^version = "([^"]+)"\r?$/m.exec(s)?.[1] },
  {
    // `\r?\n`, like the script's own pattern — these readers are handed CRLF
    // fixtures by the Windows regression test below, and a reader that only
    // understands LF would report "undefined" for a file the script bumped
    // correctly, blaming the script for the harness's limitation (NEWS-213).
    rel: 'src-tauri/Cargo.lock',
    read: (s: string) => /\[\[package\]\]\r?\nname = "newsmonger"\r?\nversion = "([^"]+)"/.exec(s)?.[1],
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
    ['tauri:build:local', 'bash scripts/tauri-build-local.sh'],
  ])('npm run %s -> %s', (name, command) => {
    expect(pkg().scripts[name]).toBe(command);
  });

  it.each([
    'scripts/release.sh',
    'scripts/release-beta-auto.sh',
    'scripts/tauri-build-local.sh',
    'scripts/set-version.mjs',
    'scripts/add-changelog-entry.mjs',
    'scripts/ensure-sidecar-stub.sh',
    'scripts/gates-rust.sh',
    'scripts/rust-changed.sh',
    'scripts/gate-quick.sh',
    'scripts/notary-watch.sh',
    'scripts/verify-signing.sh',
    'scripts/check-tag-version.sh',
    'scripts/verify-sidecar-linux.sh',
    'scripts/verify-released-dmg.sh',
    'tests/smoke/smoke-test.sh',
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

  it.each([
    'scripts/release.sh',
    'scripts/release-beta-auto.sh',
    'scripts/tauri-build-local.sh',
    'scripts/ensure-sidecar-stub.sh',
    'scripts/gates-rust.sh',
    'scripts/rust-changed.sh',
    'scripts/gate-quick.sh',
    'scripts/notary-watch.sh',
    'scripts/verify-signing.sh',
    'scripts/check-tag-version.sh',
    'scripts/verify-sidecar-linux.sh',
    'scripts/verify-released-dmg.sh',
    'tests/smoke/smoke-test.sh',
  ])(
    '%s parses as bash',
    (rel) => {
      // `bash -n` catches an unclosed quote or `fi`/`done` mismatch without
      // running anything. These scripts commit, push and sign, so a syntax error
      // found by executing them is found too late.
      expect(() => execFileSync('bash', ['-n', path.join(root, rel)])).not.toThrow();
    },
  );

  it.each([
    'scripts/release.sh',
    'scripts/release-beta-auto.sh',
    'scripts/tauri-build-local.sh',
    'scripts/ensure-sidecar-stub.sh',
    'scripts/gates-rust.sh',
    'scripts/rust-changed.sh',
    'scripts/gate-quick.sh',
    'scripts/notary-watch.sh',
    'scripts/verify-signing.sh',
    'scripts/check-tag-version.sh',
    'scripts/verify-sidecar-linux.sh',
    'scripts/verify-released-dmg.sh',
    'tests/smoke/smoke-test.sh',
  ])(
    '%s uses no bash 4 builtins',
    (rel) => {
      // macOS ships bash **3.2** and `/usr/bin/env bash` resolves to it. The first
      // version of `tauri-build-local.sh` used `mapfile` and died instantly with
      // "command not found" — and `bash -n` above passed, because a missing
      // builtin is a runtime failure, not a syntax error.
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      // Only flag real invocations, not the comments explaining why they're absent.
      const code = src
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
      for (const builtin of ['mapfile', 'readarray', 'declare -A', 'wait -n']) {
        expect(code, `${rel} uses ${builtin}, which bash 3.2 lacks`).not.toContain(builtin);
      }
    },
  );

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
  function addEntry(version: string, notes: string, extra: string[] = []): { status: number; output: string } {
    try {
      const stdout = execFileSync('node', [path.join(sandbox, 'scripts/add-changelog-entry.mjs'), version, ...extra], {
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
    // A fixture header, NOT a copy of the real CHANGELOG.md.
    //
    // Seeding from the real file is what these tests did first, and the very
    // next release broke them: the newest-first assertion compares the full list
    // of headings, so a real `## [0.1.0]` entry made it `['0.2.0','0.1.0','0.1.0']`.
    // The behaviour under test is the script's *insertion*, which has nothing to
    // do with the repo's release history — coupling to it means every release can
    // fail the suite. The real file's shape is asserted separately, above.
    fs.writeFileSync(path.join(sandbox, 'CHANGELOG.md'), '# Changelog\n\nPreamble prose.\n');
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

  it.each(['', '1.2', 'v1.2.3', 'nonsense'])('rejects %o as a version', (bad) => {
    expect(addEntry(bad, '- x\n').status).not.toBe(0);
    expect(changelog()).not.toContain(`[${bad}]`);
  });

  // --- Duplicate handling (NEWS-196) ---
  //
  // Hit for real cutting v0.1.0-beta.1: the CI run failed *after* the local script
  // had committed the bump and the entry, so the natural recovery — re-run — would
  // have prepended a second `## [0.1.0]`.

  it('accepts a prerelease version, unlike set-version.mjs', () => {
    // Deliberately divergent. The version *files* cannot carry `-beta.N` (macOS
    // bundle version fields reject it), but the changelog is history and each beta
    // is its own release with its own notes.
    expect(addEntry('0.1.0-beta.1', '- beta one\n').status).toBe(0);
    expect(changelog()).toContain('## [0.1.0-beta.1]');
  });

  it('gives each beta of a version its own heading', () => {
    // The case that bites on every increment, not just a retry: beta.2 targets the
    // same base version as beta.1, so a base-version heading would always collide.
    addEntry('0.1.0-beta.1', '- beta one\n');
    expect(addEntry('0.1.0-beta.2', '- beta two\n').status).toBe(0);
    const headings = [...changelog().matchAll(/^## \[([^\]]+)]/gm)].map((m) => m[1]);
    expect(headings).toEqual(['0.1.0-beta.2', '0.1.0-beta.1']);
  });

  it('refuses a duplicate version rather than prepending a second heading', () => {
    addEntry('0.2.0', '- first\n');
    const again = addEntry('0.2.0', '- second\n');
    expect(again.status).not.toBe(0);
    expect(again.output).toContain('already has an entry for 0.2.0');
    expect([...changelog().matchAll(/^## \[0\.2\.0]/gm)]).toHaveLength(1);
  });

  it('replaces in place with --replace, keeping newest-first order', () => {
    addEntry('0.1.0-beta.1', '- older\n');
    addEntry('0.3.0', '- original notes\n');
    expect(addEntry('0.3.0', '- corrected notes\n', ['--replace']).status).toBe(0);
    const text = changelog();
    expect([...text.matchAll(/^## \[0\.3\.0]/gm)]).toHaveLength(1);
    expect(text).toContain('- corrected notes');
    expect(text).not.toContain('- original notes');
    const headings = [...text.matchAll(/^## \[([^\]]+)]/gm)].map((m) => m[1]);
    expect(headings).toEqual(['0.3.0', '0.1.0-beta.1']);
  });

  it('--replace inserts when there is nothing to replace', () => {
    // The release scripts always pass it, so it must work on a first release too.
    expect(addEntry('0.4.0', '- brand new\n', ['--replace']).status).toBe(0);
    expect(changelog()).toContain('## [0.4.0]');
  });

  it('replacing an entry does not eat the one below it', () => {
    // The section boundary is "up to the next `## [` or EOF"; an off-by-one here
    // would silently delete release history.
    addEntry('0.1.0', '- oldest\n');
    addEntry('0.2.0', '- middle\n');
    addEntry('0.3.0', '- newest\n');
    addEntry('0.3.0', '- newest, fixed\n', ['--replace']);
    const text = changelog();
    expect(text).toContain('- oldest');
    expect(text).toContain('- middle');
    expect(text).toContain('- newest, fixed');
    expect([...text.matchAll(/^## \[/gm)]).toHaveLength(3);
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

  it.each(['', '1.2', 'v1.2.3', '1.2.3+build.5', '1.2.3-', 'nonsense'])('rejects %o as a version', (bad) => {
    const result = runInSandbox(bad);
    expect(result.status).not.toBe(0);
    for (const { rel, read } of VERSIONED) {
      expect(read(fs.readFileSync(path.join(sandbox, rel), 'utf8'))).not.toBe(bad);
    }
  });

  it.each(['1.2.3-beta.1', '1.2.3-rc.2', '1.2.3-1'])('accepts %o, suffix and all (NEWS-207)', (version) => {
    // This assertion used to say the opposite. NEWS-196 rejected a prerelease
    // suffix on the inherited claim that "macOS bundle version fields reject
    // them", so beta bundles got the *base* version — and since the Tauri updater
    // compares versions, every beta reported `0.2.0` and an installed beta could
    // never see the next one.
    //
    // Measured, not reasoned about (NEWS-207): built locally at `0.2.0-beta.1`,
    // cargo compiles it, the bundler emits `Newsmonger_0.2.0-beta.1_aarch64.dmg`,
    // both `CFBundleShortVersionString` and `CFBundleVersion` read the beta
    // version, and the launched app reports it to Launch Services.
    //
    // The genuine constraint is the Windows MSI's numeric-only pre-release
    // identifier, and that is handled where it lives — `--bundles nsis` for betas.
    const result = runInSandbox(version);
    expect(result.status, result.stdout).toBe(0);
    for (const { rel, read } of VERSIONED) {
      expect(read(fs.readFileSync(path.join(sandbox, rel), 'utf8')), `${rel} should carry ${version}`).toBe(version);
    }
  });

  it('works on CRLF checkouts, as Windows runners produce (NEWS-213)', () => {
    // The bug this pins killed the signed Windows build of an already-tagged
    // release. Git for Windows checks out with CRLF by default, and the Cargo.lock
    // transform matched `\n` between lines — so on Windows it matched nothing,
    // reported "NO MATCH", and exited 1. macOS and Linux never saw it, which is
    // exactly why it reached a release: nothing local reproduced it.
    //
    // Rewriting the fixtures to CRLF here is the cheapest faithful reproduction —
    // it is the only thing the Windows runner did differently.
    for (const { rel } of VERSIONED) {
      const full = path.join(sandbox, rel);
      const lf = fs.readFileSync(full, 'utf8');
      fs.writeFileSync(full, lf.replace(/\r?\n/g, '\r\n'));
    }

    const result = runInSandbox('9.8.7');
    expect(result.stdout).not.toContain('NO MATCH');
    expect(result.status).toBe(0);
    for (const { rel, read } of VERSIONED) {
      expect(read(fs.readFileSync(path.join(sandbox, rel), 'utf8')), `${rel} should be bumped`).toBe('9.8.7');
    }
  });

  it('keeps CRLF files as CRLF rather than silently reformatting them', () => {
    // Rewriting every line ending of a file it was asked to change one line of
    // would turn a version bump into a whole-file diff.
    const rel = 'src-tauri/Cargo.lock';
    const full = path.join(sandbox, rel);
    fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace(/\r?\n/g, '\r\n'));

    expect(runInSandbox('9.8.7').status).toBe(0);
    const after = fs.readFileSync(full, 'utf8');
    expect(after).toContain('\r\n');
    expect(after.match(/(?<!\r)\n/g), 'no bare LF should have been introduced').toBeNull();
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

describe('the release scripts resolve the tag before writing (NEWS-196)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

  it.each(['scripts/release.sh', 'scripts/release-beta-auto.sh'])(
    '%s passes --replace, since both flows are re-runnable',
    (rel) => {
      expect(read(rel)).toMatch(/add-changelog-entry\.mjs "\$\{?\w+\}?" --replace/);
    },
  );

  it.each(['scripts/release.sh', 'scripts/release-beta-auto.sh'])(
    '%s resolves the beta number exactly once',
    (rel) => {
      // It used to be computed inside the tag step only, i.e. *after* the changelog
      // was written — so the entry could not carry the suffix. Two separate loops
      // would also be free to disagree.
      const src = read(rel);
      expect(src).toContain('resolve_tag');
      expect([...src.matchAll(/rev-parse "v[^"]*-beta\./g)], 'beta loop should appear once').toHaveLength(1);
    },
  );
});

describe('the rc/beta release pipeline (NEWS-201)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
  const rc = (): string => read('.github/workflows/release-candidate.yml');

  /**
   * `src` with whole-line comments removed.
   *
   * These files are heavily commented *about* the very strings being asserted, so
   * a naive `toContain` / occurrence count reads the explanation as the config.
   * Whole-line only — a `#` inside a quoted string (the release-notes echo) is
   * content, not a comment.
   */
  const code = (src: string): string =>
    src
      .split('\n')
      .filter((l) => !/^\s*(#|\/\/)/.test(l))
      .join('\n');

  it('gives beta bundles the full beta version, so the updater can order them (NEWS-207)', () => {
    // The bug this pins: the beta build job wrote `${VER%%-*}` — the *base*
    // version — into the Tauri/Cargo files, so `v0.2.0-beta.1` and
    // `v0.2.0-beta.2` produced bundles that both reported `0.2.0`. The Tauri
    // updater compares versions, so an installed beta could never see the next
    // one, which is most of the point of a beta channel.
    //
    // Everything still built and the release page still looked right, so nothing
    // failed — the check has to be on the config, because there is no red build
    // to notice.
    const src = code(rc());
    expect(src, 'the base-version truncation should be gone').not.toContain('${VER%%-*}');
    expect(src).toMatch(/node scripts\/set-version\.mjs "\$VER"/);
  });

  it('still builds betas as NSIS only, which is the real Windows constraint', () => {
    // The MSI bundler rejects a non-numeric pre-release identifier. That is a
    // bundler flag, and stays one — it was never a reason to write a version into
    // the file that the bundle does not have.
    expect(code(rc())).toContain('--bundles nsis');
  });

  it('cuts a stable release as an -rc.N tag, not a bare v{ver}', () => {
    // The model glassbox uses and this repo diverged from until the promote step
    // existed: CI publishes the rc, smoke-tests the *published* package, then
    // promotes. A bare `v{ver}` from here would skip all of that and go straight
    // to `latest`.
    const src = read('scripts/release.sh');
    expect([...src.matchAll(/rev-parse "v[^"]*-rc\./g)], 'rc loop should appear once').toHaveLength(1);
    // The stable branch of resolve_tag must not emit a bare tag any more.
    expect(src).not.toMatch(/printf '%s\\t%s' "v\$\{version\}" "\$version"/);
  });

  it('keeps the changelog label clean while the tag carries -rc.N', () => {
    // The changelog documents the release; the rc is the mechanism that ships it.
    // `## [0.2.0-rc.1]` in CHANGELOG.md would be an implementation detail leaking
    // into the user-facing history — and the promoted release would have no entry.
    const src = read('scripts/release.sh');
    expect(src).toMatch(/printf '%s\\t%s' "v\$\{version\}-rc\.\$\{n\}" "\$version"/);
  });

  it('has the release-candidate workflow under its npm-bound filename', () => {
    // npm allows one trusted publisher per package and the binding is scoped to the
    // workflow *filename*. Renaming this file silently breaks token-free publishing
    // for both tag tracks — the failure surfaces as a 404 from the registry.
    expect(fs.existsSync(path.join(root, '.github/workflows/release-candidate.yml'))).toBe(true);
  });

  it('fires on both prerelease tag tracks and nothing else', () => {
    const src = rc();
    expect(src).toContain("- 'v*-rc.*'");
    expect(src).toContain("- 'v*-beta.*'");
    // The stable track belongs to release-desktop.yml. Two workflows racing on one
    // tag would double-publish.
    expect(read('.github/workflows/release-desktop.yml')).toContain("- 'v[0-9]*'");
  });

  it('gates promote on -rc. and the GitHub Release jobs on -beta.', () => {
    // "Those `if:` conditions are the whole design" — get one wrong and a beta
    // auto-publishes as stable. Asserted per job rather than by counting, so a
    // condition moved onto the wrong job fails here.
    const src = rc();
    const jobCondition = (job: string): string | undefined => {
      // The `if:` on the job itself is the first one after the job key, before any
      // `steps:` block introduces step-level conditions.
      const start = src.indexOf(`\n  ${job}:\n`);
      expect(start, `job ${job} should exist`).toBeGreaterThan(-1);
      const head = src.slice(start, src.indexOf('\n    steps:', start));
      return /^\s{4}if: (.*)$/m.exec(head)?.[1];
    };

    expect(jobCondition('promote-release')).toBe("contains(github.ref, '-rc.')");
    for (const job of ['create-release', 'build', 'publish-release']) {
      expect(jobCondition(job), `${job} must be beta-only`).toBe("contains(github.ref, '-beta.')");
    }
    // Publishing and smoke-testing run on BOTH tracks — a beta nobody installed is
    // exactly as untested as an rc nobody installed.
    for (const job of ['publish-beta', 'smoke-fresh-install', 'smoke-upgrade']) {
      expect(jobCondition(job), `${job} must run on both tracks`).toBeUndefined();
    }
  });

  it('never lets a prerelease become releases/latest', () => {
    // The desktop updater resolves through `releases/latest` (tauri.conf.json), so a
    // prerelease that took that pointer would push a beta to every stable install.
    const src = code(rc());
    expect(src).toContain("make_latest: 'false'");
    expect(src).not.toContain("make_latest: 'true'");
    // Both the create and the flip must say prerelease — flipping the draft is a
    // full update call, so omitting it there would quietly clear the flag.
    expect([...src.matchAll(/prerelease: true/g)]).toHaveLength(2);
  });

  it('publishes betas under the beta dist-tag and only promotes under latest', () => {
    const src = rc();
    expect(src).toContain('npm publish --tag beta --provenance --access public');
    expect(src).toContain('npm publish --tag latest --provenance --access public');
    // `latest` may only be published from the rc-gated promote job.
    const promote = src.slice(src.indexOf('\n  promote-release:\n'));
    expect(promote).toContain('--tag latest');
    expect(src.slice(0, src.indexOf('\n  promote-release:\n'))).not.toContain('--tag latest');
  });

  it('upgrades npm past the OIDC trusted-publishing floor', () => {
    // Older npm can attach a --provenance attestation but cannot use the OIDC token
    // as the bearer for the PUT; it falls through to an empty _authToken and the
    // registry reports the rejection as a 404. Both publishing jobs need this.
    const src = rc();
    expect([...src.matchAll(/npm install -g npm@11/g)]).toHaveLength(2);
  });

  it('smoke-tests the exact published version, not the dist-tag', () => {
    // `newsmonger@beta` races the dist-tag rotation, which would smoke-test the
    // *previous* beta and report success for a broken publish.
    //
    // Scoped to the smoke jobs: the release-notes body legitimately *tells* readers
    // to `npm install -g newsmonger@beta`, which is documentation, not a test step.
    const src = rc();
    const smoke = src.slice(src.indexOf('\n  smoke-fresh-install:\n'), src.indexOf('\n  promote-release:\n'));
    // The version reaches the shell through `env:` rather than being
    // interpolated into the command, so both smoke jobs are checked for the
    // binding *and* the use — either half alone would pass while installing
    // nothing (`newsmonger@` with an empty expansion).
    expect(smoke).toContain('VERSION: ${{ needs.publish-beta.outputs.version }}');
    expect(smoke).toContain('newsmonger@$VERSION');
    expect(smoke).not.toContain('newsmonger@beta');
    // Both jobs, not just the first: the upgrade job installs it too.
    expect([...smoke.matchAll(/VERSION: \$\{\{ needs\.publish-beta\.outputs\.version \}\}/g)]).toHaveLength(2);
  });

  it('dispatches the desktop release rather than relying on the tag push', () => {
    // A tag pushed with GITHUB_TOKEN does not trigger another workflow — GitHub's
    // recursion guard. Without the explicit dispatch the stable bundles never build.
    const src = rc();
    expect(src).toContain('createWorkflowDispatch');
    expect(src).toContain("workflow_id: 'release-desktop.yml'");
    expect(read('.github/workflows/release-desktop.yml')).toContain('workflow_dispatch:');
  });

  it('builds the client before unit tests in the release gates', () => {
    // NEWS-191: several suites fetch /static/... through createApp() and 404 without
    // dist/client. This kept CI red once and would fail a release the same way.
    const src = rc();
    const unit = src.slice(src.indexOf('\n  test-unit:\n'), src.indexOf('\n  audit:\n'));
    expect(unit.indexOf('npm run build:client')).toBeGreaterThan(-1);
    expect(unit.indexOf('npm run build:client')).toBeLessThan(unit.indexOf('npm test'));
  });

  it('runs both clippy profiles, since the updater commands are cfg-gated', () => {
    // NEWS-89's three commands are `#[cfg(not(debug_assertions))]`, so a debug-only
    // clippy never compiles their bodies.
    const src = rc();
    expect(src).toContain('cargo clippy --all-targets -- -D warnings');
    expect(src).toContain('cargo clippy --release --all-targets -- -D warnings');
  });

  it('uses the extracted sidecar stub in every Rust-only job', () => {
    // Two hand-maintained copies of the build paths is how the wordmark shipped
    // broken (tests/unit/client-assets.test.ts).
    expect(rc()).toContain('bash scripts/ensure-sidecar-stub.sh');
    expect(read('.github/workflows/ci.yml')).toContain('bash scripts/ensure-sidecar-stub.sh');
  });
});

describe('the published-install smoke test (NEWS-201)', () => {
  const src = (): string => fs.readFileSync(path.join(root, 'tests/smoke/smoke-test.sh'), 'utf8');

  /** Executable lines only — the header explains ~/.newsmonger at length. */
  const codeOnly = (): string =>
    src()
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');

  it('never writes to the real data directory', () => {
    // The same rule the unit and E2E suites follow: the default is ~/.newsmonger,
    // and a smoke test that wrote there would scribble on the real install of
    // whoever ran it locally.
    const sh = codeOnly();
    expect(sh).toContain('--data-dir');
    expect(sh).toContain('mktemp -d');
    expect(sh).not.toMatch(/~\/\.newsmonger|\$HOME\/\.newsmonger/);
  });

  it('derives the static asset list from what the server serves', () => {
    // A hardcoded list here would be a fourth copy of the same list, with the same
    // failure mode that shipped a broken wordmark: the asset exists, the build
    // succeeds, nothing warns.
    const sh = src();
    expect(sh).toMatch(/grep -o '\/static\/\[A-Za-z0-9\._-\]\*'/);
    expect(sh).not.toContain('/static/wordmark-light.svg');
  });

  it('asserts a check actually produces stories', () => {
    // The part that proves the *pipeline* runs inside an installed build — request
    // validation, the provider call, dedup and the SQLite write — rather than just
    // that the package unpacked.
    const sh = src();
    expect(sh).toContain('--ai-test');
    expect(sh).toContain('/api/check');
    expect(sh).toMatch(/STORIES.*-gt 0|"\$STORIES" -gt 0/);
  });

  it('asserts --help exits zero rather than tolerating a failure', () => {
    // This assertion used to say the opposite. `--help` was an unrecognised flag,
    // so it printed usage and exited 1, and the script swallowed that with
    // `|| true` — under `set -o pipefail` the non-zero exit had made
    // `! cmd | grep -q .` report "not runnable" for a command that ran perfectly.
    // NEWS-216 made `--help` exit 0, so the exit code is now the thing being
    // checked: `|| true` would hide exactly the regression worth catching.
    const sh = src();
    expect(sh, 'the || true workaround should be gone').not.toContain('--help 2>&1 || true');
    expect(sh).toContain('HELP_STATUS');
    expect(sh).toMatch(/HELP_STATUS.*-eq 0/);
    expect(sh, '--version should be smoke-tested too').toContain('--version');
  });

  it('checks --help goes to stdout, not stderr', () => {
    // `2>&1` on the main capture would pass either way; a separate stdout-only
    // invocation is what distinguishes them. `newsmonger --help | less` is the
    // case that breaks if help goes to stderr.
    expect(src()).toContain('--help 2>/dev/null');
  });
});

describe('the local gates cover what CI checks', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

  // This exists because it went wrong. `test:all` was typecheck + lint + unit +
  // E2E and contained **no Rust**, while ci.yml has a whole Tauri job — so the
  // command whose entire promise is "everything" passed green with a
  // `cargo fmt --check` violation in src-tauri/src/lib.rs, and main was red for
  // two commits before anyone opened Actions. Clippy had been run by hand;
  // nothing named the formatter, so nothing ran it.
  it('runs the Rust gates as part of test:all', () => {
    expect(read('scripts/test-all.sh')).toContain('bash scripts/gates-rust.sh');
  });

  it('exposes the Rust gates on their own too', () => {
    // Parsed through zod rather than cast — same rule as the rest of the project:
    // validate, don't assert (and `strictTypeChecked` rejects the cast anyway).
    const { scripts } = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(JSON.parse(read('package.json')));
    expect(scripts['gates:rust']).toBe('bash scripts/gates-rust.sh');
  });

  it.each([
    ['cargo fmt', /cargo fmt[^\n]*--check/],
    ['clippy (debug)', /cargo clippy(?![^\n]*--release)[^\n]*-D warnings/],
    ['clippy (release)', /cargo clippy[^\n]*--release[^\n]*-D warnings/],
    ['cargo test', /cargo test/],
  ])('checks %s locally, matching the CI job', (_label, pattern) => {
    // Drift is the risk: a check added to ci.yml and not here reintroduces exactly
    // the blind spot above. Both clippy profiles are required — the updater
    // commands are cfg(not(debug_assertions)), so a debug-only clippy never
    // compiles their bodies (NEWS-89).
    expect(read('scripts/gates-rust.sh')).toMatch(pattern);
    expect(read('.github/workflows/ci.yml')).toMatch(pattern);
  });

  it('stubs the bundle paths before running cargo', () => {
    // Every cargo command fails before compiling without them — tauri-build
    // validates externalBin/resources inside its build script.
    expect(read('scripts/gates-rust.sh')).toContain('bash scripts/ensure-sidecar-stub.sh');
  });

  it('skips rather than fails when there is no cargo toolchain', () => {
    // The JS gates must stay runnable on a machine without Rust. Loudly, though —
    // a silent skip is how this class of gap opens in the first place.
    const src = read('scripts/gates-rust.sh');
    expect(src).toContain('command -v cargo');
    expect(src).toContain('SKIPPING');
    expect(src).toContain('RUST_GATES');
  });
});

describe('the Rust gates skip only where a sibling job covers them', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

  it("ci.yml's gate job opts out, because its rust job does the work", () => {
    // Folding the Rust gates into `test:all` red-lit main: the gate runner has no
    // webkit/glib dev headers, so `cargo` failed with "The system library
    // `glib-2.0` ... was not found". The fix is to skip there, not to install the
    // headers twice and run the same four checks twice.
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/npm run test:all\s*\n\s*env:\s*\n\s*RUST_GATES: skip/);
  });

  it('still runs them in the dedicated rust job', () => {
    // The skip above is only safe while this remains true. If the rust job ever
    // loses a check, the gate job's opt-out silently stops being covered.
    const ci = read('.github/workflows/ci.yml');
    for (const cmd of [/cargo fmt[^\n]*--check/, /cargo clippy(?![^\n]*--release)[^\n]*-D warnings/, /cargo clippy[^\n]*--release[^\n]*-D warnings/, /cargo test/]) {
      expect(ci).toMatch(cmd);
    }
  });

  it('honours skip, and is not skipped by default', () => {
    const sh = read('scripts/gates-rust.sh');
    expect(sh).toContain('"${RUST_GATES:-}" = "skip"');
    // No default value that would turn the local gate into a no-op.
    expect(sh).not.toMatch(/RUST_GATES:-skip/);
  });

  it('release-candidate.yml does not route Rust through test:all', () => {
    // Its unit job runs `npm test` directly and it has its own rust job, so the
    // glib problem cannot arise there — asserting it so a future "simplification"
    // to `npm run test:all` doesn't reintroduce it.
    const rc = read('.github/workflows/release-candidate.yml');
    expect(rc).not.toContain('npm run test:all');
  });
});

describe('the beta smoke install (seen failing on v0.2.0-beta.5)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
  const rc = (): string => read('.github/workflows/release-candidate.yml');

  /** Just the `run:` body of the retrying install step. */
  function installStep(): string {
    const text = rc();
    const start = text.indexOf('Install beta globally');
    expect(start, 'the retrying install step should exist').toBeGreaterThan(-1);
    const next = text.indexOf('- name:', start);
    return text.slice(start, next === -1 ? undefined : next);
  }

  it('fails when the retries run out, rather than exiting 0', () => {
    // The bug this pins: the original loop's last statement was `sleep 15`,
    // which succeeds — so an exhausted loop exited 0, the step went green with
    // nothing installed, and the failure surfaced in the *next* step as a
    // baffling "newsmonger: not found". A retry loop that cannot fail is not a
    // retry loop.
    const step = installStep();
    expect(step).toContain('exit 1');
    expect(step).toContain('::error::');
    // And it must succeed early rather than falling through to the error.
    expect(step).toContain('exit 0');
  });

  it('waits long enough for the registry to propagate', () => {
    // beta.5 404'd for the whole 5 x 15s budget and was installable shortly
    // after: `publish-beta` succeeding means the registry accepted the tarball,
    // not that every CDN edge can serve it yet.
    const step = installStep();
    const attempts = /for i in ([\d ]+); do/.exec(step)?.[1]?.trim().split(/\s+/).length ?? 0;
    expect(attempts, 'too few attempts to ride out CDN propagation').toBeGreaterThanOrEqual(8);
    // Backoff rather than a flat sleep, so the tail is long without the common
    // case paying for it.
    expect(step).toMatch(/sleep "\$\{i\}0"/);
  });

  it('smoke-tests the *published stable* advisorily, and the upgrade strictly', () => {
    // The ratchet this prevents: the pre-upgrade smoke runs the current script
    // against a build that shipped before those assertions existed, so every new
    // smoke test turns this job red until the next stable release — and fails on
    // an artifact already on the registry, which nobody can fix. Seen on
    // v0.2.0-beta.6, where `latest` (0.1.0) predates `--help`/`--version`.
    const text = rc();
    const job = text.slice(text.indexOf('  smoke-upgrade:'), text.indexOf('  promote-release:'));
    const advisory = job.indexOf('Smoke test the stable version');
    const strict = job.indexOf('Smoke test the beta version');
    expect(advisory).toBeGreaterThan(-1);
    expect(strict).toBeGreaterThan(advisory);
    // The stable half tolerates failure...
    expect(job.slice(advisory, strict)).toContain('continue-on-error: true');
    // ...and the beta half, which is the claim the job actually makes, does not.
    expect(job.slice(strict)).not.toContain('continue-on-error');
  });

  it('installs the exact published version, not a floating tag', () => {
    // Installing `@beta` would smoke-test whatever the tag happened to point at,
    // which on a re-run is a *different* build than the one just published.
    const step = installStep();
    expect(step).toContain('newsmonger@$VERSION');
    expect(step).not.toMatch(/npm install -g newsmonger@beta\b/);
  });
});

describe('the notarization watcher (NEWS-197)', () => {
  const script = path.join(root, 'scripts/notary-watch.sh');

  /** Run a subcommand with a stubbed `xcrun` on PATH and a scratch state dir. */
  function run(
    args: string[],
    opts: { credentials?: boolean; stub?: boolean; stateDir?: string } = {},
  ): { status: number; output: string; stateDir: string } {
    const stateDir = opts.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-notary-'));
    const binDir = path.join(stateDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    if (opts.stub !== false) {
      // Shaped like Apple's `--output-format json`, with the newest first — the
      // ordering the submission-id lookup depends on.
      fs.writeFileSync(
        path.join(binDir, 'xcrun'),
        [
          '#!/usr/bin/env bash',
          'if [[ "$1" == "notarytool" && "$2" == "history" ]]; then',
          '  echo \'{"history":[{"id":"newest-id","createdDate":"2026-07-31T04:00:00Z","status":"In Progress"},{"id":"older-id","createdDate":"2026-07-31T03:00:00Z","status":"Accepted"}]}\'',
          '  exit 0',
          'fi',
          'if [[ "$1" == "notarytool" && "$2" == "log" ]]; then echo "log-for:$3"; exit 0; fi',
          'exit 1',
        ].join('\n'),
        { mode: 0o755 },
      );
    }
    const credentials = opts.credentials !== false;
    try {
      const stdout = execFileSync('bash', [script, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
          RUNNER_TEMP: stateDir,
          NOTARY_WATCH_INTERVAL: '1',
          ...(credentials
            ? { APPLE_ID: 'a@b.c', APPLE_PASSWORD: 'app-specific-pw', APPLE_TEAM_ID: 'TEAMID' }
            : { APPLE_ID: '', APPLE_PASSWORD: '', APPLE_TEAM_ID: '' }),
        },
      });
      return { status: 0, output: stdout, stateDir };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}`, stateDir };
    }
  }

  /**
   * Wait for the poller's first line rather than sleeping a fixed interval.
   *
   * A fixed `setTimeout` was flaky: the poller sleeps one second *before* its
   * first poll, and under a loaded parallel suite that lands past the deadline.
   * Polling for the condition keeps the test fast when the machine is idle and
   * correct when it is not.
   *
   * **It throws when the deadline passes** (NEWS-323), which it did not, and the
   * omission cost an investigation. It used to fall out of the loop and return
   * *normally*, so a machine too loaded to produce the log line in time reported
   * a successful wait — and the caller then failed on its timestamp-format
   * assertion, blaming the format for a timeout. The error named an assertion
   * three lines from the actual cause.
   *
   * A bounded wait that cannot fail is worse than no wait at all: it converts a
   * legible timeout into an arbitrary downstream failure, and which assertion
   * takes the blame depends on what the caller happens to check first.
   *
   * The timeout is generous rather than tight for the same reason the loop
   * exists. This spawns a bash script that sleeps a second before its first
   * poll, and the unit suite shares a machine with whatever else is running —
   * when this was hit, that was a browser. Waiting is condition-based, so a
   * longer ceiling costs an idle machine nothing and buys patience on a busy one.
   */
  async function waitForPoll(stateDir: string, timeoutMs = 45_000): Promise<void> {
    const log = path.join(stateDir, 'notary-watch.log');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('recent submissions')) return;
      if (Date.now() >= deadline) {
        // What was actually there, so the next reader does not have to re-run it
        // to learn whether the poller wrote nothing or wrote something else.
        const seen = fs.existsSync(log) ? JSON.stringify(fs.readFileSync(log, 'utf8').slice(0, 400)) : '(no log file)';
        throw new Error(
          `waitForPoll: notary-watch.log never said "recent submissions" within ${String(timeoutMs)}ms. Saw: ${seen}`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it('waitForPoll fails loudly rather than pretending it waited (NEWS-323)', async () => {
    // A test for a test helper, which is unusual and earned: this helper's whole
    // job is to fail when the condition never arrives, it silently did the
    // opposite for as long as it existed, and nothing about the tests that use
    // it could have revealed that — they just failed somewhere else.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-waitpoll-'));
    try {
      await expect(waitForPoll(empty, 200)).rejects.toThrow(/never said "recent submissions"/);
      // And it says what it found, so a real timeout is diagnosable from the
      // failure alone rather than by re-running it.
      await expect(waitForPoll(empty, 200)).rejects.toThrow(/no log file/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('records what the queue was doing, with timestamps', async () => {
    // The whole point: Tauri prints one "Notarizing …" line and then nothing, so
    // a 1h38m wait and a hung process look identical while they are happening.
    const { stateDir } = run(['start']);
    await waitForPoll(stateDir);
    const { output } = run(['report'], { stateDir });
    expect(output).toContain('In Progress');
    expect(output).toContain('newest-id');
    expect(output, 'each poll should be timestamped').toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
  });

  it('stops the poller when it reports, so it cannot outlive the job', async () => {
    const { stateDir } = run(['start']);
    await waitForPoll(stateDir);
    run(['report'], { stateDir });
    expect(fs.existsSync(path.join(stateDir, 'notary-watch.pid'))).toBe(false);
  });

  it('names the newest submission and fetches Apple’s log for it', () => {
    // Every past diagnosis here depended on the submission id, and it was only
    // recoverable by grepping an error string out of the raw job log.
    const { output } = run(['history']);
    expect(output).toContain('newest-id');
    expect(output).toContain('log-for:newest-id');
    expect(output, 'the newest submission is the one being built, not an older one').not.toContain('log-for:older-id');
  });

  it('is a silent no-op without credentials, rather than a failed release', () => {
    // An unsigned build passes no APPLE_* secrets. A diagnostic that fails the
    // job obscures the failure it exists to explain (NEWS-194).
    for (const sub of ['start', 'history', 'report']) {
      const { status } = run([sub], { credentials: false });
      expect(status, `${sub} should exit 0 without credentials`).toBe(0);
    }
  });

  it('never echoes the app-specific password', () => {
    // It is passed on argv because notarytool has no stdin form; that is a
    // deliberate, bounded exposure and must not become an exposure in the log.
    const { output } = run(['history']);
    expect(output).not.toContain('app-specific-pw');
  });

  it('rejects an unknown subcommand instead of doing something surprising', () => {
    expect(run(['bogus']).status).toBe(2);
  });
});

describe('the release workflows keep their notarization diagnostics (NEWS-197)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
  const WORKFLOWS = ['.github/workflows/release-desktop.yml', '.github/workflows/release-candidate.yml'];

  it.each(WORKFLOWS)('%s watches, reports and dumps history', (rel) => {
    // These were added by NEWS-194 to `release.yml` and **lost** when NEWS-201
    // replaced that file — nothing failed, so nothing noticed. That is the whole
    // reason this is pinned: a workflow port drops steps silently.
    const src = read(rel);
    for (const sub of ['notary-watch.sh start', 'notary-watch.sh report', 'notary-watch.sh history']) {
      expect(src, `${rel} should call ${sub}`).toContain(sub);
    }
    expect(src, 'the history dump must run on failure').toMatch(/if: failure\(\) && runner\.os == 'macOS'/);
    expect(src, 'the report must run even on a timeout').toMatch(/if: always\(\) && runner\.os == 'macOS'/);
  });

  it.each(WORKFLOWS)('%s caps the signing job well short of the 360-minute default', (rel) => {
    // NEWS-194 set 120 because a 60-minute cap killed a build waiting legitimately.
    // Losing it does not fail anything — it just lets a stalled submission burn
    // six hours on two macOS runners at 10x billing.
    expect(read(rel)).toContain('timeout-minutes: 120');
  });
});

describe('the released-dmg check tests what a user meets (NEWS-21)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
  const script = (): string => read('scripts/verify-released-dmg.sh');

  it('sets the quarantine attribute before assessing anything', () => {
    // Without `com.apple.quarantine` **every check in the script is theatre**:
    // Gatekeeper only assesses files carrying it, so `spctl` would accept things
    // it rejects in a real Downloads folder and the script would pass on a
    // release nobody could open. The ordering matters as much as the presence —
    // quarantining after the assessment proves nothing.
    // Comment lines stripped: the header *explains* spctl several paragraphs
    // before the code runs it, so an ordering check against the raw text
    // compares against prose and fails on a correct script.
    const code = script()
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).toContain('xattr -w com.apple.quarantine');
    expect(
      code.indexOf('xattr -w com.apple.quarantine'),
      'the file must be quarantined before spctl assesses it',
      // `spctl -a`, the invocation — the bare word also appears inside the
      // platform-guard's error message, which is not an assessment.
    ).toBeLessThan(code.indexOf('spctl -a'));
  });

  it('checks the dragged-out copy, not just the mounted volume', () => {
    // Nobody runs an app from the disk image. The copy is what inherits
    // quarantine and what actually gets launched.
    const src = script();
    expect(src).toMatch(/cp -R/);
    expect(src).toContain('still accepted once installed');
  });

  it('requires the assessment to say Notarized, not merely "accepted"', () => {
    // `spctl` accepts plenty of things for reasons other than notarization, so
    // matching on the source string is what makes this a notarization check.
    expect(script()).toContain('source=Notarized Developer ID');
  });

  it('runs the sidecar rather than only reading its entitlements', () => {
    // The failure this exists for — a bundle that signs, notarizes and staples
    // cleanly and then dies at launch on someone else's Mac — is invisible to
    // every static check. Only executing it under the hardened runtime shows it.
    const src = script();
    expect(src).toContain('--version');
    expect(src, 'a hot loop, so V8 actually reaches the optimizing compiler').toMatch(/i<3e7/);
    expect(src).toContain('jit-ok');
  });

  it('fails the run when any check fails', () => {
    // A verification script that always exits 0 is worse than none: it is a
    // green light nobody earned.
    const src = script();
    expect(src).toMatch(/fail=1/);
    expect(src).toMatch(/exit "\$fail"/);
  });
});

describe('the notarization safeguards are on the job that needs them (NEWS-234)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
  const WORKFLOWS = ['.github/workflows/release-desktop.yml', '.github/workflows/release-candidate.yml'];

  /**
   * One job's YAML block, by name.
   *
   * The NEWS-197 tests above assert these same things with a whole-file
   * `toContain`, which is weaker than it looks: it passes as long as *some* job
   * in the file carries the cap or the watcher. Moving `timeout-minutes` off the
   * signing job onto, say, the lint job would keep every one of them green while
   * restoring exactly the failure this ticket is about — a stalled submission
   * burning six hours on two macOS runners at 10x billing. Scoping to the job is
   * the difference between "the string is in the file" and "the safeguard is on
   * the thing it protects".
   */
  function job(src: string, name: string): string {
    const jobs = src.slice(src.indexOf('\njobs:\n'));
    const start = jobs.indexOf(`\n  ${name}:\n`);
    expect(start, `job "${name}" should exist`).toBeGreaterThan(-1);
    const rest = jobs.slice(start + 1);
    const next = /\n {2}[a-z][a-z0-9-]*:\n/.exec(rest.slice(1));
    return next ? rest.slice(0, next.index + 1) : rest;
  }

  it.each(WORKFLOWS)('%s caps the *signing* job, not merely some job', (rel) => {
    const signing = job(read(rel), 'build');
    expect(signing).toMatch(/timeout-minutes: \d+/);
    const minutes = Number(/timeout-minutes: (\d+)/.exec(signing)?.[1]);
    // Above Apple's plausible worst case — a 60-minute cap once killed a build
    // that was waiting legitimately (NEWS-194) — and well under GitHub's
    // 360-minute default, which is what actually got burned before this existed.
    expect(minutes).toBeGreaterThanOrEqual(90);
    expect(minutes).toBeLessThan(360);
  });

  it.each(WORKFLOWS)('%s watches and reports the queue from the signing job', (rel) => {
    const signing = job(read(rel), 'build');
    expect(signing, 'the watcher must start in the signing job').toContain('notary-watch.sh start');
    expect(signing, 'the report must be in the signing job').toContain('notary-watch.sh report');

    // The report is only ever useful when the build failed, so a condition that
    // skips it on failure deletes the diagnosis at precisely the moment it is
    // needed. This is how v0.2.0-beta.6 was diagnosed at all: 95 consecutive
    // "In Progress" observations, from a job that had already failed.
    const report = signing.slice(signing.indexOf('notary-watch.sh report') - 400);
    expect(report).toMatch(/if: always\(\)/);
  });

  it.each(WORKFLOWS)('%s keeps the queue report from masking the real failure', (rel) => {
    // `continue-on-error` on the report step: a watcher that itself errors must
    // not turn a notarization failure into a *reporting* failure, which would
    // point at the wrong thing entirely.
    const signing = job(read(rel), 'build');
    const around = signing.slice(
      Math.max(0, signing.indexOf('notary-watch.sh report') - 400),
      signing.indexOf('notary-watch.sh report'),
    );
    expect(around).toContain('continue-on-error: true');
  });
});

describe('the Windows diagnostic workflow stays a diagnostic (NEWS-238)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
  const FILE = '.github/workflows/windows-e2e-diagnostic.yml';

  it('exists and runs only when asked', () => {
    // On-demand only. A diagnostic that fires on push becomes a check people
    // start ignoring, and this one is *expected* to go red — that is its job.
    const src = read(FILE);
    expect(src).toContain('workflow_dispatch:');
    expect(src, 'must not run on push').not.toMatch(/^\s{2}push:/m);
    expect(src, 'must not run on a schedule').not.toMatch(/^\s{2}schedule:/m);
  });

  it('is referenced by no other workflow', () => {
    // Nothing may come to depend on it. The moment something does, a red
    // diagnostic starts blocking real work, which is the opposite of the point.
    for (const wf of fs.readdirSync(path.join(root, '.github/workflows'))) {
      if (wf === path.basename(FILE)) continue;
      const other = read(`.github/workflows/${wf}`);
      expect(other, `${wf} should not reference the diagnostic`).not.toContain('windows-e2e-diagnostic');
    }
  });

  it('defaults to no retries, so the first-attempt failure rate is visible', () => {
    // Retries are what let this bug pass as "one flaky test" for two releases:
    // a test that fails then passes reports the suite green. The diagnostic
    // exists to count first attempts.
    const src = read(FILE);
    const retries = /description: 'Playwright retries[^']*'\s+type: choice\s+default: '(\d)'/.exec(src);
    expect(retries?.[1], 'retries should default to 0').toBe('0');
  });

  it('keeps artifacts from passing runs too', () => {
    // `always()`, not `failure()`. A green run's console is the baseline the red
    // one is read against, and this failure only shows up by comparison.
    const src = read(FILE);
    const upload = src.slice(src.indexOf('Upload report, traces and console'));
    expect(upload).toContain('if: always()');
  });

  it('does not stop early when one attempt fails', () => {
    // The output is a *rate*. `fail-fast` would cancel the remaining samples the
    // moment the first one failed, which is precisely the data being collected.
    expect(read(FILE)).toContain('fail-fast: false');
  });
});

describe('advisory jobs cannot silently stop gating a release (NEWS-234)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
  const WORKFLOWS = [
    '.github/workflows/release-desktop.yml',
    '.github/workflows/release-candidate.yml',
    '.github/workflows/ci.yml',
  ];

  it.each(WORKFLOWS)('%s: no job another job depends on is continue-on-error', (rel) => {
    // The trap, met for real while reading v0.2.0-beta.6: a job with
    // `continue-on-error: true` reports a **green conclusion even when its steps
    // fail**. As a standalone signal that is fine and intended (test-e2e-windows
    // is deliberately advisory). As a dependency it is poison: everything
    // downstream proceeds on a check that cannot fail, and the badge says
    // success. Nothing in GitHub warns about this.
    const src = read(rel);
    const jobs = src.slice(src.indexOf('\njobs:\n'));
    const names = [...jobs.matchAll(/\n {2}([a-z][a-z0-9-]*):\n/g)].map((m) => m[1]);
    // A floor, not a claim about how many jobs there are — it exists so a regex
    // that stopped matching fails here rather than vacuously passing below.
    expect(names.length, 'should have parsed some job names').toBeGreaterThanOrEqual(2);

    const advisory = names.filter((n) => {
      const start = jobs.indexOf(`\n  ${n}:\n`);
      const rest = jobs.slice(start + 1);
      const next = /\n {2}[a-z][a-z0-9-]*:\n/.exec(rest.slice(1));
      const body = next ? rest.slice(0, next.index + 1) : rest;
      // Job-level only: `continue-on-error` on a *step* is a different thing and
      // is used deliberately (the advisory smoke of an already-published build).
      return /\n {4}continue-on-error: true/.test(body);
    });

    for (const name of advisory) {
      // `needs: [a, b]` and `needs: a` both.
      const referenced = [...src.matchAll(/needs:\s*(\[[^\]]*\]|[a-z][a-z0-9-]*)/g)]
        .map((m) => m[1])
        .some((n) => n.split(/[[\],\s]+/).filter(Boolean).includes(name));
      expect(referenced, `"${name}" is advisory but something needs it — it cannot gate anything`).toBe(
        false,
      );
    }
  });
});

describe('the signing gate is actually wired into the release (NEWS-220)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
  const WORKFLOWS = ['.github/workflows/release-desktop.yml', '.github/workflows/release-candidate.yml'];

  it.each(WORKFLOWS)('%s runs verify-signing.sh on the macOS shards', (rel) => {
    // FR-5.7 asserts on the build machine what Gatekeeper decides on someone
    // else's. The old `release.yml` ran it before publishing; the NEWS-201 port
    // dropped it, and nothing went red — signed releases published without the
    // check for the whole window. That silence is why this is pinned.
    const src = read(rel);
    expect(src, `${rel} should run the signing gate`).toContain('scripts/verify-signing.sh');
    expect(src).toContain('Verify the bundle is distributable');
  });

  it.each(WORKFLOWS)('%s lets the signing gate fail the job', (rel) => {
    // The diagnostics around it are `continue-on-error` on purpose; this must not
    // be. Every property it checks can be wrong while the build is green, and the
    // symptom is a user who cannot open the app.
    //
    // Comments are stripped first, as elsewhere in this file: these workflows are
    // heavily commented *about* the very strings being asserted, and the next
    // step's explanation of why *it* is `continue-on-error` sits between this
    // step and the following `- name:`.
    const src = read(rel)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    const step = src.slice(src.indexOf('Verify the bundle is distributable'));
    const nextStep = step.indexOf('\n      - name:');
    const body = nextStep === -1 ? step : step.slice(0, nextStep);
    expect(body, 'the signing gate must not be continue-on-error').not.toContain('continue-on-error');
  });

  it('discovers the bundle in both layouts, since CI builds with an explicit target', () => {
    // `tauri-action` passes `--target`, which cargo puts under
    // `target/<triple>/release/bundle/`; a local build writes
    // `target/release/bundle/`. A path that only matches one would "pass" in CI
    // by finding nothing — the exact failure this gate exists to prevent.
    const src = read('scripts/verify-signing.sh');
    expect(src).toContain("-path '*/release/bundle/macos/*'");
    // The depth limit has to clear the triple'd layout, which is one deeper.
    const depth = /-maxdepth (\d+)/.exec(src)?.[1];
    expect(Number(depth ?? 0), 'maxdepth must reach <triple>/release/bundle/macos/X.app').toBeGreaterThanOrEqual(6);
  });

  it('derives the dmg directory from the bundle rather than hardcoding it', () => {
    // Notarizing the app does not notarize the disk image it ships in, so the
    // .dmg needs its own stapled ticket — and a hardcoded dmg path would silently
    // stop matching the moment the app path moved under a target triple.
    const src = read('scripts/verify-signing.sh');
    expect(src).toMatch(/DMG_DIR="\$\(dirname "\$\(dirname "\$APP"\)"\)\/dmg"/);
  });
});

describe('the tag-vs-config version guard (NEWS-208)', () => {
  const script = path.join(root, 'scripts/check-tag-version.sh');
  let sandbox: string;

  /** Run the guard in a sandbox whose two version files say `version`. */
  function check(tag: string | null, version = '1.2.3'): { status: number; output: string } {
    fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'newsmonger', version }));
    fs.writeFileSync(path.join(sandbox, 'src-tauri/tauri.conf.json'), JSON.stringify({ version }));
    try {
      const stdout = execFileSync('bash', [path.join(sandbox, 'scripts/check-tag-version.sh'), ...(tag === null ? [] : [tag])], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_REF: '' },
      });
      return { status: 0, output: stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  beforeEach(() => {
    // The script resolves the version files relative to its own location, so the
    // copy has to sit in a `scripts/` dir inside the sandbox — running the repo's
    // copy would read the repo's real files and pass for the wrong reason.
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-tagguard-'));
    fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'src-tauri'), { recursive: true });
    fs.copyFileSync(script, path.join(sandbox, 'scripts/check-tag-version.sh'));
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it.each(['v1.2.3', 'v1.2.3-rc.1', 'v1.2.3-beta.4', 'refs/tags/v1.2.3-beta.4', '1.2.3'])(
    'accepts %o against matching files',
    (tag) => {
      // Only the **base** is compared: the suffix lives on the tag and never in
      // the files. `release.sh` writes the clean X.Y.Z for *both* channels — betas
      // included (note 4 in its header) — and CI writes the suffixed version at
      // build time (NEWS-207).
      expect(check(tag).status, `${tag} should pass`).toBe(0);
    },
  );

  it('rejects a tag whose base does not match, and says which file disagrees', () => {
    // The bug it exists for: tag v0.2.0 against a 0.1.0 config and everything
    // succeeds — the release page looks right, and every asset is named 0.1.0
    // while the generated download links point at 0.2.0 filenames that do not
    // exist. Nothing else links the tag to the files.
    const { status, output } = check('v9.9.9');
    expect(status).toBe(1);
    expect(output).toContain('tauri.conf.json');
    expect(output).toContain('package.json');
    expect(output, 'should use an annotation so it surfaces in the run summary').toContain('::error::');
  });

  it('catches a mismatch in either file alone', () => {
    // Both are checked, not just the first: a version that lands in package.json
    // and misses tauri.conf.json ships a correctly-named npm package beside a
    // wrongly-named bundle.
    fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    fs.writeFileSync(path.join(sandbox, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '1.2.4' }));
    let out = '';
    try {
      execFileSync('bash', [path.join(sandbox, 'scripts/check-tag-version.sh'), 'v1.2.3'], { encoding: 'utf8' });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(out).toContain('tauri.conf.json (1.2.4)');
    expect(out, 'package.json matches, so it should not be blamed').not.toContain("does not match package.json");
  });

  it('exits distinctly when given no tag at all', () => {
    // 2, not 1: "nothing to check" is not "the versions disagree", and a workflow
    // that silently passed on an unset ref would be a guard in name only.
    expect(check(null).status).toBe(2);
  });
});

describe('the version guard is wired into both workflows (NEWS-208)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

  it('gates release-candidate.yml before anything expensive runs', () => {
    const src = read('.github/workflows/release-candidate.yml');
    expect(src).toContain('scripts/check-tag-version.sh');
    expect(src, 'it should be its own job so it can gate the others').toContain('version-guard:');
    // The point of a separate job: the 4-target Tauri build and the E2E run must
    // not start before a mismatched tag has been rejected.
    for (const m of src.matchAll(/needs: \[([^\]]*)\]/g)) {
      const needs = m[1];
      if (needs.includes('lint')) {
        expect(needs, `"${needs}" should also wait on version-guard`).toContain('version-guard');
      }
    }
  });

  it('gates release-desktop.yml in create-release, before the signed build', () => {
    // Earliest possible point: the release shell does not exist yet and the
    // ~20-minute signed build has not started.
    const src = read('.github/workflows/release-desktop.yml');
    const createRelease = src.slice(src.indexOf('create-release:'), src.indexOf('  build:'));
    expect(createRelease).toContain('scripts/check-tag-version.sh');
  });
});

describe('verify-signing.sh agrees with what CI actually produces (NEWS-221)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

  it('does not fail a release over an unstapled dmg, which CI deliberately does not staple', () => {
    // The contradiction this pins: NEWS-200 (3e984c8) removed dmg stapling from
    // CI on the evidence that the app inside is stapled and Gatekeeper assesses
    // the *app*. NEWS-220 then made verify-signing.sh a blocking gate — and the
    // script still called an unstapled dmg fatal. Every macOS shard of every
    // signed release would have failed, leaving the release a permanent draft.
    //
    // Neither change was wrong alone; they were incompatible, and nothing
    // connected them. Hence a test that reads both sides.
    const src = read('scripts/verify-signing.sh');
    const dmgSection = src.slice(src.indexOf('# --- 7. The DMG'));
    expect(dmgSection, 'the dmg staple must be informational, not fatal').not.toMatch(/bad "dmg is not stapled/);
    expect(dmgSection).toMatch(/note "dmg is not stapled/);

    // The app's own staple is the one that matters, and stays fatal.
    expect(src).toMatch(/bad "no stapled ticket/);
  });

  it('is consistent with the workflows, which staple nothing', () => {
    // If a future change re-adds dmg stapling to CI, this test should be revisited
    // together with the check above — that is the pairing that broke.
    for (const rel of ['.github/workflows/release-desktop.yml', '.github/workflows/release-candidate.yml']) {
      const src = read(rel)
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
      expect(src, `${rel} does not staple, so the check must not require it`).not.toContain('stapler staple');
    }
  });
});

describe('a prerelease tag cannot publish as stable (NEWS-222)', () => {
  const script = path.join(root, 'scripts/check-tag-version.sh');
  let sandbox: string;

  function check(args: string[], version = '1.2.3'): { status: number; output: string } {
    fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ version }));
    fs.writeFileSync(path.join(sandbox, 'src-tauri/tauri.conf.json'), JSON.stringify({ version }));
    try {
      const stdout = execFileSync('bash', [path.join(sandbox, 'scripts/check-tag-version.sh'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_REF: '' },
      });
      return { status: 0, output: stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-stableonly-'));
    fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'src-tauri'), { recursive: true });
    fs.copyFileSync(script, path.join(sandbox, 'scripts/check-tag-version.sh'));
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it.each(['v1.2.3-alpha.1', 'v1.2.3-rc1', 'v1.2.3-pre', 'v1.2.3-next.1', 'v1.2.3-beta1'])(
    'refuses %o under --stable-only',
    (tag) => {
      // Each of these matches release-desktop.yml's `v[0-9]*` filter and is NOT
      // caught by `!v*-rc.*` / `!v*-beta.*`, so it would publish as stable with
      // `make_latest: true`. The updater reads releases/latest, so it would reach
      // every installed user. `-rc1` is the one to worry about: it is `-rc.1` with
      // the dot missed.
      const { status, output } = check(['--stable-only', tag]);
      expect(status, `${tag} must not be publishable as stable`).toBe(1);
      expect(output).toContain('::error::');
    },
  );

  it('still accepts a clean stable tag', () => {
    expect(check(['--stable-only', 'v1.2.3']).status).toBe(0);
  });

  it('does not refuse prerelease tags without the flag, since the rc/beta workflow wants them', () => {
    expect(check(['v1.2.3-beta.1']).status).toBe(0);
    expect(check(['v1.2.3-rc.1']).status).toBe(0);
  });

  it('takes the flag in either argument position', () => {
    expect(check(['v1.2.3', '--stable-only']).status).toBe(0);
    expect(check(['v1.2.3-alpha.1', '--stable-only']).status).toBe(1);
  });

  it('is actually passed --stable-only by the stable workflow, and not by the rc/beta one', () => {
    const desktop = fs.readFileSync(path.join(root, '.github/workflows/release-desktop.yml'), 'utf8');
    expect(desktop, 'release-desktop.yml publishes as latest, so it must refuse prereleases').toContain(
      'check-tag-version.sh --stable-only',
    );
    const rc = fs.readFileSync(path.join(root, '.github/workflows/release-candidate.yml'), 'utf8');
    expect(rc, 'release-candidate.yml exists to publish prereleases').not.toContain('--stable-only');
  });
});

describe('the stable release builds the tag, not whatever main is now (NEWS-223)', () => {
  const src = (): string => fs.readFileSync(path.join(root, '.github/workflows/release-desktop.yml'), 'utf8');

  it('pins every checkout to the tag being released', () => {
    // On `workflow_dispatch` a bare checkout takes the **workflow ref** (`main`)
    // while `tagName` and the release name come from `inputs.tag`. If main has
    // moved past the tag, the release for vX.Y.Z contains bundles built from a
    // different commit — silently. It is correct today only because
    // `promote-release` dispatches immediately after pushing the tag from main's
    // HEAD, and nothing enforces that ordering.
    const checkouts = src().match(/- uses: actions\/checkout@v\d+\n(?:\s+with:\n\s+ref: [^\n]+\n)?/g) ?? [];
    expect(checkouts.length, 'expected the create-release, build and rename-assets checkouts').toBeGreaterThanOrEqual(3);
    for (const c of checkouts) {
      expect(c, `a bare checkout would build main on dispatch:\n${c}`).toContain('ref:');
    }
  });

  it('resolves that ref from the dispatch input, falling back to the pushed ref', () => {
    // `inputs.tag` is empty on a tag push, so the fallback is what makes the same
    // expression correct on both triggers.
    expect(src()).toContain('ref: ${{ inputs.tag || github.ref }}');
  });

  it('keeps the version guard meaningful on the dispatch path', () => {
    // Without a pinned ref the guard compared inputs.tag against *main's* version
    // files, so it would pass on exactly the mismatch it exists to catch. The two
    // changes are load-bearing together, which is why this is asserted here.
    const s = src();
    const createRelease = s.slice(s.indexOf('create-release:'), s.indexOf('  build:'));
    expect(createRelease).toContain('ref: ${{ inputs.tag || github.ref }}');
    expect(createRelease).toContain('check-tag-version.sh');
    expect(
      createRelease.indexOf('ref: ${{ inputs.tag || github.ref }}'),
      'the checkout must be pinned before the guard reads the files',
    ).toBeLessThan(createRelease.indexOf('check-tag-version.sh'));
  });
});

describe('the stable release path is gated too (NEWS-224)', () => {
  const src = (): string => fs.readFileSync(path.join(root, '.github/workflows/release-desktop.yml'), 'utf8');

  it('runs typecheck, lint and unit tests before anything is created or built', () => {
    // The old release.yml ran exactly these, stating why: "so a release can't
    // publish something that doesn't even compile." The NEWS-201 port left them
    // only on release-candidate.yml, so a hand-pushed tag or a workflow_dispatch
    // — both documented as supported — published with no gating at all.
    const s = src();
    expect(s).toContain('gates:');
    for (const cmd of ['npm run typecheck', 'npm run lint', 'npm test']) {
      expect(s, `the stable path should run ${cmd}`).toContain(cmd);
    }
    // Same trap as everywhere else: several suites fetch /static/... and 404
    // without dist/client.
    const gates = s.slice(s.indexOf('gates:'), s.indexOf('create-release:'));
    expect(gates.indexOf('npm run build:client'), 'build:client must precede npm test').toBeLessThan(
      gates.indexOf('npm test'),
    );
  });

  it('makes create-release wait on the gates, so a broken commit opens no draft', () => {
    expect(src()).toMatch(/create-release:\n\s+needs: \[gates\]/);
  });

  it('gates the same commit it releases', () => {
    // Interacts with NEWS-223: unpinned, the gates would run against main while
    // the bundles came from the tag — gating the wrong thing and reporting green.
    const s = src();
    const gates = s.slice(s.indexOf('gates:'), s.indexOf('create-release:'));
    expect(gates).toContain('ref: ${{ inputs.tag || github.ref }}');
  });
});

describe('release runs keep their evidence and do not cancel each other (NEWS-225)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
  const WORKFLOWS = ['.github/workflows/release-desktop.yml', '.github/workflows/release-candidate.yml'];

  it.each(WORKFLOWS)('%s uploads the bundle even when the build fails', (rel) => {
    // The bundle is the evidence when signing or notarization goes wrong, and
    // another copy costs another Apple round trip — 5 to 60 minutes, or hours if
    // the queue stalls. Without `always()` the upload is skipped on exactly the
    // runs that need it, which is how the old file justified the same line.
    const src = read(rel);
    const idx = src.indexOf('Upload the built bundle');
    expect(idx, `${rel} should keep the bundle on failure`).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 400)).toContain('if: always()');
  });

  it.each(WORKFLOWS)('%s never cancels a release run in progress', (rel) => {
    // Cancelling is right for branch CI and wrong for a release: a run cancelled
    // mid-notarization abandons an in-flight Apple submission and can strand a
    // draft holding a partial set of assets. The old release.yml set this to
    // false deliberately; the port flipped one to true and dropped the other.
    const src = read(rel);
    expect(src, `${rel} needs a concurrency group`).toContain('concurrency:');
    expect(src).toContain('cancel-in-progress: false');
    expect(src, 'cancelling a release is never what you want').not.toContain('cancel-in-progress: true');
  });

  it.each(WORKFLOWS)('%s caps every job that builds a bundle', (rel) => {
    // An uncapped matrix inherits GitHub's 360-minute default, which is a lot of
    // macOS runner time to spend on a hang.
    const src = read(rel);
    const jobsWithTauri = src.split('\n  ').filter((chunk) => chunk.includes('tauri-action'));
    expect(jobsWithTauri.length, `${rel} should build with tauri-action`).toBeGreaterThan(0);
    expect(src).toContain('timeout-minutes:');
  });

  it.each(WORKFLOWS)('%s caches Rust for the bundle builds', (rel) => {
    // Cost, not correctness: these matrices were compiling Rust cold on the most
    // expensive runners. The cache survived only on the Rust lint job.
    expect(read(rel)).toContain('Swatinem/rust-cache@v2');
  });
});

describe('the signing secrets are the ones Tauri actually reads (NEWS-225)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

  it('does not ask for a KEYCHAIN_PASSWORD, which Tauri generates itself', () => {
    // The docs listed it as required for months and the workflows never set it —
    // a discrepancy about a signing credential that nobody had resolved.
    // Checked against the source: `tauri-action` has no signing code at all, and
    // the v2 bundler generates the temporary keychain's name AND password as
    // random 16-char strings per build (crates/tauri-macos-sign/src/keychain.rs).
    // v1 used a hardcoded constant. It has never been a Tauri variable.
    for (const rel of ['.github/workflows/release-desktop.yml', '.github/workflows/release-candidate.yml']) {
      expect(read(rel), `${rel} should not set KEYCHAIN_PASSWORD`).not.toContain('KEYCHAIN_PASSWORD');
    }
    // The doc may name it once, in the note explaining why it is absent.
    const doc = read('docs/5-desktop-app.md');
    expect(doc.match(/KEYCHAIN_PASSWORD/g) ?? []).toHaveLength(1);
    expect(doc, 'the note should say Tauri generates it').toContain('deliberately no `KEYCHAIN_PASSWORD`');
  });

  it('sets the six Apple variables the bundler does read', () => {
    for (const rel of ['.github/workflows/release-desktop.yml', '.github/workflows/release-candidate.yml']) {
      const src = read(rel);
      for (const v of [
        'APPLE_CERTIFICATE',
        'APPLE_CERTIFICATE_PASSWORD',
        'APPLE_SIGNING_IDENTITY',
        'APPLE_ID',
        'APPLE_PASSWORD',
        'APPLE_TEAM_ID',
      ]) {
        expect(src, `${rel} is missing ${v}`).toContain(v);
      }
    }
  });
});

describe('a dry run is structurally incapable of publishing (NEWS-223)', () => {
  const src = (): string => fs.readFileSync(path.join(root, '.github/workflows/release-desktop.yml'), 'utf8');

  /** The `tauri-action` step that runs on a dry run, comments stripped. */
  const dryRunStep = (): string => {
    const s = src()
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    const start = s.indexOf('Build Tauri app (dry run');
    expect(start, 'the dry-run build step should exist').toBeGreaterThan(-1);
    const next = s.indexOf('\n      - name:', start);
    return next === -1 ? s.slice(start) : s.slice(start, next);
  };

  it('offers a dry_run input, and no longer demands a tag', () => {
    // The old release.yml got this structurally: "a manual run is always a dry
    // run, so there is no way to publish from a branch." The NEWS-201 port added
    // a required tag and no guard, so a manual dispatch published for real.
    const s = src();
    expect(s).toContain('dry_run:');
    const tagInput = s.slice(s.indexOf('      tag:'), s.indexOf('dry_run:'));
    expect(tagInput, 'a dry run may have no tag at all').toContain('required: false');
  });

  it('passes neither tagName nor releaseId on the dry-run build', () => {
    // Read from tauri-action's source: with neither set it builds and skips all
    // uploads — but `tagName` set WITHOUT `releaseId` calls getOrCreateRelease
    // and *publishes*. A dry run that only blanked releaseId would ship.
    const step = dryRunStep();
    expect(step, 'tagName would create a release').not.toContain('tagName');
    expect(step).not.toContain('releaseId');
    expect(step, 'it still has to actually build').toContain('args:');
  });

  it('withholds GITHUB_TOKEN from the dry-run build, which is the hard lock', () => {
    // create-release.ts and upload-release-assets.ts both throw without it, so
    // this step cannot touch a release even if the inputs above regressed.
    expect(dryRunStep()).not.toContain('GITHUB_TOKEN');
  });

  it('still signs and notarizes on a dry run — that is the point of it', () => {
    const step = dryRunStep();
    for (const v of ['APPLE_CERTIFICATE', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_TEAM_ID']) {
      expect(step, `a dry run should still exercise ${v}`).toContain(v);
    }
  });

  it('skips every job that could publish', () => {
    const s = src();
    for (const job of ['create-release', 'rename-assets', 'publish-release']) {
      const start = s.indexOf(`\n  ${job}:`);
      expect(start, `${job} should exist`).toBeGreaterThan(-1);
      const body = s.slice(start, s.indexOf('\n    steps:', start));
      expect(body, `${job} must not run on a dry run`).toContain('!inputs.dry_run');
    }
  });

  it('still builds when create-release is skipped, and still waits on the gates', () => {
    // `needs: [gates, create-release]` lists gates explicitly because it used to
    // reach build only *through* create-release — which a dry run skips. Without
    // it, a dry run would build ungated (NEWS-224).
    const s = src();
    const build = s.slice(s.indexOf('\n  build:'), s.indexOf('\n    steps:', s.indexOf('\n  build:')));
    expect(build).toContain('needs: [gates, create-release]');
    // True when a need is skipped, false when one failed — so a broken gate
    // still stops the build.
    expect(build).toContain('!failure() && !cancelled()');
  });
});

describe('the Windows E2E job gates a release (NEWS-209, promoted in NEWS-235)', () => {
  const rc = (): string => fs.readFileSync(path.join(root, '.github/workflows/release-candidate.yml'), 'utf8');

  it('runs the suite on a Windows runner', () => {
    const src = rc();
    expect(src).toContain('test-e2e-windows:');
    const job = src.slice(src.indexOf('test-e2e-windows:'), src.indexOf('\n  npm-pack:'));
    expect(job).toContain('runs-on: windows-latest');
    expect(job).toContain('npm run test:e2e');
  });

  it('does not install Linux system deps on a Windows runner', () => {
    // `--with-deps` installs Linux libraries; on windows-latest it is a no-op at
    // best and a confusing failure at worst.
    const src = rc();
    const job = src.slice(src.indexOf('test-e2e-windows:'), src.indexOf('\n  npm-pack:'));
    expect(job).toContain('npx playwright install chromium');
    expect(job).not.toContain('--with-deps');
  });

  it('blocks a release when it fails', () => {
    // This asserted the exact opposite until NEWS-235. The job was advisory —
    // `continue-on-error`, absent from every `needs` — on the reasoning that a
    // job nobody expects to pass is a job nobody reads, and it had a different
    // flaky test on each run.
    //
    // Those flakes were not the runner. They were a real product bug (NEWS-238,
    // a `<select>` the user had touched no longer following the server) and a
    // suite exhausting a Windows runner's sockets (NEWS-246). Promoting is what
    // it earned by **10 consecutive clean first-attempt runs**, five per
    // platform, at `--retries=0` so nothing hid behind a retry.
    const src = rc();
    const job = src.slice(src.indexOf('test-e2e-windows:'), src.indexOf('\n  npm-pack:'));
    expect(job, 'a gate must not tolerate its own failure').not.toContain('continue-on-error');
  });

  it('gates the two jobs that actually publish', () => {
    // Being red is worth nothing if nothing waits on it. `create-release` and
    // `publish-beta` are the two that put something outside this repository, so
    // they are the two that have to depend on it.
    const src = rc();
    for (const name of ['create-release:', 'publish-beta:']) {
      const at = src.indexOf(`  ${name}`);
      expect(at, name).toBeGreaterThan(-1);
      const needs = /needs: \[([^\]]*)\]/.exec(src.slice(at))?.[1] ?? '';
      expect(needs, `${name} must wait for the Windows run`).toContain('test-e2e-windows');
    }
  });

  it('is capped, so a hang fails rather than burning the default 360 minutes', () => {
    const src = rc();
    const job = src.slice(src.indexOf('test-e2e-windows:'), src.indexOf('\n  npm-pack:'));
    expect(job).toMatch(/timeout-minutes: \d+/);
  });
});

describe('the Linux bundle diagnostic stays a diagnostic (NEWS-20)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
  const FILE = '.github/workflows/linux-bundle-diagnostic.yml';

  it('exists and runs only when asked', () => {
    // Same rule as the Windows one: a diagnostic that fires on push becomes a
    // check people learn to ignore, and this one installs a *published* bundle,
    // so it has nothing useful to say about an unreleased commit.
    const src = read(FILE);
    expect(src).toContain('workflow_dispatch:');
    expect(src, 'must not run on push').not.toMatch(/^\s{2}push:/m);
    expect(src, 'must not run on a schedule').not.toMatch(/^\s{2}schedule:/m);
  });

  it('is referenced by no other workflow', () => {
    for (const wf of fs.readdirSync(path.join(root, '.github/workflows'))) {
      if (wf === path.basename(FILE)) continue;
      expect(read(`.github/workflows/${wf}`), wf).not.toContain('linux-bundle-diagnostic');
    }
  });

  it('finds the app through the desktop entry, not by guessing a path', () => {
    // Twice the wrong binary: a hardcoded lowercase path, then the first
    // `/usr/bin/` entry — which is the *sidecar*, a Node binary that exits 0 in
    // silence and is indistinguishable from an app crashing. `Exec=` is how a
    // Linux desktop itself launches this, so it cannot disagree with reality.
    const src = read(FILE);
    expect(src).toMatch(/\.desktop\$/);
    expect(src).toContain("grep -m1 '^Exec='");
    expect(src, 'must not hardcode a binary path').not.toMatch(/APP=\/usr\/bin\/\w/);
  });

  it('installs the package rather than running the binary in place', () => {
    // The point of the ticket's step 4: resource resolution has to be exercised
    // from a real install location. Running the built binary would skip exactly
    // the thing that has never been tested.
    const src = read(FILE);
    expect(src).toContain('gh release download');
    expect(src).toMatch(/apt-get install -y \.\/bundle/);
  });

  it('quits by closing the window, not by killing the process', () => {
    // Killing it would prove nothing about whether the app cleans up after
    // itself — and the orphaned sidecar is one of the four things this ticket
    // asks about. Same trap noted for Windows in the manual test plan.
    const src = read(FILE);
    expect(src).toContain('windowclose');
    expect(src, 'a kill would void the orphan check').not.toMatch(/\bpkill -9|kill -9\b/);
    expect(src).toContain('pgrep -a newsmonger-node');
  });

  it('asserts the window is not blank, not merely that it exists', () => {
    // A dead webview still opens a window. "It launched" is the assertion that
    // would pass while the app was unusable.
    expect(read(FILE)).toMatch(/distinct colours|identify -format '%k'/);
  });
});
