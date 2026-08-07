import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The stills pipeline and the README have to agree (NEWS-214).
 *
 * `scripts/demo/capture-stills.ts` declares a set of scenes; the README embeds
 * their PNGs with alt text copied from those scenes. Nothing connects the two at
 * runtime, and the failure is silent in both directions: a renamed scene leaves
 * a broken image in the README, and a scene added to the script is simply never
 * shown. Neither breaks a build, and neither is visible in a diff review of the
 * other file.
 *
 * These tests read the real script, the real README and the real files on disk
 * and assert the relationships, so the next drift fails a gate instead of
 * shipping a README with a missing image in it.
 *
 * They deliberately do **not** run the capture — it needs Chromium outside the
 * sandbox and takes a minute. What they check is that whatever was captured
 * last is complete and correctly referenced.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/demo/capture-stills.ts');
const STILLS_DIR = path.join(ROOT, 'assets/stills');

const script = (): string => fs.readFileSync(SCRIPT, 'utf8');
const readme = (): string => fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

/** Scene names, read off the script's own `SCENES` array. */
function sceneNames(): string[] {
  return [...script().matchAll(/^\s{4}name: '([a-z-]+)',$/gm)].map((m) => m[1]);
}

/** Scene alt strings, in the same order. */
function sceneAlts(): string[] {
  return [...script().matchAll(/^\s{4}alt: '(.*)',$/gm)].map((m) => m[1].replace(/\\'/g, "'"));
}

/** `assets/stills/<name>.png` references in the README, with their alt text. */
function readmeImages(): { src: string; alt: string }[] {
  return [...readme().matchAll(/<img src="(assets\/stills\/[^"]+)" alt="([^"]*)"/g)].map((m) => ({
    src: m[1],
    alt: m[2],
  }));
}

describe('the stills pipeline (NEWS-214)', () => {
  it('declares scenes at all, so a broken parse fails loudly rather than vacuously passing', () => {
    // Without this, a regex that stopped matching would make every test below
    // assert something about an empty list and pass.
    expect(sceneNames().length).toBeGreaterThanOrEqual(6);
    expect(sceneAlts()).toHaveLength(sceneNames().length);
  });

  it('has captured every scene, as both a PNG and an SVG', () => {
    for (const name of sceneNames()) {
      for (const ext of ['png', 'svg']) {
        const file = path.join(STILLS_DIR, `${name}.${ext}`);
        expect(fs.existsSync(file), `${name}.${ext} is missing — run \`npm run demo:stills\``).toBe(true);
        // A zero-byte file is what a half-finished capture leaves behind, and it
        // renders as a broken image rather than as an error.
        expect(fs.statSync(file).size, `${name}.${ext} is empty`).toBeGreaterThan(1000);
      }
    }
  });

  it('leaves nothing stale in the output directory', () => {
    // A renamed scene leaves its old files behind, and the README would keep
    // pointing at one that is quietly no longer regenerated.
    const expected = new Set(sceneNames().flatMap((n) => [`${n}.png`, `${n}.svg`]));
    for (const file of fs.readdirSync(STILLS_DIR)) {
      expect(expected.has(file), `${file} belongs to no scene — a rename left it behind`).toBe(true);
    }
  });

  it('embeds only stills that exist, in the README', () => {
    const images = readmeImages();
    expect(images.length).toBeGreaterThan(0);
    for (const { src } of images) {
      expect(fs.existsSync(path.join(ROOT, src)), `README references ${src}, which does not exist`).toBe(true);
    }
  });

  it('keeps the README alt text identical to the scene it came from', () => {
    // Alt text is the accessible description of the screenshot, and the scene
    // is where it is authored. Two copies drift; this is the one that catches it.
    const alts = new Map(sceneNames().map((n, i) => [n, sceneAlts()[i]]));
    for (const { src, alt } of readmeImages()) {
      const name = path.basename(src, path.extname(src));
      expect(alts.get(name), `README embeds ${name}, which is not a scene`).toBeDefined();
      expect(alt, `alt text for ${name} has drifted from the scene`).toBe(alts.get(name));
    }
  });

  it('is reachable through an npm script, so it is not a file nobody knows to run', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['demo:stills']).toContain('capture-stills.ts');
    // The client bundle has to be built first, or the capture photographs a
    // stale UI — which looks like a successful run.
    expect(pkg.scripts['demo:stills']).toContain('build:client');
  });

  it('never points the capture at the real data directory', () => {
    // The capture creates topics and runs checks. Left to the default it would
    // write into `~/.newsmonger` — someone's real install.
    //
    // Asserted against the code with comments stripped: the script *mentions*
    // `~/.newsmonger` in the comment explaining why it avoids it, and a naive
    // text search would either match that or have to be worded around it.
    const code = script().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toContain("'--data-dir'");
    expect(code).toContain('mkdtempSync');
    expect(code).toContain('tmpdir()');
    expect(code).not.toMatch(/homedir\(\)|\.newsmonger/);
  });

  it('picks the discovery chip from the held-back topic, not by index (NEWS-399)', () => {
    // The `discover` still is a picture of a section drill-in whose one result is
    // the held-back topic. The heading is the *request* and the group label is
    // where that topic files itself (FR-24.13), so the two are eight pixels apart
    // and must agree — `subcategories[0]` was a guess, and it shipped a
    // "Business · Markets" heading over a group labelled "BUSINESS · OTHER".
    //
    // Asserted on the source because nothing in a unit run can execute the
    // capture: the script needs Chromium outside the sandbox, and its constants
    // are module-level beside a top-level `await main()`. `demo.test.ts` already
    // guarantees the *pair resolves*; this is the other half — that the walk
    // actually reads it.
    const code = script().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/DISCOVER_CHIP\s*=[^;]*subcategory/);
    expect(code, 'the subject chip is being guessed again').not.toMatch(/subcategories\[0\]/);
  });
});
