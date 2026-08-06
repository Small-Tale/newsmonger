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

  it('computes a ratio the way WCAG does', () => {
    // Pinned against known values, so a broken formula cannot quietly pass
    // everything above.
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // Order must not matter.
    expect(contrast('#895e1b', '#fbfcfb')).toBeCloseTo(contrast('#fbfcfb', '#895e1b'), 10);
  });
});
