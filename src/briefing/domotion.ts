import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

/**
 * Finding the user's domotion install (NEWS-178, docs/27 FR-27.14–27.14b).
 *
 * Domotion is an **external tool the user installs globally**, not something
 * this project ships — that is what keeps `sharp` (and its unpatched libvips
 * CVEs) and a second browser engine out of the signed bundle. The price is
 * that we have to go and find it, and the obvious way to do that is wrong in
 * three separate ways, all three observed rather than reasoned about:
 *
 *  1. **A GUI-launched macOS app does not inherit the shell's `PATH`.** It gets
 *     roughly `/usr/gnu/bin:/usr/local/bin:/bin:/usr/bin` — no Homebrew, and
 *     no nvm. A global install under `~/.nvm/versions/node/v22.14.0/bin` is
 *     invisible to it while the same machine's terminal finds it instantly.
 *  2. **`PATH` can resolve to the wrong copy.** On the development machine,
 *     `which domotion` hits an unrelated *project's* `node_modules/.bin`,
 *     shadowing the global install entirely.
 *  3. **Presence is not enough.** The globally installed copy there is 0.13.3,
 *     which has no `storyboard` verb at all — the one the reel is built on.
 *
 * So: probe known install roots as well as `PATH`, prefer real global roots
 * over `PATH`, ignore `node_modules/.bin` entries, and version-gate the
 * result. Everything the caller might want to put in an error message — which
 * binary won, what version it is, where we looked — comes back in the result.
 */

/**
 * The lowest version that can render a briefing reel.
 *
 * `domotion storyboard` — which sequences the five card scenes into one SVG —
 * shipped in **0.21.0**, as did native inlining of `<img src="*.svg">`, which
 * is what keeps the closing card's wordmark vector rather than rasterized.
 * Both are load-bearing, so 0.21.0 is the floor rather than a cautious guess.
 */
export const MIN_DOMOTION_VERSION = '0.21.0';

/** Where a candidate binary came from — carried through so a wrong pick is diagnosable. */
export type DomotionSource = 'override' | 'running-node' | 'nvm' | 'homebrew' | 'system' | 'path';

export type DomotionProbe =
  | { status: 'ok'; binPath: string; version: string; source: DomotionSource }
  | { status: 'too-old'; binPath: string; version: string; source: DomotionSource; minimum: string }
  | { status: 'absent'; searched: string[] };

/**
 * A version as the CLI reports it.
 *
 * This is process output from a tool we do not control, so it is validated
 * rather than trusted — `domotion --version` prints a bare `0.21.1` today, but
 * a future release printing a banner, or a shim printing nothing, must read as
 * "unusable" rather than crash or silently compare as `NaN`.
 */
const VersionSchema = z
  .string()
  .trim()
  .transform((s) => /(\d+)\.(\d+)\.(\d+)/.exec(s))
  .refine((m): m is RegExpExecArray => m !== null, { message: 'no semver found in --version output' })
  .transform((m) => ({ text: `${m[1]}.${m[2]}.${m[3]}`, parts: [Number(m[1]), Number(m[2]), Number(m[3])] as const }));

/** Compare two dotted versions. Negative when `a` is older than `b`. */
function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface ProbeDeps {
  /** Process environment. Read for the override, `PATH` and `HOME`. */
  env: NodeJS.ProcessEnv;
  /** The Node binary currently running us; its sibling `bin` dir is a strong candidate. */
  execPath: string;
  /** Whether a path exists and is a file. Injected so tests need no real binary. */
  isFile: (p: string) => boolean;
  /** Directory listing, used only to expand nvm's version-named directories. */
  listDir: (p: string) => string[];
  /** Run `<bin> --version` and return stdout, or null if it could not be run. */
  readVersion: (binPath: string) => string | null;
}

/**
 * Ask a candidate binary its version.
 *
 * Bounded and non-throwing on purpose: this runs an executable chosen by a
 * filesystem heuristic, so it has to survive the file being a shell script
 * that hangs, a wrapper that writes to stderr, or something that is not a
 * program at all. Any of those means "not a usable install", not a crash.
 */
export function readDomotionVersion(binPath: string): string | null {
  try {
    return execFileSync(binPath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** The real dependencies. Kept out of `probeDomotion` so it stays testable. */
export function defaultProbeDeps(runVersion: (binPath: string) => string | null = readDomotionVersion): ProbeDeps {
  return {
    env: process.env,
    execPath: process.execPath,
    isFile: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    listDir: (p) => {
      try {
        return fs.readdirSync(p);
      } catch {
        return [];
      }
    },
    readVersion: runVersion,
  };
}

/**
 * Candidate binaries, best-first.
 *
 * `PATH` is deliberately **last**, and any `node_modules` entry on it is
 * skipped outright. An entry like `<some-other-project>/node_modules/.bin`
 * belongs to whatever directory a shell happened to be in and is not the
 * user's chosen install — preferring it over a real global root is exactly the
 * shadowing bug in FR-27.14a.
 */
function candidates(deps: ProbeDeps): { binPath: string; source: DomotionSource }[] {
  const found: { binPath: string; source: DomotionSource }[] = [];
  const add = (dir: string, source: DomotionSource): void => {
    if (dir !== '') found.push({ binPath: path.join(dir, 'domotion'), source });
  };

  const override = deps.env.NEWSMONGER_DOMOTION;
  if (override !== undefined && override.trim() !== '') {
    // An explicit override names the binary itself, not its directory — it is
    // the escape hatch for a layout none of the heuristics below cover.
    found.push({ binPath: override.trim(), source: 'override' });
  }

  // The Node running this server is very often the one that installed the
  // global package, and its `bin` dir is where npm puts global binaries. This
  // is what makes an nvm install resolve without knowing nvm exists.
  add(path.dirname(deps.execPath), 'running-node');

  // …but under the packaged app, `execPath` is the bundled sidecar Node, so
  // nvm's own tree has to be walked explicitly. The directory names are node
  // versions, which is why this is a listing rather than a fixed path.
  const home = deps.env.HOME;
  if (home !== undefined && home !== '') {
    const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
    for (const version of deps.listDir(nvmRoot)) add(path.join(nvmRoot, version, 'bin'), 'nvm');
  }

  add('/opt/homebrew/bin', 'homebrew');
  add('/usr/local/bin', 'homebrew');
  add('/usr/bin', 'system');

  for (const dir of (deps.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '' || dir.includes('node_modules')) continue;
    add(dir, 'path');
  }

  return found;
}

/**
 * Find a usable domotion, or explain why there isn't one.
 *
 * Returns the *first* candidate that both exists and reports a version — then
 * version-gates it. Note that a too-old install ends the search rather than
 * falling through to a newer one further down the list: the user has an
 * install and it needs upgrading, and silently rendering with a different copy
 * than the one they think they installed is worse than saying so.
 */
export function probeDomotion(deps: ProbeDeps): DomotionProbe {
  const searched: string[] = [];

  for (const { binPath, source } of candidates(deps)) {
    if (searched.includes(binPath)) continue;
    searched.push(binPath);
    if (!deps.isFile(binPath)) continue;

    const raw = deps.readVersion(binPath);
    if (raw === null) continue; // exists but won't run — keep looking

    const parsed = VersionSchema.safeParse(raw);
    if (!parsed.success) continue; // unintelligible output is not a usable install

    const { text, parts } = parsed.data;
    const minimum = MIN_DOMOTION_VERSION.split('.').map(Number);
    if (compareVersions(parts, minimum) < 0) {
      return { status: 'too-old', binPath, version: text, source, minimum: MIN_DOMOTION_VERSION };
    }
    return { status: 'ok', binPath, version: text, source };
  }

  return { status: 'absent', searched };
}

/**
 * What to tell the user.
 *
 * "Absent" and "too old" are **different problems** and only one of the two
 * fixes each — offering "install it" to someone who already has it is how a
 * capability message wastes the reader's time.
 */
export function domotionMessage(probe: DomotionProbe): string {
  switch (probe.status) {
    case 'ok':
      return `Using domotion ${probe.version} (${probe.binPath}).`;
    case 'too-old':
      return (
        `domotion ${probe.version} is installed at ${probe.binPath}, but briefings need ` +
        `${probe.minimum} or newer — the reel is built with "domotion storyboard", which ` +
        `earlier versions do not have. Update it with: npm install -g domotion-svg`
      );
    case 'absent':
      return (
        'Briefings need domotion, which is not installed. Install it with: npm install -g domotion-svg ' +
        '(it downloads its own copy of Chromium on first use). If it is already installed somewhere ' +
        'unusual, point NEWSMONGER_DOMOTION at the binary.'
      );
  }
}

/**
 * The probe result, computed at most once per TTL.
 *
 * Probing spawns a process, and the natural consumer is `/api/state`, which
 * the client polls **every 4 seconds**. Calling `probeDomotion` from there
 * uncached would fork a subprocess sixteen times a minute for a fact that
 * changes when the user runs an installer — so caching is a correctness
 * requirement here, not an optimization.
 *
 * The TTL rather than a permanent memo is what lets someone install or upgrade
 * domotion and have the app notice without a restart, which is exactly what
 * they will do the first time they hit the "not installed" message.
 */
let cached: { at: number; probe: DomotionProbe } | null = null;

export const DOMOTION_PROBE_TTL_MS = 30_000;

export function domotionStatus(now: number = Date.now(), deps: ProbeDeps = defaultProbeDeps()): DomotionProbe {
  if (cached !== null && now - cached.at < DOMOTION_PROBE_TTL_MS) return cached.probe;
  const probe = probeDomotion(deps);
  cached = { at: now, probe };
  return probe;
}

/** Drop the cache. For tests, and for an explicit "check again" the user asks for. */
export function resetDomotionCache(): void {
  cached = null;
}
