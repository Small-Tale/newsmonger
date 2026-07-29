/**
 * Keeping a context menu on screen (NEWS-149).
 *
 * Both menus are `position: fixed` at the raw cursor point. That is right until
 * the cursor is near an edge, at which point the menu simply runs off it — and
 * because it is fixed inside a full-screen backdrop, **scrolling cannot bring it
 * back**. The topic menu has eight items with Delete last, so the bottom edge
 * takes away the most destructive action first and leaves no way to reach it.
 *
 * A pure function so the arithmetic is testable without a browser, in the style
 * of `dial.ts` and `topic-sort.ts`.
 */

/** Gap kept between the menu and the window edge, so it never looks wedged in. */
const MARGIN = 8;

/** `min-width` from `.menu` in `styles.scss`; keep the two in step. */
const MENU_WIDTH = 184;

/**
 * Enough for the tallest menu we have (the eight-item topic menu with its
 * separators), used only to *place* the menu.
 *
 * Being an estimate is fine because it is not the safety net: `maxHeight` below
 * is computed from the space actually left, so a menu taller than this scrolls
 * rather than overflowing. This number only decides whether the menu opens at
 * the cursor or is nudged up to sit above the fold.
 */
const MENU_HEIGHT = 300;

export interface MenuPlacement {
  left: number;
  top: number;
  /** Space left below `top`, so an unexpectedly tall menu scrolls instead of overflowing. */
  maxHeight: number;
}

/**
 * Place a menu opened at (`x`, `y`) inside a `vw` × `vh` viewport.
 *
 * Clamped rather than flipped. A flipped menu jumps to the other side of the
 * cursor, which moves the item under the pointer somewhere else entirely at the
 * moment the user is reaching for it; nudging it just far enough to fit keeps
 * every item roughly where the user saw it appear.
 *
 * The top clamp is applied before `maxHeight` is derived from it, so a menu that
 * fits gets its full height and only one that genuinely cannot fit — a viewport
 * shorter than the menu — ends up scrollable.
 */
export function placeMenu(x: number, y: number, vw: number, vh: number): MenuPlacement {
  // `Math.max(MARGIN, …)` comes second so it wins on a viewport too small for
  // the menu at all: better pinned to the top-left and scrollable than pushed
  // off the opposite edge by the clamp meant to rescue it.
  const left = Math.max(MARGIN, Math.min(x, vw - MENU_WIDTH - MARGIN));
  const top = Math.max(MARGIN, Math.min(y, vh - MENU_HEIGHT - MARGIN));
  return { left, top, maxHeight: Math.max(0, vh - top - MARGIN) };
}

/** `placeMenu` as the inline style the menus carry. */
export function menuStyle(x: number, y: number, vw: number, vh: number): string {
  const { left, top, maxHeight } = placeMenu(x, y, vw, vh);
  return `left:${String(left)}px;top:${String(top)}px;max-height:${String(maxHeight)}px`;
}
