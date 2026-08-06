import { describe, expect, it } from 'vitest';

import { railTopPx } from '../../src/client/rail.js';

/**
 * The sidebar rail's viewport offset (NEWS-339).
 *
 * `styles.scss` bounds the rail with `calc(100vh - var(--rail-top) - 24px)`, so
 * this number decides whether the topic list has any height at all. It used to
 * come from `offsetTop`, which is document-relative and — on a `position: sticky`
 * element — reports the sticky-*shifted* position. Scrolled far enough down, that
 * made the max-height negative, clamped to 0, and collapsed the list to nothing
 * with every row still in the DOM.
 *
 * The whole fix is which of two numbers gets read, so that is what these pin.
 */

/** A rail that is `flowTop` down the document and `viewportTop` down the window. */
function rail(viewportTop: number, flowTop: number): { getBoundingClientRect: () => { top: number }; offsetTop: number } {
  return { getBoundingClientRect: () => ({ top: viewportTop }), offsetTop: flowTop };
}

describe('railTopPx (NEWS-339)', () => {
  it('reads the viewport offset, not the document one', () => {
    // The measured failure: scrolled 3000px, `offsetTop` said 3024 while the
    // rail sat 24px below the top of the window. Publishing 3024 produced
    // `calc(100vh - 3024px - 24px)` — zero, and the list vanished.
    expect(railTopPx(rail(24, 3024))).toBe(24);
  });

  it('is unchanged by how far the page has been scrolled', () => {
    // A stuck rail is 24px from the top of the window at every scroll depth, so
    // the published value has to be the same at each of them.
    const stuck = [rail(24, 174), rail(24, 3024), rail(24, 91_000)];
    expect(stuck.map(railTopPx)).toEqual([24, 24, 24]);
  });

  it('still reports the full offset before the rail has stuck', () => {
    // NEWS-325's case, which must keep working: at the top of the page the rail
    // sits below the masthead and filters, and the bound has to account for it
    // or the privacy link falls below the fold.
    expect(railTopPx(rail(174, 174))).toBe(174);
  });

  it('floors a negative offset at zero', () => {
    // A negative top would *inflate* the max-height, and a rail taller than the
    // window is the one outcome this must never produce.
    expect(railTopPx(rail(-40, 0))).toBe(0);
  });

  it('rounds to a whole pixel', () => {
    // Fractional layout is normal at non-integer zoom; the value goes into a
    // `px` string either way, so it should be a number CSS will not re-round.
    expect(railTopPx(rail(23.6, 0))).toBe(24);
  });
});
