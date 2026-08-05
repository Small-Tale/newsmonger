import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Every button variant the client asks for must exist in the stylesheet
 * (NEWS-304).
 *
 * `class="btn danger"` was on the restore-backup control, and `.btn.danger` was
 * never defined. Nothing failed: the extra class is inert, so the button
 * rendered as a plain `.btn` and the *design review* recorded the app as already
 * having a danger variant while the one control supposedly using it looked
 * neutral. That is the whole failure mode — a variant name that reads as
 * intent-expressed in the JSX, and is a no-op in the browser.
 *
 * This is the same class of bug as NEWS-133/134/135, where a close button used
 * `icon-btn` — a class the stylesheet does not have — and fell back to default
 * browser chrome. That one was at least visible; this one was invisible, which
 * is worse, because the review that should have caught it cited the class as
 * evidence the treatment existed.
 *
 * Deliberately a *stylesheet* test rather than a rendered one: a variant is only
 * observable in a browser when some state puts it on screen, and several of
 * these (`danger-solid` in a confirm, `install-update`'s states) need a flow to
 * reach. The declaration either exists or it does not, and that is checkable
 * without one.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scss = fs.readFileSync(path.join(root, 'src/client/styles.scss'), 'utf8');

/**
 * Every `.ts`/`.tsx` file under `src/client`, concatenated.
 *
 * **Every file, not `app.tsx`** (NEWS-297). It read only `app.tsx`, which was
 * true when written — every view lived there — and stopped being true the moment
 * the settings dialog moved to `settings.tsx`, taking `btn danger` with it. The
 * scan silently found one fewer variant, which is the same shape of failure this
 * whole file exists to prevent: a guard that quietly checks less than it claims.
 *
 * A directory read rather than a list of files, so the next seam is covered
 * without anyone remembering to add it.
 */
function clientSource(): string {
  return fs
    .readdirSync(path.join(root, 'src/client'), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => fs.readFileSync(path.join(root, 'src/client', e.name), 'utf8'))
    .join('\n');
}

/**
 * Every modifier used alongside `btn` in a `class="btn …"` attribute.
 *
 * Reads the source rather than a hand-kept list, so a variant invented tomorrow
 * is covered without anyone remembering to add it here — which is the only way
 * this stays true, since forgetting is what produced the bug.
 */
function variantsInUse(): Set<string> {
  const found = new Set<string>();
  for (const m of clientSource().matchAll(/class=(?:"[^"]*"|\{`[^`]*`\})/g)) {
    const raw = m[0].replace(/^class=\{?[`"]/, '').replace(/[`"]\}?$/, '');
    // Drop `${…}` interpolations: a computed class cannot be checked statically.
    const classes = raw.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean);
    if (!classes.includes('btn')) continue;
    for (const c of classes) if (c !== 'btn') found.add(c);
  }
  return found;
}

/** The body of a top-level rule, brace-matched so nested blocks come with it. */
function ruleBody(selector: string): string {
  const at = scss.indexOf(`${selector} {`);
  expect(at, `${selector} not found in styles.scss`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = scss.indexOf('{', at); i < scss.length; i++) {
    if (scss[i] === '{') depth++;
    else if (scss[i] === '}' && --depth === 0) return scss.slice(at, i + 1);
  }
  throw new Error(`unterminated rule for ${selector}`);
}

/**
 * Whether a rule carrying this class could ever apply to a `.btn`.
 *
 * "Appears somewhere in the stylesheet" is the check that looks obvious and is
 * *wrong*, and wrong in precisely the way that let the bug through: `danger` did
 * appear, as `.menu-item.danger` and as `&.danger` inside `.chip`. Both style a
 * `danger` that is not a button's. So a bare `.danger` — one whose compound
 * selector names no other element — counts, `.btn.danger` counts, and `&.danger`
 * counts only inside `.btn`'s own body.
 */
function reachesAButton(variant: string): boolean {
  const boundary = '(?![\\w-])';
  // `.btn.danger` must not be satisfied by `.btn.danger-solid`, hence boundary.
  if (new RegExp(`\\.btn\\.${variant}${boundary}`).test(scss)) return true;
  if (new RegExp(`&\\.${variant}${boundary}`).test(ruleBody('.btn'))) return true;
  // Bare: not preceded by another class, by `&`, or by a name character.
  return new RegExp(`(^|[^.&\\w-])\\.${variant}${boundary}`, 'm').test(scss);
}

describe('button variants (NEWS-304)', () => {
  const variants = [...variantsInUse()].sort();

  it('finds the variants the client actually uses', () => {
    // A guard on the guard: if the scan silently stopped matching, every
    // assertion below would pass over an empty list.
    expect(variants.length).toBeGreaterThan(3);
    expect(variants).toContain('danger');
    expect(variants).toContain('primary');
    expect(variants).toContain('subtle');
  });

  it.each(variants)('.btn.%s is defined in the stylesheet', (variant) => {
    expect(reachesAButton(variant), `.btn.${variant} is applied in src/client but never styled`).toBe(true);
  });
});
