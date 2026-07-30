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
    expect(smoke).toContain('newsmonger@${{ needs.publish-beta.outputs.version }}');
    expect(smoke).not.toContain('newsmonger@beta');
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

  it('does not assume --help exits zero', () => {
    // It does not: `--help` is an unrecognised flag, so it prints usage and exits 1.
    // Combined with `set -o pipefail`, `! cmd | grep -q .` reports "not runnable"
    // for a command that ran perfectly — which cost a debugging round.
    const sh = src();
    expect(sh).toContain('HELP_OUTPUT=$($NEWSMONGER --help 2>&1 || true)');
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
