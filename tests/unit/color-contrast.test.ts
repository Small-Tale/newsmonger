import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Palette contrast, checked without rendering anything (NEWS-346).
 *
 * `tests/e2e/a11y.spec.ts` runs axe over the real UI and is the authority on
 * what a reader actually meets. It has one structural blind spot: it can only
 * see a violation on an element that happens to be **rendering**. The failure
 * this file exists for was a warn badge on the Source tab, shown once per
 * *unavailable* provider — so on a developer machine with a signed-in CLI it
 * never appeared, `npm run test:all` passed, and CI went red on push. The gate
 * meant to catch things before they land was the one that could not see it.
 *
 * A token pair has a contrast ratio whether or not anything is on screen, so
 * that is what this checks: read the values out of the stylesheet and do the
 * arithmetic. Milliseconds, deterministic, and blind to which CLIs are signed
 * in. It does not replace the axe suite — it catches the palette half early.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scss = fs.readFileSync(path.join(root, 'src/client/styles.scss'), 'utf8');

/** Pull `--name: #hex;` declarations out of one block of the stylesheet. */
function tokensIn(block: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    found[match[1]] = match[2].toLowerCase();
  }
  return found;
}

/** The `:root { … }` block, i.e. the light palette. */
function lightBlock(): string {
  const start = scss.indexOf(':root {');
  return scss.slice(start, scss.indexOf('\n}', start));
}

/** The `@mixin dark-tokens { … }` block, which both dark selectors include. */
function darkBlock(): string {
  const start = scss.indexOf('@mixin dark-tokens {');
  return scss.slice(start, scss.indexOf('\n  }', start));
}

const LIGHT = tokensIn(lightBlock());
const DARK = tokensIn(darkBlock());

/** WCAG 2 relative luminance. */
function luminance(hex: string): number {
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff)
  );
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Every token pair the stylesheet puts text on.
 *
 * Hand-listed rather than derived: which token is a foreground and which a
 * background is a fact about the rules, not about the palette, and a generated
 * cross-product would assert nonsense pairs that never meet.
 */
const TEXT_PAIRS: { fg: string; bg: string; where: string }[] = [
  { fg: 'ink', bg: 'paper', where: 'body text on the page' },
  { fg: 'ink', bg: 'panel', where: 'body text in a dialog or card' },
  { fg: 'ink-soft', bg: 'paper', where: 'hints and meta on the page' },
  { fg: 'ink-soft', bg: 'panel', where: 'hints and meta in a dialog' },
  { fg: 'pine', bg: 'paper', where: 'links and the ok state' },
  { fg: 'pine', bg: 'panel', where: 'links and the ok state in a dialog' },
  { fg: 'pine', bg: 'pine-soft', where: 'topic chips' },
  // The three that failed. `.state.warn`, `.error-note`, and the `.ongoing`
  // badge — which sits on `--warn-bg` and was the worst of them at 2.91:1.
  { fg: 'marigold', bg: 'panel', where: '.state.warn on the Source tab' },
  { fg: 'marigold', bg: 'paper', where: '.error-note' },
  { fg: 'marigold', bg: 'warn-bg', where: 'the .ongoing badge' },
  { fg: 'ink', bg: 'warn-bg', where: 'the warning banner' },
  { fg: 'ink', bg: 'error-bg', where: 'the error banner' },
];

/** WCAG AA for normal-size text. The app's smallest text is ~10.5px. */
const AA_TEXT = 4.5;

/**
 * Icons and borders, which WCAG 1.4.11 holds to 3:1 rather than 4.5:1.
 *
 * Kept separate rather than folded into `TEXT_PAIRS` at a lower bar, because
 * the threshold is a fact about *what the thing is*, and a reader of this file
 * should be able to see which rule each pair is being judged by.
 */
const GRAPHIC_PAIRS: { fg: string; bg: string; where: string }[] = [
  // The high-priority star (NEWS-363). It sits in the sidebar rail, and the row
  // under it turns `--pine-soft` on hover and when selected — so it must clear
  // the bar on both, and `--pine-soft` is the tighter of the two.
  { fg: 'marigold', bg: 'paper', where: 'the high-priority star in the rail' },
  { fg: 'marigold', bg: 'pine-soft', where: 'the star on a hovered or selected row' },
];

/** WCAG AA for icons, borders and other non-text (1.4.11). */
const AA_GRAPHIC = 3;

/**
 * Custom properties that are deliberately never declared in a palette, because
 * something sets them at runtime. Each needs a reason, and the reason is the
 * point: `--amber` looked exactly like these until NEWS-363, and was not.
 */
const RUNTIME_TOKENS: Record<string, string> = {
  'rail-top': 'set on documentElement by src/client/rail.ts (NEWS-325)',
  'discover-duration': 'set inline per element by src/client/discover-view.tsx',
};

/**
 * The stylesheet with comments removed.
 *
 * Required, not tidiness: this file's own prose names the tokens it is about,
 * so a scan over the raw source finds `var(--amber, …)` inside the comment that
 * explains why `--amber` is gone, and reports the bug it just fixed.
 */
function withoutComments(src: string): string {
  return src.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/[^\n]*/g, '');
}

describe('palette contrast (NEWS-346)', () => {
  it('reads both palettes out of the stylesheet', () => {
    // A parse that silently found nothing would make every assertion below
    // vacuous — the failure mode a test like this actually has.
    expect(Object.keys(LIGHT).length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(DARK).length).toBeGreaterThanOrEqual(8);
    expect(LIGHT['marigold']).not.toBe(DARK['marigold']);
  });

  it('defines every token the dark palette overrides, and vice versa', () => {
    // A token fixed in one palette and forgotten in the other is a theme that
    // is wrong only when pinned — and nothing else would notice.
    const colourish = Object.keys(LIGHT).filter((k) => !k.includes('shadow'));
    for (const name of colourish) {
      expect(DARK, `dark palette defines --${name}`).toHaveProperty(name);
    }
  });

  for (const { fg, bg, where } of TEXT_PAIRS) {
    it(`light: --${fg} on --${bg} is readable (${where})`, () => {
      expect(LIGHT, `--${fg} is defined`).toHaveProperty(fg);
      expect(LIGHT, `--${bg} is defined`).toHaveProperty(bg);
      expect(contrast(LIGHT[fg], LIGHT[bg])).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it(`dark: --${fg} on --${bg} is readable (${where})`, () => {
      expect(DARK, `--${fg} is defined`).toHaveProperty(fg);
      expect(DARK, `--${bg} is defined`).toHaveProperty(bg);
      expect(contrast(DARK[fg], DARK[bg])).toBeGreaterThanOrEqual(AA_TEXT);
    });
  }

  for (const { fg, bg, where } of GRAPHIC_PAIRS) {
    it(`light: --${fg} on --${bg} clears the graphic bar (${where})`, () => {
      expect(contrast(LIGHT[fg], LIGHT[bg])).toBeGreaterThanOrEqual(AA_GRAPHIC);
    });

    it(`dark: --${fg} on --${bg} clears the graphic bar (${where})`, () => {
      expect(contrast(DARK[fg], DARK[bg])).toBeGreaterThanOrEqual(AA_GRAPHIC);
    });
  }

  it('computes a ratio the way WCAG does', () => {
    // Pinned against known values, so a broken formula cannot quietly pass
    // everything above.
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // Order must not matter.
    expect(contrast('#895e1b', '#fbfcfb')).toBeCloseTo(contrast('#fbfcfb', '#895e1b'), 10);
  });
});

/**
 * Every `var(--x)` resolves to something (NEWS-363).
 *
 * The bug this catches is quiet in a way the contrast checks above are not. A
 * `var()` naming a token no palette declares does **not** fail loudly:
 *
 * - with a literal fallback it silently renders that literal, in both themes,
 *   so a value nobody chose survives a palette change that was supposed to
 *   cover it — `var(--amber, #c8891b)` in three rules, at 2.90:1;
 * - with **no** fallback the declaration is invalid at computed-value time, so
 *   the property takes its initial value. `border: 1px solid var(--rule)` drew
 *   no border, and `outline: 2px solid var(--accent)` in a `:focus-within`
 *   rule drew **no focus ring** — an author rule still beats the UA default,
 *   so the browser's own ring did not come back.
 *
 * Neither shows up in a contrast table, because there is no pair to check, and
 * neither shows up in axe: the first renders a colour that is merely wrong, and
 * axe has no focus-visibility rule for the second. The declaration is the thing
 * to assert on.
 */
describe('custom properties resolve (NEWS-363)', () => {
  const code = withoutComments(scss);
  const declared = new Set([...code.matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1]));
  const used = [...new Set([...code.matchAll(/var\(\s*--([\w-]+)/g)].map((m) => m[1]))].sort();

  it('found the declarations and the uses', () => {
    // A regex that quietly matched nothing would make the assertion below pass
    // for the wrong reason — the failure mode every scan test has.
    expect(declared.size).toBeGreaterThanOrEqual(10);
    expect(used.length).toBeGreaterThanOrEqual(10);
    expect(used).toContain('marigold');
  });

  it('strips comments before scanning', () => {
    // This file's own prose names `--amber`, and so does the stylesheet comment
    // recording why it went away. Scanning raw source would rediscover the
    // fixed bug in the sentence explaining the fix.
    expect(withoutComments('a { /* var(--gone) */ color: red; }')).not.toContain('--gone');
    expect(withoutComments('a { // var(--gone)\n  color: red; }')).not.toContain('--gone');
    expect(withoutComments('a { color: var(--kept); }')).toContain('--kept');
  });

  it('leaves no var() naming a token nothing defines', () => {
    const orphans = used.filter((name) => !declared.has(name) && !(name in RUNTIME_TOKENS));
    expect(orphans, `undeclared custom properties: ${orphans.join(', ')}`).toEqual([]);
  });

  it('still sets every token claimed to be set at runtime', () => {
    // The escape hatch above is only honest while the runtime setter is real.
    // Delete `rail.ts`'s setProperty and `--rail-top` becomes an orphan wearing
    // an exemption.
    const sources = ['src/client/rail.ts', 'src/client/discover-view.tsx']
      .map((f) => fs.readFileSync(path.join(root, f), 'utf8'))
      .join('\n');
    for (const name of Object.keys(RUNTIME_TOKENS)) {
      expect(sources, `--${name} is set somewhere`).toContain(`--${name}`);
    }
  });
});
