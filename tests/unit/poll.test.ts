import { describe, expect, it } from 'vitest';

import { POLL_INTERVAL_MS, startPolling } from '../../src/client/poll.js';

/**
 * The client's poll *scheduling*, at the level where the ordering can be chosen
 * (NEWS-238).
 *
 * The bug class these exist for is "the server changed and the UI never said
 * so", and its two known sources are opposites: an answer arriving and being
 * discarded (NEWS-104, covered deterministically in `refresh-ordering.test.ts`)
 * and an answer never being *asked* for. This file is the second one. It could
 * not be written before because the policy read `document` and called
 * `setInterval` from inside `app.tsx`; a test could only have observed it by
 * waiting four real seconds and hoping, which is precisely the shape of test
 * that has been reporting this class as flake.
 */

/** A fake page whose visibility and clock the test drives. */
function harness(startVisible = true) {
  let visible = startVisible;
  let tick: (() => void) | undefined;
  const listeners: (() => void)[] = [];
  const refreshes: string[] = [];
  const deps = {
    refresh: () => refreshes.push(visible ? 'visible' : 'hidden'),
    isVisible: () => visible,
    onVisibilityChange: (l: () => void) => listeners.push(l),
    setInterval: (fn: () => void, ms: number) => {
      expect(ms).toBe(POLL_INTERVAL_MS);
      tick = fn;
    },
  };
  return {
    deps,
    refreshes,
    tick: () => tick?.(),
    /** Change visibility the way a browser does: flip, *then* notify. */
    setVisible: (next: boolean) => {
      visible = next;
      for (const l of listeners) l();
    },
  };
}

describe('state poll scheduling (NEWS-238)', () => {
  it('polls on every tick while the page is visible', () => {
    const h = harness();
    startPolling(h.deps);
    h.tick();
    h.tick();
    expect(h.refreshes).toEqual(['visible', 'visible']);
  });

  it('asks for nothing while the page is hidden', () => {
    // The reason the skip exists: a backgrounded app requesting every four
    // seconds forever is a real cost, and nobody is reading the answer.
    const h = harness(false);
    startPolling(h.deps);
    h.tick();
    h.tick();
    expect(h.refreshes).toEqual([]);
  });

  it('refreshes immediately on becoming visible again', () => {
    // The behaviour that was missing. Skipping while hidden without this means
    // coming back to the app shows what was true when you left until the next
    // tick — up to a full interval of stale news at the one moment someone has
    // returned to read it.
    const h = harness();
    startPolling(h.deps);
    h.setVisible(false);
    h.tick(); // …several ticks pass unheeded while hidden
    h.tick();
    expect(h.refreshes).toEqual([]);

    h.setVisible(true);
    expect(h.refreshes).toEqual(['visible']); // before any tick fires
  });

  it('does not refresh on the way to hidden', () => {
    // Firing on both edges would make the skip pointless — the transition to
    // hidden is precisely when there is nobody to show an answer to.
    const h = harness();
    startPolling(h.deps);
    h.setVisible(false);
    expect(h.refreshes).toEqual([]);
  });

  it('resumes ticking after a hidden stretch, not only the catch-up', () => {
    // A transition-crossing sequence rather than each operation from a clean
    // start: the failure worth fearing is a poll that catches up once on return
    // and then never ticks again, which every single-step test above passes.
    const h = harness();
    startPolling(h.deps);
    h.tick();
    h.setVisible(false);
    h.tick();
    h.setVisible(true);
    h.tick();
    h.setVisible(false);
    h.setVisible(true);
    h.tick();
    expect(h.refreshes).toEqual([
      'visible', // first tick
      // hidden tick: nothing
      'visible', // catch-up on return
      'visible', // tick after returning
      'visible', // catch-up on the second return
      'visible', // and it is still ticking
    ]);
  });

  it('leaves overlapping answers to the sequence guard rather than debouncing', () => {
    // A catch-up landing next to a tick issues two refreshes, and that is fine:
    // `refreshState` discards the older-issued of two overlapping answers by
    // sequence number (NEWS-104). A debounce here would be a second mechanism
    // guarding something already guarded — and a place for the two to disagree.
    const h = harness();
    startPolling(h.deps);
    h.setVisible(false);
    h.setVisible(true);
    h.tick();
    expect(h.refreshes).toHaveLength(2);
  });
});
