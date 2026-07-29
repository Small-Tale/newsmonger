import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DOMOTION_PROBE_TTL_MS,
  domotionMessage,
  domotionStatus,
  MIN_DOMOTION_VERSION,
  type ProbeDeps,
  probeDomotion,
  resetDomotionCache,
} from '../../src/briefing/domotion.js';

/**
 * Finding the user's domotion install (NEWS-178).
 *
 * Every dependency is injected, so none of this needs a real binary — which
 * matters, because the interesting cases are precisely the ones that are hard
 * to stage for real: a GUI process with a stripped `PATH`, an unrelated
 * project shadowing the global install, and a version too old to have the verb
 * we need.
 */

/** A fake machine. `files` is the set of paths that exist; `versions` what each one prints. */
function deps(opts: {
  files?: string[];
  versions?: Record<string, string | null>;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  dirs?: Record<string, string[]>;
}): ProbeDeps {
  const files = new Set(opts.files ?? []);
  return {
    env: opts.env ?? {},
    execPath: opts.execPath ?? '/opt/node/bin/node',
    isFile: (p) => files.has(p),
    listDir: (p) => opts.dirs?.[p] ?? [],
    readVersion: (p) => opts.versions?.[p] ?? null,
  };
}

const NVM_BIN = '/home/u/.nvm/versions/node/v22.14.0/bin';
const NVM_DOMOTION = path.join(NVM_BIN, 'domotion');
const NVM_DIRS = { '/home/u/.nvm/versions/node': ['v20.0.0', 'v22.14.0'] };

describe('probing for domotion (NEWS-178)', () => {
  it('accepts an install at or above the floor', () => {
    const probe = probeDomotion(
      deps({ files: [NVM_DOMOTION], versions: { [NVM_DOMOTION]: '0.21.1' }, env: { HOME: '/home/u' }, dirs: NVM_DIRS }),
    );
    expect(probe).toMatchObject({ status: 'ok', version: '0.21.1', binPath: NVM_DOMOTION, source: 'nvm' });
  });

  it('accepts exactly the floor', () => {
    // An off-by-one here would reject the very version the floor names.
    const probe = probeDomotion(
      deps({
        files: [NVM_DOMOTION],
        versions: { [NVM_DOMOTION]: MIN_DOMOTION_VERSION },
        env: { HOME: '/home/u' },
        dirs: NVM_DIRS,
      }),
    );
    expect(probe.status).toBe('ok');
  });

  it('reports a real 0.13.3 install as too old, not as absent', () => {
    // The version actually installed on the development machine. It has no
    // `storyboard` verb, so a presence-only check would enable briefings and
    // then fail at render time with a raw CLI error.
    const probe = probeDomotion(
      deps({ files: [NVM_DOMOTION], versions: { [NVM_DOMOTION]: '0.13.3' }, env: { HOME: '/home/u' }, dirs: NVM_DIRS }),
    );
    expect(probe).toMatchObject({ status: 'too-old', version: '0.13.3', minimum: MIN_DOMOTION_VERSION });
  });

  it('does not fall through from a too-old install to a newer one elsewhere', () => {
    // Silently rendering with a different copy than the one the user believes
    // they installed is worse than telling them to upgrade the one they have.
    const brew = '/opt/homebrew/bin/domotion';
    const probe = probeDomotion(
      deps({
        files: [NVM_DOMOTION, brew],
        versions: { [NVM_DOMOTION]: '0.13.3', [brew]: '0.21.1' },
        env: { HOME: '/home/u' },
        dirs: NVM_DIRS,
      }),
    );
    expect(probe.status).toBe('too-old');
  });

  it('ignores a project-local node_modules/.bin on PATH', () => {
    // The observed failure: `which domotion` on the dev machine resolves to an
    // unrelated project's node_modules/.bin, shadowing the global install.
    const shadow = '/home/u/other-project/node_modules/.bin/domotion';
    const probe = probeDomotion(
      deps({
        files: [shadow, NVM_DOMOTION],
        versions: { [shadow]: '0.13.3', [NVM_DOMOTION]: '0.21.1' },
        env: { HOME: '/home/u', PATH: '/home/u/other-project/node_modules/.bin' },
        dirs: NVM_DIRS,
      }),
    );
    expect(probe).toMatchObject({ status: 'ok', binPath: NVM_DOMOTION, source: 'nvm' });
  });

  it('finds an nvm install even when PATH is the stripped one a GUI app gets', () => {
    // A GUI-launched .app inherits roughly this PATH — no Homebrew, no nvm.
    // Resolving purely from PATH would report "absent" on a machine whose
    // terminal finds domotion instantly.
    const probe = probeDomotion(
      deps({
        files: [NVM_DOMOTION],
        versions: { [NVM_DOMOTION]: '0.21.1' },
        env: { HOME: '/home/u', PATH: '/usr/gnu/bin:/usr/local/bin:/bin:/usr/bin' },
        execPath: '/Applications/Newsmonger.app/Contents/MacOS/newsmonger-node',
        dirs: NVM_DIRS,
      }),
    );
    expect(probe).toMatchObject({ status: 'ok', source: 'nvm' });
  });

  it('prefers an explicit override over everything else', () => {
    const custom = '/somewhere/odd/domotion';
    const probe = probeDomotion(
      deps({
        files: [custom, NVM_DOMOTION],
        versions: { [custom]: '0.22.0', [NVM_DOMOTION]: '0.21.1' },
        env: { HOME: '/home/u', NEWSMONGER_DOMOTION: custom },
        dirs: NVM_DIRS,
      }),
    );
    expect(probe).toMatchObject({ status: 'ok', binPath: custom, source: 'override' });
  });

  it('finds the binary beside the Node that is running us', () => {
    const beside = '/opt/node/bin/domotion';
    const probe = probeDomotion(deps({ files: [beside], versions: { [beside]: '0.21.1' } }));
    expect(probe).toMatchObject({ status: 'ok', source: 'running-node' });
  });

  it('keeps looking past a binary that exists but will not run', () => {
    const broken = '/opt/node/bin/domotion';
    const probe = probeDomotion(
      deps({
        files: [broken, NVM_DOMOTION],
        versions: { [broken]: null, [NVM_DOMOTION]: '0.21.1' },
        env: { HOME: '/home/u' },
        dirs: NVM_DIRS,
      }),
    );
    expect(probe).toMatchObject({ status: 'ok', binPath: NVM_DOMOTION });
  });

  it('keeps looking past output with no version in it', () => {
    // A shim, a wrapper script, or a future release printing a banner. It is
    // process output from a tool we do not control, so it is validated rather
    // than trusted — and must read as unusable, not compare as NaN.
    const shim = '/opt/node/bin/domotion';
    const probe = probeDomotion(
      deps({
        files: [shim, NVM_DOMOTION],
        versions: { [shim]: 'command not found\n', [NVM_DOMOTION]: '0.21.1' },
        env: { HOME: '/home/u' },
        dirs: NVM_DIRS,
      }),
    );
    expect(probe).toMatchObject({ status: 'ok', binPath: NVM_DOMOTION });
  });

  it('reads a version out of a noisier line', () => {
    const bin = '/opt/node/bin/domotion';
    const probe = probeDomotion(deps({ files: [bin], versions: { [bin]: 'domotion-svg v0.21.4 (darwin)' } }));
    expect(probe).toMatchObject({ status: 'ok', version: '0.21.4' });
  });

  it('reports absent, with where it looked, when nothing is installed', () => {
    const probe = probeDomotion(deps({ env: { HOME: '/home/u', PATH: '/usr/bin' }, dirs: NVM_DIRS }));
    if (probe.status !== 'absent') throw new Error(`expected absent, got ${probe.status}`);
    // The search list is what makes an "it IS installed!" bug report actionable.
    expect(probe.searched).toContain(NVM_DOMOTION);
  });

  it('does not probe the same path twice', () => {
    // `/usr/local/bin` is both a hardcoded root and a normal PATH entry.
    const probe = probeDomotion(deps({ env: { PATH: '/usr/local/bin:/usr/bin' } }));
    const searched = probe.status === 'absent' ? probe.searched : [];
    expect(new Set(searched).size).toBe(searched.length);
  });
});

describe('what the user is told (NEWS-178)', () => {
  it('says "update", not "install", when a too-old copy is present', () => {
    const msg = domotionMessage({
      status: 'too-old',
      binPath: '/x/domotion',
      version: '0.13.3',
      source: 'nvm',
      minimum: MIN_DOMOTION_VERSION,
    });
    expect(msg).toContain('Update it');
    expect(msg).toContain('0.13.3');
    expect(msg).toContain(MIN_DOMOTION_VERSION);
    // Naming the missing verb is what makes the version floor make sense.
    expect(msg).toContain('storyboard');
  });

  it('says "install", and mentions the override, when nothing is found', () => {
    const msg = domotionMessage({ status: 'absent', searched: [] });
    expect(msg).toContain('npm install -g domotion-svg');
    expect(msg).toContain('NEWSMONGER_DOMOTION');
  });

  it('names the chosen binary when it is usable, so a wrong pick is visible', () => {
    const msg = domotionMessage({ status: 'ok', binPath: '/x/domotion', version: '0.21.1', source: 'nvm' });
    expect(msg).toContain('/x/domotion');
    expect(msg).toContain('0.21.1');
  });
});

describe('caching the probe (NEWS-178)', () => {
  beforeEach(() => {
    resetDomotionCache();
  });

  const usable = (calls: { n: number }): ProbeDeps => {
    const bin = '/opt/node/bin/domotion';
    return {
      ...deps({ files: [bin], versions: { [bin]: '0.21.1' } }),
      readVersion: (p) => {
        calls.n += 1;
        return p === bin ? '0.21.1' : null;
      },
    };
  };

  it('does not re-probe within the TTL', () => {
    // /api/state is polled every 4s. Uncached, this would fork a subprocess
    // sixteen times a minute for a fact that changes when someone runs an
    // installer — so this is a correctness requirement, not an optimization.
    const calls = { n: 0 };
    const d = usable(calls);
    expect(domotionStatus(1_000, d).status).toBe('ok');
    expect(domotionStatus(1_000 + DOMOTION_PROBE_TTL_MS - 1, d).status).toBe('ok');
    expect(calls.n).toBe(1);
  });

  it('re-probes once the TTL has passed', () => {
    // The TTL rather than a permanent memo is what lets someone install or
    // upgrade domotion and have the app notice without a restart — which is
    // exactly what they will do after reading the "not installed" message.
    const calls = { n: 0 };
    const d = usable(calls);
    domotionStatus(1_000, d);
    domotionStatus(1_000 + DOMOTION_PROBE_TTL_MS, d);
    expect(calls.n).toBe(2);
  });

  it('picks up an install that appeared since the last probe', () => {
    const bin = '/opt/node/bin/domotion';
    let installed = false;
    const d: ProbeDeps = {
      ...deps({}),
      isFile: (p) => installed && p === bin,
      readVersion: () => (installed ? '0.21.1' : null),
    };
    expect(domotionStatus(1_000, d).status).toBe('absent');
    installed = true;
    expect(domotionStatus(1_000 + DOMOTION_PROBE_TTL_MS, d).status).toBe('ok');
  });
});
