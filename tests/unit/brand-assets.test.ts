import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The brand assets and the stylesheet have to agree (NEWS-174).
 *
 * The masthead is an SVG file (FR-3.58) sitting beside buttons and pills that
 * are coloured from CSS custom properties. Nothing connects the two: the mark's
 * green is baked into the file, the app's green lives in `styles.scss`, and a
 * change to either is invisible to the other. That gap has now produced the
 * same bug twice — first `wordmark-dark.svg` shipped with the *light* green
 * (2.39:1 on the dark page), then both files were set to the *dark* green,
 * which moved the failure to light mode (2.60:1) rather than fixing it.
 *
 * Both rounds were caught by eye, which is not a mechanism. These tests read
 * the real files and assert the relationship, so the next drift fails a gate.
 *
 * A note on the threshold: WCAG exempts logotypes from contrast minimums
 * (SC 1.4.3 / 1.4.11), so this is not an accessibility conformance test and the
 * axe suite is unaffected either way. It is a legibility floor — at masthead
 * size, an accent that fails 3:1 against its own page reads as washed out next
 * to every other accented element in the header.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scss = fs.readFileSync(path.join(root, 'src/client/styles.scss'), 'utf8');

/** Relative luminance, per the WCAG 2.x definition. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio between two opaque colours, 1:1 … 21:1. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The token values for one theme.
 *
 * Light lives in the first `:root`; dark lives in the `:root` nested inside the
 * `prefers-color-scheme: dark` block, which is the *second* `:root {` in the
 * file. Slicing from that offset is what makes the dark lookup find the
 * override rather than the base value.
 */
function tokens(theme: 'light' | 'dark'): (name: string) => string {
  const darkAt = scss.indexOf('@media (prefers-color-scheme: dark)');
  expect(darkAt).toBeGreaterThan(-1);
  const scope = theme === 'light' ? scss.slice(0, darkAt) : scss.slice(darkAt);
  return (name) => {
    const found = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(scope);
    if (found === null) throw new Error(`--${name} not found in the ${theme} token block`);
    return found[1].toUpperCase();
  };
}

/**
 * The two fills of a wordmark, in document order: the "News" half, then the
 * "monger." half. Reading them positionally rather than by `id` keeps the test
 * working if the paths are renamed by the drawing tool, which has already
 * happened once (`monger` → `monger.` when the period was folded in).
 */
function wordmarkFills(file: string): { ink: string; accent: string } {
  const svg = fs.readFileSync(path.join(root, 'assets', file), 'utf8');
  const fills = [...svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toUpperCase());
  expect(fills, `${file} should declare exactly two colour fills`).toHaveLength(2);
  return { ink: fills[0], accent: fills[1] };
}

describe('wordmark assets track the stylesheet (NEWS-174)', () => {
  it.each([
    { theme: 'light' as const, file: 'wordmark-light.svg' },
    { theme: 'dark' as const, file: 'wordmark-dark.svg' },
  ])('$file uses the $theme --pine', ({ theme, file }) => {
    // The accent is the whole point: the mark sits inches from the "Check all
    // now" button, and two greens that are merely *similar* read as a mistake.
    expect(wordmarkFills(file).accent).toBe(tokens(theme)('pine'));
  });

  it.each([
    { theme: 'light' as const, file: 'wordmark-light.svg' },
    { theme: 'dark' as const, file: 'wordmark-dark.svg' },
  ])('$file stays legible on the $theme --paper', ({ theme, file }) => {
    const { ink, accent } = wordmarkFills(file);
    const paper = tokens(theme)('paper');

    // 3:1 is the floor for large text and graphic marks. Both halves are
    // checked: the ink half has never been the problem, which is exactly why
    // it would go unnoticed if a future edit broke it.
    expect(contrast(accent, paper), `${file} accent ${accent} on ${paper}`).toBeGreaterThanOrEqual(3);
    expect(contrast(ink, paper), `${file} ink ${ink} on ${paper}`).toBeGreaterThanOrEqual(4.5);
  });

  it('pairs each mark with the page it is served on, not the other one', () => {
    // The regression that shipped twice was a mark wearing the *other* theme's
    // green. Asserting the right pairing passes even then, because the wrong
    // green can still clear 3:1 on the wrong page — so assert the mismatch is
    // detectable too, and pin why swapping them is wrong.
    const light = wordmarkFills('wordmark-light.svg');
    const dark = wordmarkFills('wordmark-dark.svg');
    expect(light.accent).not.toBe(dark.accent);

    const lightPaper = tokens('light')('paper');
    const darkPaper = tokens('dark')('paper');
    expect(contrast(dark.accent, lightPaper)).toBeLessThan(3);
    expect(contrast(light.accent, darkPaper)).toBeLessThan(3);
  });
});
