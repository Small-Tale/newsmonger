import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  isSkippedEntry,
  repoRelative,
  SKIPPED_DIR_NAMES,
  SKIPPED_PATHS,
  sourceFiles,
  walkProblems,
} from '../helpers/source-tree.js';

/**
 * The walk shared by the four tree-scanning guards (NEWS-424).
 *
 * It had no tests of its own, which is an odd gap for a module whose whole job is
 * to stop other tests being silently blind: every one of them trusts it to decide
 * what "the source tree" means, and a wrong answer here reads as a clean pass in
 * four places at once.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('isSkippedEntry', () => {
  it('skips build outputs and vendor trees by name', () => {
    for (const name of SKIPPED_DIR_NAMES) {
      expect(isSkippedEntry(name, path.join(root, 'src', name)), name).toBe(true);
    }
  });

  it('skips dot-directories, which under these roots are local artifacts', () => {
    expect(isSkippedEntry('.debug', path.join(root, 'scripts/demo/.debug'))).toBe(true);
  });

  it('skips the two gitignored src-tauri siblings by path', () => {
    // They hold Mach-O and ELF sidecars with **no extension at all** — the one
    // case `BINARY_EXTENSIONS` cannot express.
    for (const rel of SKIPPED_PATHS) {
      expect(isSkippedEntry(path.basename(rel), path.join(root, rel)), rel).toBe(true);
    }
  });

  it('does not skip a same-named directory somewhere else — the NEWS-424 defect', () => {
    // `sandboxable.test.ts` skipped `binaries` and `server` by bare *name*, so a
    // future `src/server/` would have been swallowed whole by the guard that
    // exists to catch unfixed spawners. This is the assertion that would have
    // failed then and must keep failing if anyone reaches for a name again.
    expect(isSkippedEntry('server', path.join(root, 'src/server'))).toBe(false);
    expect(isSkippedEntry('binaries', path.join(root, 'scripts/binaries'))).toBe(false);
  });

  it('does not skip an ordinary source directory', () => {
    expect(isSkippedEntry('client', path.join(root, 'src/client'))).toBe(false);
  });
});

describe('walkProblems', () => {
  const files = ['src/cli.ts', 'tests/e2e/server.ts', 'package.json'];

  it('is silent when the walk looks healthy', () => {
    expect(walkProblems(files, { floor: 3, required: ['src/cli.ts'], label: 'w' })).toEqual([]);
  });

  it('names the floor when the walk found too little', () => {
    const problems = walkProblems(files, { floor: 10, required: [], label: 'w' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('found 3 files, below the floor of 10');
  });

  it('names each required file that is missing, not just the first', () => {
    // Reporting all of them is the reason this returns a list rather than
    // asserting: two roots vanishing should read as two problems.
    const problems = walkProblems(files, {
      floor: 1,
      required: ['src-tauri/src/lib.rs', 'docs/22-topic-categories.md'],
      label: 'w',
    });
    expect(problems).toEqual([
      'w: src-tauri/src/lib.rs is not scanned',
      'w: docs/22-topic-categories.md is not scanned',
    ]);
  });

  it('compares through repoRelative, so an absolute path still matches', () => {
    // The walks hand it whatever they collected — absolute paths in two of them,
    // repo-relative in the third. Normalising here is what lets one required
    // list be written with `/` and work for all of them, on every platform.
    const absolute = [path.join(root, 'src', 'cli.ts')];
    expect(walkProblems(absolute, { floor: 1, required: ['src/cli.ts'], label: 'w' })).toEqual([]);
  });

  it('reports the floor and the missing files together', () => {
    const problems = walkProblems([], { floor: 5, required: ['src/cli.ts'], label: 'w' });
    expect(problems).toHaveLength(2);
  });
});

describe('the walk itself', () => {
  it('reaches into every root it claims, and none of the excluded ones', () => {
    const seen = new Set(sourceFiles().map((f) => repoRelative(f)));
    for (const required of [
      'src/cli.ts',
      'tests/e2e/server.ts',
      'scripts/npm-command.mjs',
      'docs/22-topic-categories.md',
      'src-tauri/src/lib.rs',
      'CLAUDE.md',
    ]) {
      expect(seen.has(required), `${required} is scanned`).toBe(true);
    }
    for (const rel of [...seen]) {
      expect(
        [...SKIPPED_PATHS].some((skipped) => rel.startsWith(`${skipped}/`)),
        `${rel} should have been skipped`,
      ).toBe(false);
    }
  });
});
