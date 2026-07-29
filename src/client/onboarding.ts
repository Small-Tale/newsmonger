/**
 * Pure logic for the first-run flow (NEWS-78).
 *
 * Its own module for the same reason `dial.ts` and `topic-sort.ts` are: the
 * wording below has real branching, and a branch that only ever runs inside a
 * rendered dialog is a branch that only ever gets tested through a browser.
 */

/**
 * The Topics step's running total (NEWS-146).
 *
 * There are **two** ways to leave that step with topics, and they behave
 * differently: a ticked starter chip is a reservation that Finish turns into a
 * topic, while anything added in the discovery dialog already exists and is
 * already checking. One combined number would be a lie about the half that can
 * no longer be unticked, so each is named and told apart by what happens next.
 *
 * `added` is a *difference* against the count when the step opened rather than a
 * raw total: onboarding is normally a first run, but Settings can reopen it for
 * someone who already has topics, and those are not something they just added.
 */
export function onboardingCountText(chosen: number, added: number): string {
  if (chosen <= 0 && added <= 0) return 'None yet — that’s fine, you can add topics from the sidebar.';
  const parts: string[] = [];
  if (chosen > 0) parts.push(`${String(chosen)} chosen, created when you finish`);
  if (added > 0) parts.push(`${String(added)} added already and checking`);
  return `${parts.join(' · ')}. Each is checked on its own, so more topics means more checks.`;
}
