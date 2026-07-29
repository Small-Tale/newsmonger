import { describe, expect, it } from 'vitest';

import { onboardingCountText } from '../../src/client/onboarding.js';

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
