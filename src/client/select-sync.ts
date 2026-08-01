/**
 * Keep a `<select>`'s live value on the option the render actually chose
 * (NEWS-238).
 *
 * ## The bug
 *
 * A `<select>` has two notions of what is chosen. The `selected` **content
 * attribute** is what a template writes, and the option's **selectedness
 * property** is what the user sees and what `el.value` reports. Per HTML, once
 * an option's selectedness has been set by the user or by script, its dirtiness
 * flag is set and *changes to the content attribute no longer move the
 * selection*.
 *
 * kerf handles this: when a morph changes a `selected` attribute it also sets
 * the property, so the dirty flag is bypassed. **But it can only do that when
 * the attribute changes.** If the rendered attribute is already where it should
 * be, there is nothing to diff, no property write, and a value the user has
 * moved stays moved — permanently, because every later render agrees with the
 * DOM and changes nothing.
 *
 * That is not hypothetical. Captured from a CI failure, on one element:
 *
 *     "action": "hp-interval", "value": "10800000", "attrOn": "3600000"
 *
 * The attribute says 1 hour, the control shows 3. It reached that state because
 * the user picked 3 hours while the server's answer — after a clamp — was the
 * 1 hour already rendered. Nothing changed, so nothing was synced.
 *
 * For a user: set the default check interval below the high-priority one, and
 * the high-priority dropdown keeps showing the old value even though the server
 * has clamped it. The stored setting is right; the UI lies about it until
 * something else happens to move that attribute.
 *
 * ## The fix
 *
 * After every render, make the attribute authoritative — which it already is
 * conceptually, since it is what the render decided. The property is the copy
 * that drifts.
 *
 * Deliberately driven by the attribute rather than by app state: it needs no
 * per-control wiring, it cannot disagree with what was just rendered, and it
 * covers every `<select>` the app has or gains. And it is inert whenever the two
 * already agree, which is almost always.
 */

/** One `<select>`'s two notions of what is chosen, as far as the rule cares. */
export interface SelectState {
  /** What `el.value` reports — the property, and what the user sees. */
  value: string;
  /** The value of the option carrying the `selected` attribute, if any. */
  attrValue: string | null;
}

/**
 * The value this select should be set to, or `null` to leave it alone.
 *
 * Split out from the DOM so the rule is unit-testable — the whole failure was
 * invisible for weeks precisely because it only appeared in a browser under an
 * interleaving no test could schedule.
 */
export function selectValueToApply(state: SelectState): string | null {
  // No option carries the attribute: the render expressed no opinion (a control
  // whose options are all unselected), so there is nothing to enforce. Writing
  // a value here would invent a choice the app never made.
  if (state.attrValue === null) return null;
  return state.attrValue === state.value ? null : state.attrValue;
}

/**
 * Apply the rule to every `<select>` under `root`.
 *
 * Returns how many it corrected, which is what makes "this did something" an
 * assertion rather than an assumption.
 */
export function syncSelects(root: ParentNode): number {
  let fixed = 0;
  for (const el of root.querySelectorAll('select')) {
    const attrOption = [...el.options].find((o) => o.hasAttribute('selected'));
    const next = selectValueToApply({ value: el.value, attrValue: attrOption?.value ?? null });
    if (next !== null) {
      el.value = next;
      fixed++;
    }
  }
  return fixed;
}
