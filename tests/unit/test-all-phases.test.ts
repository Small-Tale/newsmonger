import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * `test-all.sh` cannot report a phase as having run when it did not (NEWS-300).
 *
 * **Why this is worth more than it looks**, and it is the same argument
 * `rust-changed.test.ts` makes: a wrong answer here does not produce a red run,
 * it produces a *green* one with a phase silently skipped. This project has
 * already had exactly that — `test:all` passed while `cargo fmt --check` was
 * violated in `src-tauri/`, and main was red for two commits before anyone
 * opened Actions. Adding `--from=` to the gate reopens that door, so the door
 * gets a test.
 *
 * The interesting assertion is the **cross-check**: stubs record every command
 * that actually executed, and each phase the summary calls "ran" must have its
 * command in that log, while each phase it calls "skipped" must not. A summary
 * that merely *looks* right — printed from the same variable that decides what
 * to run — would pass a weaker test and still be able to lie.
 *
 * Drives the real script with a stubbed `npm`/`npx`/`node` on PATH, the same
 * technique `rust-changed.test.ts` uses for `git` and `release-scripts.test.ts`
 * uses for `xcrun`. `gates-rust.sh` is copied alongside and runs for real with
 * `RUST_GATES=skip`, so the verdict contract between the two scripts is genuinely
 * exercised rather than mocked.
 *
 * **Copied into a temp directory rather than run in place**, and that is not
 * fastidiousness: `test-all.sh` starts its unit phase with
 * `rm -rf coverage .coverage-tmp`, and `bash` is not something PATH stubs can
 * intercept. Run against the real checkout, this file deleted the coverage
 * output of the very run executing it — which is exactly how it was found.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/test-all.sh');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface Run {
  status: number;
  out: string;
  /** Every command the stubs saw, one per line. */
  log: string;
}

/**
 * Run the gate with stubbed tools.
 *
 * @param args - flags passed through to the script.
 * @param failOn - a substring; the stub exits 1 for the command containing it.
 */
function gate(args: string[], failOn = ''): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-phases-'));
  dirs.push(dir);
  const log = path.join(dir, 'commands.log');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);

  // A throwaway checkout holding the two real scripts. `test-all.sh` cd's to its
  // own parent, so this is what keeps its `rm -rf coverage .coverage-tmp` off the
  // actual repository.
  const scripts = path.join(dir, 'repo/scripts');
  fs.mkdirSync(scripts, { recursive: true });
  for (const name of ['test-all.sh', 'gates-rust.sh']) {
    fs.copyFileSync(path.join(root, 'scripts', name), path.join(scripts, name));
  }

  for (const tool of ['npm', 'npx', 'node']) {
    const stub = path.join(bin, tool);
    fs.writeFileSync(
      stub,
      `#!/usr/bin/env bash\necho "${tool} $*" >> "${log}"\n` +
        (failOn === '' ? '' : `case "${tool} $*" in *"${failOn}"*) exit 1 ;; esac\n`) +
        'exit 0\n',
      { mode: 0o755 },
    );
  }

  let status = 0;
  let out: string;
  try {
    out = execFileSync('bash', [path.join(scripts, 'test-all.sh'), ...args], {
      cwd: path.join(dir, 'repo'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, RUST_GATES: 'skip' },
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    status = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  return { status, out, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

/** The summary's verdict for one phase, e.g. "ran" or "skipped (--from=e2e)". */
function verdict(out: string, phase: string): string {
  const m = new RegExp(`^\\s+${phase}\\s+(.+)$`, 'm').exec(out.split('== phase summary ==')[1] ?? '');
  return (m?.[1] ?? '').trim();
}

/** What each phase actually shells out to, for the cross-check. */
const COMMAND: Record<string, string> = {
  typecheck: 'npm run typecheck',
  lint: 'npm run lint',
  client: 'npm run build:client',
  server: 'npm run build',
  unit: 'npx vitest run',
  e2e: 'npx playwright test',
  coverage: 'node scripts/merge-coverage.mjs',
};

describe('the phase list', () => {
  it('is stable and ordered, so --from names something real', () => {
    const out = execFileSync('bash', [script, '--list'], { cwd: root, encoding: 'utf8' });
    expect(out.trim().split('\n')).toEqual([
      'typecheck',
      'lint',
      'rust',
      'client',
      'server',
      'unit',
      'e2e',
      'coverage',
    ]);
  });

  it('refuses a phase it does not have, rather than silently running everything', () => {
    // The dangerous failure would be treating an unknown `--from` as "no filter"
    // and quietly running the lot, or as "skip everything" and running none.
    const r = gate(['--from=e2eee']);
    expect(r.status).toBe(2);
    expect(r.out).toContain('is not a phase');
    expect(r.log, 'nothing should have executed').toBe('');
  });

  it('rejects an unknown option instead of ignoring it', () => {
    expect(gate(['--skip-e2e']).status).toBe(2);
  });
});

describe('a full run', () => {
  const r = gate([]);

  it('runs every phase', () => {
    for (const [phase, cmd] of Object.entries(COMMAND)) {
      expect(r.log, `${phase} must actually execute`).toContain(cmd);
    }
  });

  it('reports every phase, and none as skipped-by-resume', () => {
    for (const phase of Object.keys(COMMAND)) expect(verdict(r.out, phase)).toBe('ran');
    expect(r.out).not.toContain('PARTIAL RUN');
  });

  it('does not claim the Rust gates ran when they self-skipped', () => {
    // `RUST_GATES=skip` here, but the same channel carries the NEWS-294
    // diff-based skip. A summary saying "rust: ran" over a skipped gate is the
    // precise lie this summary exists to prevent.
    expect(verdict(r.out, 'rust')).toContain('skipped');
    expect(verdict(r.out, 'rust')).not.toBe('ran');
  });
});

describe('a resumed run', () => {
  const r = gate(['--from=e2e']);

  it('skips exactly the phases before the named one', () => {
    for (const phase of ['typecheck', 'lint', 'rust', 'client', 'server', 'unit']) {
      expect(verdict(r.out, phase)).toBe('skipped (--from=e2e)');
    }
    expect(verdict(r.out, 'e2e')).toBe('ran');
    expect(verdict(r.out, 'coverage')).toBe('ran');
  });

  it('**never reports a phase as run when its command never executed**', () => {
    // The cross-check, and the reason this file exists. Everything else here
    // could pass on a summary printed from the same variable that drives the
    // loop; this compares the summary against what the stubs actually saw.
    for (const [phase, cmd] of Object.entries(COMMAND)) {
      const said = verdict(r.out, phase);
      const executed = r.log.includes(cmd);
      expect(executed, `${phase}: summary says "${said}"`).toBe(said === 'ran');
    }
  });

  it('refuses to be mistaken for a commit gate', () => {
    expect(r.out).toContain('PARTIAL RUN');
    expect(r.out).toContain('NOT a commit gate');
    expect(r.status, 'still exits 0 — it is an iteration tool, like gate:quick').toBe(0);
  });
});

describe('a failing run', () => {
  const r = gate([], 'vitest run');

  it('exits non-zero', () => {
    // The property everything else is in service of. A resumable gate that
    // swallowed a failure would be worse than no resume at all.
    expect(r.status).not.toBe(0);
  });

  it('names the phase that failed and the ones never reached', () => {
    expect(verdict(r.out, 'unit')).toBe('FAILED');
    expect(verdict(r.out, 'e2e')).toBe('not reached');
    expect(verdict(r.out, 'coverage')).toBe('not reached');
    // "not reached" rather than absent: a phase missing from the summary reads
    // as fine.
    expect(verdict(r.out, 'typecheck')).toBe('ran');
  });

  it('offers the resume command, which is the point of the whole change', () => {
    expect(r.out).toContain('--from=unit');
    expect(r.out).toContain('Then run the full gate before committing');
  });

  it('does not run the phases after the failure', () => {
    expect(r.log).not.toContain('npx playwright test');
    expect(r.log).not.toContain('merge-coverage');
  });
});
