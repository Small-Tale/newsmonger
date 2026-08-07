/**
 * Pure logic for the first-run flow (NEWS-78).
 *
 * Its own module for the same reason `dial.ts` and `topic-sort.ts` are: the
 * wording below has real branching, and a branch that only ever runs inside a
 * rendered dialog is a branch that only ever gets tested through a browser.
 */

/**
 * Whether the first-run guide should open by itself (FR-20.1, NEWS-421).
 *
 * A pure function here rather than a branch inside `maybeOpenOnboarding`, for
 * the reason this module exists: a decision that only runs against a live store
 * inside a rendered app only ever gets tested through a browser — and this one
 * had **no test at all**, which is how it stayed wrong.
 *
 * **Having no topics is the whole test.** It used to also require no usable
 * provider, on the reasoning that someone with either was an existing user who
 * must not be interrupted. The topic count alone already says that. The provider
 * half was actively harmful: a signed-in `claude-cli` is a fact about the
 * *machine*, true before this app was installed, and says nothing about whether
 * Newsmonger is set up. Anyone arriving with Claude Code or Codex already
 * signed in — which FR-20.5 treats as the *best* case — got no guide, ever.
 *
 * It also made first-run behaviour depend on unrelated host state, which the
 * E2E harness had already been bitten by: NEWS-193 records the suite passing on
 * a dev machine and failing on CI for exactly this reason.
 *
 * `loaded` is essential and not paranoia: `topicCount` is 0 before the first
 * `/api/state` answers too, so without it the wizard flashes at every existing
 * user on every reload.
 */
export function shouldOpenOnboarding(s: {
  loaded: boolean;
  providerCount: number;
  topicCount: number;
  seen: boolean;
}): boolean {
  if (!s.loaded || s.providerCount === 0) return false;
  return s.topicCount === 0 && !s.seen;
}

/**
 * Continent quick-fills for the Location step (NEWS-394).
 *
 * Six hardcoded strings that fill the free-text field, **not a picker over a
 * dataset** — there is deliberately no place list (FR-35.2). They exist because
 * "a continent is enough" is a claim the hint text makes and nobody believes
 * until they see a continent offered as a real answer.
 */
export const LOCATION_QUICK_PICKS = [
  'Africa',
  'Asia',
  'Europe',
  'North America',
  'Oceania',
  'South America',
] as const;

/**
 * Where `Continue` goes from the profile picker (NEWS-383).
 *
 * The step owns three pages behind one wizard step, so the primary button has
 * two jobs and this decides which. Extracted rather than inlined in the delegate
 * for the reason the whole module exists: a branch that only runs inside a
 * rendered dialog only ever gets tested through a browser.
 *
 * `page` is clamped, not trusted — it arrives from state that a stale render
 * could have left out of range, and landing on the last page beats rendering
 * nothing.
 */
export function nextProfilePage(page: number, pageCount: number): { page: number; advanceStep: boolean } {
  if (pageCount <= 0) return { page: 0, advanceStep: true };
  const at = Math.max(0, Math.min(pageCount - 1, Math.trunc(page)));
  return at >= pageCount - 1 ? { page: at, advanceStep: true } : { page: at + 1, advanceStep: false };
}

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
