import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * The Rust gates skip only when they provably cannot fail (NEWS-294).
 *
 * **Why this file is worth more than it looks.** A wrong answer from
 * `scripts/rust-changed.sh` does not produce a red test — it produces a *green*
 * one, with `cargo fmt --check` never run. That is exactly the failure this
 * project already had: `test:all` passed while a formatting violation sat in
 * `src-tauri/src/lib.rs`, and main was red for two commits before anyone opened
 * Actions. A skip decision has to be tested by something other than the gate it
 * is deciding about.
 *
 * So these tests drive the real scripts with a stubbed `git` — the same technique
 * `release-scripts.test.ts` uses to test `notary-watch.sh` against a stubbed
 * `xcrun` — and, for `gates-rust.sh`, a stubbed `cargo` that records whether it
 * was called at all.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The triple the `rustc` stub reports, so the sidecar stub is identifiable. */
const STUB_TRIPLE = 'unit-test-triple';

const stubSidecar = path.join(root, `src-tauri/binaries/newsmonger-node-${STUB_TRIPLE}`);
const stubResource = path.join(root, 'src-tauri/server/README');
const resourceExisted = fs.existsSync(stubResource);

afterEach(() => {
  // `ensure-sidecar-stub.sh` writes into the real (gitignored) bundle paths, so
  // clean up anything these tests caused it to create. Not the resource README if
  // it was already there — that one belongs to the developer's own build.
  fs.rmSync(stubSidecar, { force: true });
  if (!resourceExisted) fs.rmSync(stubResource, { force: true });
});

interface GitState {
  /** `git status --porcelain` output. */
  status?: string;
  /** Whether `git status` should fail outright. */
  statusFails?: boolean;
  /** The upstream branch name, or absent for "no upstream configured". */
  upstream?: string;
  /** `git diff --name-only <base> HEAD` output. */
  diff?: string;
  /** Whether the checkout should look like a git checkout at all. */
  isRepo?: boolean;
}

interface RunResult {
  status: number;
  output: string;
  /** Every `cargo` invocation, one per line, when cargo was stubbed. */
  cargo: string[];
}

/**
 * Run one of the scripts with `git` (and optionally `cargo`/`rustc`) stubbed.
 *
 * The stubs go on the front of `PATH` rather than replacing it: the scripts still
 * need the real `sed`, `grep` and `bash`.
 */
function run(script: string, git: GitState, env: Record<string, string> = {}, stubCargo = false): RunResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-rustgate-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const cargoLog = path.join(dir, 'cargo.log');

  fs.writeFileSync(
    path.join(bin, 'git'),
    [
      '#!/usr/bin/env bash',
      `if [ "$1 $2" = "rev-parse --git-dir" ]; then ${git.isRepo === false ? 'exit 128' : 'echo .git; exit 0'}; fi`,
      // Two statements, not one: `exit 128 printf …` is "too many arguments" to
      // bash's `exit`, which returns 1 *without exiting* — so the stub reported a
      // clean tree instead of a failure, and the test passed for the wrong reason.
      `if [ "$1" = "status" ]; then ${git.statusFails === true ? 'exit 128; ' : ''}printf '%s' "$STUB_STATUS"; exit 0; fi`,
      'if [ "$1" = "rev-parse" ]; then',
      '  if [ -n "$STUB_UPSTREAM" ]; then echo "$STUB_UPSTREAM"; exit 0; else exit 128; fi',
      'fi',
      'if [ "$1" = "merge-base" ]; then echo deadbeef; exit 0; fi',
      `if [ "$1" = "diff" ]; then printf '%s' "$STUB_DIFF"; exit 0; fi`,
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );

  if (stubCargo) {
    fs.writeFileSync(
      path.join(bin, 'cargo'),
      ['#!/usr/bin/env bash', `echo "$@" >> "${cargoLog}"`, 'exit 0'].join('\n'),
      { mode: 0o755 },
    );
    // So `ensure-sidecar-stub.sh` can resolve a triple on a machine (or a CI
    // runner) with no Rust toolchain at all.
    fs.writeFileSync(path.join(bin, 'rustc'), ['#!/usr/bin/env bash', `echo ${STUB_TRIPLE}`].join('\n'), {
      mode: 0o755,
    });
  }

  try {
    const stdout = execFileSync('bash', [path.join(root, script)], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        STUB_STATUS: git.status ?? '',
        STUB_UPSTREAM: git.upstream ?? '',
        STUB_DIFF: git.diff ?? '',
        // Every test states what it wants; inheriting the runner's CI flag would
        // silently disable the very skip half of these tests assert on.
        CI: '',
        RUST_GATES: '',
        ...env,
      },
    });
    return { status: 0, output: stdout, cargo: readLog(cargoLog) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}`,
      cargo: readLog(cargoLog),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readLog(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

const changed = (git: GitState): RunResult => run('scripts/rust-changed.sh', git);

describe('rust-changed.sh decides from the diff (NEWS-294)', () => {
  it('says yes when a Rust source file is modified', () => {
    const { status, output } = changed({ status: ' M src-tauri/src/lib.rs\n' });
    expect(status, 'exit 0 means "run the gates"').toBe(0);
    expect(output).toContain('src-tauri/src/lib.rs');
  });

  it('says no when only TypeScript changed', () => {
    // The case this whole ticket exists for, and the majority of commits.
    const { status } = changed({
      status: ' M src/checks.ts\n M tests/unit/checks.test.ts\n',
      upstream: 'origin/main',
      diff: 'src/checks.ts\ntests/unit/checks.test.ts\n',
    });
    expect(status, 'exit 1 means "safe to skip"').toBe(1);
  });

  it('says yes when only a Rust-adjacent script changed', () => {
    // `ensure-sidecar-stub.sh` runs before every cargo command — breaking it
    // breaks the gates without touching a line of Rust.
    for (const file of [
      'scripts/ensure-sidecar-stub.sh',
      'scripts/gates-rust.sh',
      'scripts/rust-changed.sh',
      'scripts/build-sidecar.sh',
      'scripts/tauri-build-local.sh',
    ]) {
      const { status } = changed({ status: ` M ${file}\n`, upstream: 'origin/main', diff: file });
      expect(status, `${file} should force a Rust run`).toBe(0);
    }
  });

  it('says yes for a brand-new untracked .rs file', () => {
    // `git diff` cannot see it; only `git status --porcelain` reports `??`. A
    // predicate built on the diff alone would skip the gates for a file that has
    // never been compiled.
    const { status } = changed({ status: '?? src-tauri/src/updater.rs\n' });
    expect(status).toBe(0);
  });

  it('says yes for a Rust change that is committed but not yet pushed', () => {
    // Those commits' own gate runs may themselves have skipped Rust, so they stay
    // part of the unverified change until they are published.
    const { status, output } = changed({
      status: '',
      upstream: 'origin/main',
      diff: 'src/client/app.tsx\nsrc-tauri/Cargo.toml\n',
    });
    expect(status).toBe(0);
    expect(output).toContain('origin/main');
    expect(output).toContain('src-tauri/Cargo.toml');
  });

  it('says no for unpushed commits that are TypeScript only', () => {
    const { status, output } = changed({
      status: '',
      upstream: 'origin/main',
      diff: 'src/client/app.tsx\ndocs/3-ui.md\n',
    });
    expect(status).toBe(1);
    expect(output).toContain('origin/main');
  });

  it('says yes rather than guessing when git cannot answer', () => {
    // Every uncertainty resolves to "run them". A skip is only ever allowed on a
    // positive answer, because the cost of a wrong skip is a red main and the cost
    // of a wrong run is a minute.
    expect(changed({ isRepo: false }).status, 'not a git checkout').toBe(0);
    expect(changed({ statusFails: true }).status, 'git status failed').toBe(0);
  });

  it('is explicit about examining less when there is no upstream', () => {
    // It can only see uncommitted work then, and saying so is the difference
    // between a documented assumption and a hidden one.
    const { status, output } = changed({ status: ' M src/checks.ts\n' });
    expect(status).toBe(1);
    expect(output).toContain('no upstream');
  });
});

describe('gates-rust.sh acts on that decision (NEWS-294)', () => {
  const gates = (git: GitState, env: Record<string, string> = {}): RunResult =>
    run('scripts/gates-rust.sh', git, env, true);

  it('runs every cargo phase when src-tauri/ changed', () => {
    // The half that matters most: proving the gates still *happen*. A skip
    // condition that accidentally matched everything would leave this repo with
    // no Rust checking at all and nothing red to show it.
    const { status, output, cargo } = gates({ status: ' M src-tauri/src/lib.rs\n' });
    expect(status, output).toBe(0);
    expect(output).not.toContain('SKIPPED');
    expect(cargo, 'cargo fmt --check must run').toContainEqual(expect.stringContaining('fmt'));
    expect(cargo.filter((c) => c.includes('clippy'))).toHaveLength(2);
    expect(cargo, 'the release profile compiles the cfg(not(debug_assertions)) bodies').toContainEqual(
      expect.stringContaining('--release'),
    );
    expect(cargo).toContainEqual(expect.stringContaining('test'));
  });

  it('skips them loudly, and only them, when nothing Rust-adjacent changed', () => {
    const { status, output, cargo } = gates({
      status: ' M src/checks.ts\n',
      upstream: 'origin/main',
      diff: 'src/checks.ts',
    });
    expect(status).toBe(0);
    expect(cargo, 'cargo must not have been invoked at all').toEqual([]);
    // Loud, and actionable. A quiet skip is the failure mode being avoided, not a
    // stylistic preference.
    expect(output).toContain('rust gates SKIPPED');
    expect(output, 'it must name what did not run').toContain('cargo fmt');
    expect(output, 'it must say how to force them').toContain('RUST_GATES=required');
    expect(output, 'it must say CI still covers this').toContain('CI runs them unconditionally');
  });

  it('runs them anyway under RUST_GATES=required', () => {
    const { cargo } = gates(
      { status: ' M src/checks.ts\n', upstream: 'origin/main', diff: 'src/checks.ts' },
      { RUST_GATES: 'required' },
    );
    expect(cargo.length, 'required must defeat the diff-based skip').toBeGreaterThan(0);
  });

  it('never auto-skips in CI', () => {
    // The guarantee the ticket demands. ci.yml's rust job calls cargo directly, so
    // CI's coverage never depended on this script — but a future job that does
    // call it must not inherit a local-iteration optimisation.
    const { cargo, output } = gates(
      { status: ' M src/checks.ts\n', upstream: 'origin/main', diff: 'src/checks.ts' },
      { CI: 'true' },
    );
    expect(output).not.toContain('rust gates SKIPPED');
    expect(cargo.length).toBeGreaterThan(0);
  });

  it("cannot weaken CI's rust job, which never routes through this script", () => {
    // The structural reason the auto-skip is safe, asserted rather than assumed.
    // ci.yml's rust job runs cargo directly with `working-directory: src-tauri`,
    // so `scripts/gates-rust.sh` — and therefore the skip — is not in its path at
    // all. If a future edit routes that job through the script, this fails and the
    // `CI` guard above becomes the thing keeping coverage whole.
    // Comment lines stripped: the job's own comment *mentions* gates-rust.sh, to
    // explain that the two must stay identical. Reading that as configuration
    // fails a correct file — the same trap release-scripts.test.ts documents.
    const ci = fs
      .readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    const rustJob = ci.slice(ci.indexOf('\n  rust:\n'));
    expect(rustJob, 'the rust job should exist').toContain('cargo fmt --check');
    expect(rustJob, 'it must invoke cargo directly, not through the gate script').not.toContain('gates-rust.sh');
    expect(rustJob).toContain('cargo clippy --release --all-targets -- -D warnings');
  });

  it('still honours RUST_GATES=skip ahead of everything', () => {
    // ci.yml's gate job sets it, because its sibling rust job has the webkit/glib
    // headers this one does not.
    const { output, cargo } = gates({ status: ' M src-tauri/src/lib.rs\n' }, { RUST_GATES: 'skip' });
    expect(output).toContain('RUST_GATES=skip');
    expect(cargo).toEqual([]);
  });
});

describe('the fast inner loop is documented and bounded (NEWS-294)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

  it('npm run gate:quick -> bash scripts/gate-quick.sh', () => {
    const { scripts } = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(JSON.parse(read('package.json')));
    expect(scripts['gate:quick']).toBe('bash scripts/gate-quick.sh');
  });

  it('leaves out exactly the three expensive things, and no coverage', () => {
    const sh = read('scripts/gate-quick.sh');
    expect(sh).toContain('npm run typecheck');
    expect(sh).toContain('npm run lint');
    expect(sh).toContain('npx vitest run');
    expect(sh, 'coverage is only needed for the merged report').not.toContain('vitest run --coverage');
    expect(sh, 'no E2E in the inner loop').not.toContain('playwright');
    expect(sh, 'no Rust in the inner loop').not.toContain('gates-rust.sh');
  });

  it('says what it did not run, every time', () => {
    // Without this the command quietly makes it easier to commit red, which would
    // make the whole change a net loss.
    const sh = read('scripts/gate-quick.sh');
    expect(sh).toContain("Run 'npm run test:all' before committing");
    expect(sh).toContain('never commit red');
  });

  it('does not become the thing test:all runs', () => {
    // The full gate must keep its phases spelled out; routing it through the quick
    // script would silently drop E2E and coverage from the commit gate.
    expect(read('scripts/test-all.sh')).not.toContain('gate-quick.sh');
  });
});
