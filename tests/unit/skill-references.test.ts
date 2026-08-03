import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Every repo path and npm script a project skill names actually exists (NEWS-262).
 *
 * A skill is prose that an agent follows literally, which makes a dangling
 * reference in one worse than a dangling reference in a doc: a human skims past
 * `docs/3-ui.md` being renamed, an agent goes and reads nothing, then proceeds
 * without the context the skill existed to supply.
 *
 * The `design-review` skill was adapted from an upstream one whose entire
 * preparation step pointed at skills that are not installed here
 * (`frontend-design`, `teach-impeccable`) and whose every suggested fix named a
 * command that does not exist (`/animate`, `/quieter`, …). Copying it verbatim
 * would have produced a skill that reads perfectly and does nothing — the same
 * shape as NEWS-260, where a `window.__TAURI__.notification` that no build
 * defines type-checked fine and left desktop notifications dead for months.
 *
 * **And writing it reproduced the bug in miniature**: a first draft cited
 * "FR-3.83", read off a *line number* in `docs/3-ui.md` rather than a
 * requirement id. There is no FR-3.83. This test would **not** have caught that
 * one — it resolves paths and scripts, not anchors within a document — and it is
 * here because that near-miss showed how easily the same slip lands on a path,
 * where it can be checked.
 *
 * Sibling of `documented-paths.test.ts`, which holds prose to the code for the
 * data directory name, for the same reason: docs drifting from the tree is
 * invisible to a suite that only exercises code.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skillsDir = path.join(root, '.claude/skills');

/**
 * Repo-rooted path references — a directory we own, then a path **with a file
 * extension**.
 *
 * The extension is what separates a path from prose. The Hot Sheet skills cite
 * their own upstream design notes as "(docs/89)", which is a document number and
 * not a file here; requiring `.md`/`.ts`/`.png`/… keeps those out without an
 * exception list that would need maintaining.
 */
const PATH_RE =
  /(?:^|[\s`("'])((?:docs|src|tests|scripts|assets|\.claude)\/[A-Za-z0-9._/{},*-]*\.(?:md|ts|tsx|js|json|scss|css|png|svg|sh|yml)\b)/g;
const SCRIPT_RE = /npm run ([a-z][a-z0-9:-]*)/g;

/**
 * Expand one level of `a/{x,y}.png` into `a/x.png`, `a/y.png`.
 *
 * Worth handling rather than skipping: a brace list is how a skill names a set
 * of generated files, and those names are exactly what rots when a capture
 * script is edited.
 */
function expandBraces(ref: string): string[] {
  const m = /^(.*)\{([^}]*)\}(.*)$/.exec(ref);
  if (m === null) return [ref];
  const [, before, inner, after] = m;
  return inner.split(',').map((part) => `${before}${part.trim()}${after}`);
}

function skillFiles(): string[] {
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir)
    .map((name) => path.join(skillsDir, name, 'SKILL.md'))
    .filter((f) => fs.existsSync(f));
}

function referencesIn(file: string): { paths: string[]; scripts: string[] } {
  const text = fs.readFileSync(file, 'utf8');
  const paths = [...text.matchAll(PATH_RE)]
    .map((m) => m[1].replace(/[.,)]+$/, ''))
    .flatMap(expandBraces)
    // A glob is a pattern, not a path — the directory above it is the real claim.
    .filter((p) => !p.includes('*'));
  const scripts = [...text.matchAll(SCRIPT_RE)].map((m) => m[1]);
  return { paths: [...new Set(paths)], scripts: [...new Set(scripts)] };
}

describe('project skills point at things that exist', () => {
  const files = skillFiles();

  it('finds skills to check, so a rename cannot make this vacuously pass', () => {
    // Without this the whole suite would go green by checking nothing.
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.includes('design-review'))).toBe(true);
  });

  it.each(files.map((f) => [path.relative(root, f), f] as const))(
    '%s references only real paths',
    (_label, file) => {
      const missing = referencesIn(file).paths.filter((p) => !fs.existsSync(path.join(root, p)));
      expect(missing, `referenced but absent from the tree`).toEqual([]);
    },
  );

  it.each(files.map((f) => [path.relative(root, f), f] as const))(
    '%s references only real npm scripts',
    (_label, file) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      const missing = referencesIn(file).scripts.filter((s) => !(s in pkg.scripts));
      expect(missing, `named in a skill but not in package.json`).toEqual([]);
    },
  );
});
