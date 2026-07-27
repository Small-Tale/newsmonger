/**
 * Solo-filter set arithmetic (NEWS-29, NEWS-95).
 *
 * Extracted from `app.tsx` because two gestures now reach it — the right-click
 * menu's Solo/Unsolo item and a double-click on a topic row — and a filter that
 * behaves differently depending on how you invoked it would be worse than
 * having no shortcut at all. Keeping it here also makes it unit-testable;
 * `app.tsx` touches `document` at import time and can't be pulled into vitest.
 */

/**
 * Toggle `ids` in the current solo set.
 *
 * **Additive, and toggled as a group.** Soloing a second topic widens the
 * filter to both rather than replacing the first — a solo is "show me these",
 * so building one up a topic at a time is the useful behaviour. Un-soloing
 * happens only when *every* targeted topic is already soloed, which is what
 * makes a mixed multi-selection resolve toward adding: the alternative
 * (toggling each row independently) would invert whichever rows happened to be
 * soloed already and leave a set nobody asked for.
 *
 * Order of the surviving ids is preserved; new ids append in the order given.
 * Returns a new array — the caller hands it straight to a signal setter, and
 * mutating the current one in place would defeat change detection.
 */
export function toggleSolo(current: readonly string[], ids: readonly string[]): string[] {
  const next = new Set(current);
  const allSoloed = ids.length > 0 && ids.every((id) => next.has(id));
  for (const id of ids) {
    if (allSoloed) next.delete(id);
    else next.add(id);
  }
  return [...next];
}

/**
 * Whether the menu should read "Unsolo" rather than "Solo" for `ids` — true
 * only when every target is already soloed, mirroring {@link toggleSolo} so the
 * label always names what the click will actually do.
 */
export function isAllSoloed(current: readonly string[], ids: readonly string[]): boolean {
  const solo = new Set(current);
  return ids.length > 0 && ids.every((id) => solo.has(id));
}
