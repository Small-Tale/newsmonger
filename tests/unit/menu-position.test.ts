import { describe, expect, it } from 'vitest';

import { menuStyle, placeMenu } from '../../src/client/menu-position.js';

/** A roomy desktop window, where nothing should need clamping. */
const VW = 1280;
const VH = 800;

describe('placeMenu (NEWS-149)', () => {
  it('leaves a menu with room to spare exactly where it was opened', () => {
    // Clamping must be invisible in the ordinary case — a menu that drifts from
    // the cursor when it did not need to reads as a bug of its own.
    expect(placeMenu(400, 300, VW, VH)).toMatchObject({ left: 400, top: 300 });
  });

  it('lifts a menu opened near the bottom so its last item stays reachable', () => {
    // The bug: the topic menu has eight items with Delete last, so the bottom
    // edge takes the most destructive action out of reach first — and a fixed
    // menu inside a full-screen backdrop cannot be scrolled back.
    const { top, maxHeight } = placeMenu(400, 790, VW, VH);
    expect(top).toBeLessThan(790);
    expect(top + maxHeight).toBeLessThanOrEqual(VH);
  });

  it('pulls a menu opened near the right edge back into the window', () => {
    const { left } = placeMenu(1275, 300, VW, VH);
    expect(left).toBeLessThan(1275);
    expect(left + 184).toBeLessThanOrEqual(VW);
  });

  it('keeps a margin from the edges rather than sitting flush against them', () => {
    const bottomRight = placeMenu(VW, VH, VW, VH);
    expect(bottomRight.left).toBeLessThan(VW - 184);
    expect(bottomRight.top).toBeLessThan(VH);
    const topLeft = placeMenu(0, 0, VW, VH);
    expect(topLeft.left).toBeGreaterThan(0);
    expect(topLeft.top).toBeGreaterThan(0);
  });

  it('never places a menu off the top or left, even from a negative anchor', () => {
    const { left, top } = placeMenu(-50, -50, VW, VH);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it('pins to the top-left and shrinks in a viewport too small for the menu', () => {
    // The clamp meant to rescue the menu would otherwise push it off the
    // *opposite* edge, which is strictly worse: at least this way the first
    // items are visible and the rest scroll.
    const { left, top, maxHeight } = placeMenu(100, 100, 200, 120);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top + maxHeight).toBeLessThanOrEqual(120);
    expect(maxHeight).toBeGreaterThan(0);
  });

  it('always fits inside the viewport, wherever it is opened', () => {
    // The property the individual cases are examples of. Swept rather than
    // spot-checked, because the failure mode is an edge nobody thought to name.
    for (const vw of [320, 768, 1280, 2560]) {
      for (const vh of [400, 800, 1440]) {
        for (const x of [0, 1, vw / 2, vw - 1, vw]) {
          for (const y of [0, 1, vh / 2, vh - 1, vh]) {
            const { left, top, maxHeight } = placeMenu(x, y, vw, vh);
            const where = `${String(vw)}x${String(vh)} @ ${String(x)},${String(y)}`;
            expect(left, where).toBeGreaterThanOrEqual(0);
            expect(top, where).toBeGreaterThanOrEqual(0);
            expect(top + maxHeight, where).toBeLessThanOrEqual(vh);
            // A menu clamped down to nothing is not "on screen", it is gone.
            expect(maxHeight, where).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('renders as an inline style carrying all three values', () => {
    expect(menuStyle(400, 300, VW, VH)).toBe('left:400px;top:300px;max-height:492px');
  });
});
