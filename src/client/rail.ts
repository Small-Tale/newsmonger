/**
 * Keep `--rail-top` in step with where the sidebar rail actually is (NEWS-325, NEWS-339).
 *
 * `styles.scss` bounds the rail with `max-height: calc(100vh - var(--rail-top) - 24px)`
 * so its foot — the add-topic form and the privacy link — stays reachable however
 * many topics are being watched. That calculation needs the rail's distance from
 * the **top of the viewport**, and CSS cannot ask a sticky element where it
 * currently is.
 */

/**
 * The rail's distance from the top of the viewport, in px.
 *
 * `getBoundingClientRect().top`, and the choice is the whole of NEWS-339.
 * This was `offsetTop`, which is *document*-relative — and on a `position: sticky`
 * element the browser reports the **sticky-shifted** position, so it grows with
 * the scroll. Scrolled 3000px down, `offsetTop` read 3024 where the rail was
 * still sitting 24px below the top of the window. Publishing that made the
 * max-height `calc(100vh - 3024px - 24px)`, which clamps to **0**: the topic list
 * collapsed to nothing with all its rows still in the DOM, and stayed collapsed
 * after scrolling back up, because nothing recomputed it.
 *
 * The viewport-relative reading is correct in both states without a special
 * case — 24px once the rail has stuck, and its full flow offset at the top of
 * the page, which is the state NEWS-325 was about.
 *
 * Floored at 0: a negative top would *inflate* the max-height, and a rail taller
 * than the window is the one thing this must never produce.
 */
export function railTopPx(rail: { getBoundingClientRect: () => { top: number } }): number {
  return Math.max(0, Math.round(rail.getBoundingClientRect().top));
}

/**
 * Publish `--rail-top` and keep it current.
 *
 * Recomputed on **scroll** as well as on resize, which the `offsetTop` version
 * did not do — it assumed the value was scroll-independent, and that assumption
 * is exactly what was wrong. Without it the rail could be left collapsed by a
 * poll that landed while the reader was scrolled down, with no way back.
 *
 * Coalesced through `requestAnimationFrame`, so a scroll costs one measurement
 * per frame rather than one per event. There is no feedback loop to worry
 * about: this changes the rail's *height*, and its `top` does not depend on
 * that, so the next measurement returns the same number and the write is a
 * no-op.
 */
export function trackRailTop(root: HTMLElement): void {
  let queued = false;
  const publish = (): void => {
    queued = false;
    const rail = root.querySelector<HTMLElement>('.topics-panel');
    if (rail === null) return;
    document.documentElement.style.setProperty('--rail-top', `${String(railTopPx(rail))}px`);
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(publish);
  };

  publish();
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  // The rail's offset also moves when the rows above it change height — a banner
  // appearing, the filter chips wrapping — not only when the window resizes.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(schedule).observe(root);
  }
}
