import { describe, expect, it } from 'vitest';

import { onboardingCountText, shouldOpenOnboarding } from '../../src/client/onboarding.js';

describe('shouldOpenOnboarding (NEWS-421)', () => {
  // The state a brand-new install is actually in. Everything below varies one
  // term off this.
  const fresh = { loaded: true, providerCount: 3, topicCount: 0, seen: false };

  it('opens for a new user who has nothing set up', () => {
    expect(shouldOpenOnboarding(fresh)).toBe(true);
  });

  it('still opens when a provider CLI is already signed in — the bug', () => {
    // This is the whole ticket. The condition used to also require *no usable
    // provider*, so anyone who already had `claude` or `codex` signed in never
    // saw the guide — and FR-20.5 treats a detected subscription as the best
    // case, presenting it first. The condition excluded the audience the flow
    // was written for.
    //
    // The count is deliberately the only term that moves: whether a provider is
    // available is a fact about the *machine*, established before this app was
    // installed, and must not reach this decision at all.
    expect(shouldOpenOnboarding({ ...fresh, providerCount: 9 })).toBe(true);
  });

  it('leaves an existing user alone', () => {
    // Having topics is what "existing user" means, and it is the only thing
    // that ever meant it.
    expect(shouldOpenOnboarding({ ...fresh, topicCount: 1 })).toBe(false);
  });

  it('does not reopen once dismissed', () => {
    expect(shouldOpenOnboarding({ ...fresh, seen: true })).toBe(false);
  });

  it('waits for the first state load rather than flashing at everyone', () => {
    // `topicCount` is 0 before `/api/state` answers too, so without this guard
    // every existing user gets the wizard for a frame on every reload. The
    // topic count is left at its pre-load value here on purpose — that is
    // exactly the state the guard exists for.
    expect(shouldOpenOnboarding({ ...fresh, loaded: false })).toBe(false);
  });

  it('waits for the provider list, which the Source step needs to render', () => {
    expect(shouldOpenOnboarding({ ...fresh, providerCount: 0 })).toBe(false);
  });

  it('walks a real first run: loading, ready, dismissed, and back next launch', () => {
    // A transition sequence rather than six independent one-shot cases, per the
    // testing philosophy: each step below passed in isolation while the flow as
    // a whole was broken.
    const seq = [
      { s: { loaded: false, providerCount: 0, topicCount: 0, seen: false }, want: false },
      { s: { loaded: true, providerCount: 0, topicCount: 0, seen: false }, want: false },
      { s: { loaded: true, providerCount: 3, topicCount: 0, seen: false }, want: true },
      { s: { loaded: true, providerCount: 3, topicCount: 0, seen: true }, want: false },
      { s: { loaded: true, providerCount: 3, topicCount: 5, seen: true }, want: false },
      // Relaunch: state reloads from scratch, the flag persists, and the guide
      // must stay shut even for the frame before topics arrive.
      { s: { loaded: false, providerCount: 3, topicCount: 0, seen: true }, want: false },
    ];
    expect(seq.map((c) => shouldOpenOnboarding(c.s))).toEqual(seq.map((c) => c.want));
  });
});

describe('onboardingCountText (NEWS-146)', () => {
  it('reassures rather than scolds when nothing has been picked', () => {
    const text = onboardingCountText(0, 0);
    expect(text).toContain('None yet');
    expect(text).toContain('that’s fine');
  });

  it('says a chosen topic is not created yet', () => {
    // The distinction is the whole point of the line: a ticked chip can still be
    // unticked, so it must not read as though it already exists.
    expect(onboardingCountText(3, 0)).toContain('3 chosen, created when you finish');
    expect(onboardingCountText(3, 0)).not.toContain('added already');
  });

  it('says an added topic already exists and is already working', () => {
    expect(onboardingCountText(0, 2)).toContain('2 added already and checking');
    expect(onboardingCountText(0, 2)).not.toContain('chosen');
  });

  it('names both when both happened, chosen first', () => {
    const text = onboardingCountText(3, 2);
    expect(text).toContain('3 chosen, created when you finish');
    expect(text).toContain('2 added already and checking');
    expect(text.indexOf('chosen')).toBeLessThan(text.indexOf('added'));
    expect(text).toContain('·');
  });

  it('keeps the per-topic cost warning whenever there is anything to warn about', () => {
    for (const [chosen, added] of [
      [1, 0],
      [0, 1],
      [4, 4],
    ] as const) {
      expect(onboardingCountText(chosen, added)).toContain('more topics means more checks');
    }
    expect(onboardingCountText(0, 0)).not.toContain('more checks');
  });

  it('treats a negative added count as none', () => {
    // `added` is a subtraction against the count when the step opened, and a
    // topic deleted from the sidebar mid-flow drives it below zero. "-1 added
    // already" is the kind of thing that ships because nobody deletes a topic
    // during setup — until someone does.
    expect(onboardingCountText(0, -1)).toContain('None yet');
    expect(onboardingCountText(2, -1)).toBe(onboardingCountText(2, 0));
  });
});
