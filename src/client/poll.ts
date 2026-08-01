/**
 * When the client asks the server for fresh state (NEWS-238).
 *
 * This is four lines of policy that used to live inside `app.tsx`, where it
 * could not be tested: it reads `document`, calls `setInterval`, and sits in a
 * 4,000-line module that imports the whole UI. So the *ordering* rules around
 * refreshing — poll on a timer, skip while hidden, catch up on return — were
 * covered only by E2E, and E2E cannot schedule an interleaving.
 *
 * That distinction is the lesson from NEWS-104, which chased an
 * out-of-order-response bug through 288 `repeat-each` executions of the spec
 * that flaked without reproducing it once; a unit test that *chose* the ordering
 * failed deterministically the moment it was written. `refresh-ordering.test.ts`
 * is that test. This module is the same move for the other half of the problem:
 * NEWS-104 pinned down *which answer wins*, and this pins down *when we ask*.
 *
 * Every ambient dependency is injected so a test can drive the clock and the
 * visibility state directly instead of hoping to observe a 4-second timer under
 * load.
 */

/** How often to ask, while the page is being looked at. */
export const POLL_INTERVAL_MS = 4000;

export interface PollDeps {
  /** Ask the server for current state. Errors are the caller's business. */
  refresh: () => void;
  /** Is the page being displayed right now? */
  isVisible: () => boolean;
  /** Subscribe to visibility changes; used for the catch-up refresh. */
  onVisibilityChange: (listener: () => void) => void;
  /** Injected so tests need no real timer. */
  setInterval: (fn: () => void, ms: number) => void;
}

/**
 * Start the state poll.
 *
 * **Skipping while hidden is deliberate** — a backgrounded app making a request
 * every four seconds forever is a real cost on a laptop, and nobody is reading
 * the answer.
 *
 * **The catch-up on becoming visible is the part that was missing.** Skipping
 * alone means returning to the app shows whatever was true when you left it
 * until the next tick fires — up to a full interval of visibly stale news, at
 * exactly the moment someone has come back to look at it. The skip saves the
 * request; it should not also cost the freshness. Refreshing on the transition
 * makes the two independent.
 *
 * A duplicate refresh — the transition landing just before a tick — is harmless
 * and not worth suppressing: `refreshState` already discards the older-issued of
 * two overlapping answers by sequence number (NEWS-104), so the redundant one
 * cannot win a race. Adding a debounce here would be a second mechanism guarding
 * something already guarded, and a place for the two to disagree.
 */
export function startPolling(deps: PollDeps): void {
  deps.setInterval(() => {
    if (deps.isVisible()) deps.refresh();
  }, POLL_INTERVAL_MS);
  deps.onVisibilityChange(() => {
    // Only on the way *back*. A hidden-going transition has nothing to refresh
    // for, and firing there would make the skip pointless.
    if (deps.isVisible()) deps.refresh();
  });
}

/** The dependencies as they are in a browser. */
export function browserPollDeps(refresh: () => void): PollDeps {
  return {
    refresh,
    isVisible: () => document.visibilityState === 'visible',
    onVisibilityChange: (listener) => {
      document.addEventListener('visibilitychange', listener);
    },
    setInterval: (fn, ms) => {
      window.setInterval(fn, ms);
    },
  };
}
