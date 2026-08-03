import { afterEach, describe, expect, it } from 'vitest';

import { bounceDockIcon, focusAppWindow, getTauriInvoke, isTauri } from '../../src/client/tauri.js';

/**
 * The desktop window bridge (NEWS-261).
 *
 * **Why this file exists.** `bounceDockIcon` is the desktop's *only working*
 * attention mechanism — FR-10.6, and more so since NEWS-260 established that the
 * notification's own click handler cannot fire there — and it had **no test at
 * all**. Nothing would have failed if a refactor dropped the call, renamed the
 * global path it reaches through, or passed the wrong attention constant.
 *
 * That is the same shape as the bug this ticket came from: a desktop-only path,
 * unreachable from the unit environment unless the global is faked, quietly doing
 * nothing for months while the browser path kept the feature looking fine. The
 * lesson taken from NEWS-260 is *not* "fake the global" — its tests faked one
 * that does not exist — it is that the fake has to match the shape the real
 * shell provides. `__TAURI__.window.getCurrentWindow()` is real: it is what
 * `withGlobalTauri` exposes, unlike the `__TAURI__.notification` that never was.
 */

interface FakeWindow {
  requestUserAttention?: (type: number | null) => unknown;
  setFocus?: () => unknown;
}

/** Install a `__TAURI__` global shaped like the one `withGlobalTauri` exposes. */
function installTauri(win: FakeWindow | undefined, core?: Record<string, unknown>): void {
  (globalThis as unknown as Record<string, unknown>)['window'] = {
    __TAURI__: {
      ...(core === undefined ? {} : { core }),
      window: { getCurrentWindow: () => win },
    },
  };
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>)['window'];
});

describe('bounceDockIcon (FR-10.6)', () => {
  it('asks for critical attention, which is what bounces rather than blinks once', () => {
    // The constant matters: `1` is Critical (bounce until attended), `2` is
    // Informational (a single bounce). A notification the user was not looking at
    // wants the former, and a swapped constant is invisible in review.
    const asked: (number | null)[] = [];
    installTauri({
      requestUserAttention: (type) => {
        asked.push(type);
        return Promise.resolve();
      },
    });
    bounceDockIcon();
    expect(asked).toEqual([1]);
  });

  it('does nothing outside the desktop shell', () => {
    // The same bundle is served to a browser on localhost, where there is no
    // global at all — this must be a silent no-op, not a crash on every
    // notification.
    expect(isTauri()).toBe(false);
    expect(() => {
      bounceDockIcon();
    }).not.toThrow();
  });

  it('does nothing when the shell exposes no window API', () => {
    installTauri(undefined);
    expect(() => {
      bounceDockIcon();
    }).not.toThrow();
  });

  it('does nothing when the window API lacks the method', () => {
    // A future Tauri could move or rename it. Silence beats a thrown error inside
    // the notification path, which would take the notification down with it.
    installTauri({});
    expect(() => {
      bounceDockIcon();
    }).not.toThrow();
  });

  it('swallows a rejection, and a runtime that returns no promise at all', async () => {
    installTauri({
      requestUserAttention: () => Promise.reject(new Error('no window server')),
    });
    expect(() => {
      bounceDockIcon();
    }).not.toThrow();
    // An unhandled rejection would fail the suite on the next tick, so give it one.
    await Promise.resolve();

    installTauri({ requestUserAttention: () => undefined });
    expect(() => {
      bounceDockIcon();
    }).not.toThrow();
  });
});

describe('focusAppWindow', () => {
  it('calls setFocus when the shell offers it', () => {
    let focused = 0;
    installTauri({
      setFocus: () => {
        focused += 1;
        return Promise.resolve();
      },
    });
    focusAppWindow();
    expect(focused).toBe(1);
  });

  it('falls back to the DOM focus when the shell offers no setFocus', () => {
    // Not merely a no-op: in a browser the whole point is `window.focus()`, and
    // the fallback is also what runs if a future Tauri drops the method.
    let domFocused = 0;
    installTauri({});
    const w = (globalThis as unknown as Record<string, { focus?: () => void }>)['window'];
    w.focus = (): void => {
      domFocused += 1;
    };
    focusAppWindow();
    expect(domFocused).toBe(1);
  });

  it('swallows a rejected setFocus and never reaches the DOM fallback', async () => {
    // The Tauri path was taken, so falling through to `window.focus()` as well
    // would be two attempts at one intent.
    let domFocused = 0;
    installTauri({ setFocus: () => Promise.reject(new Error('nope')) });
    const w = (globalThis as unknown as Record<string, { focus?: () => void }>)['window'];
    w.focus = (): void => {
      domFocused += 1;
    };
    expect(() => {
      focusAppWindow();
    }).not.toThrow();
    await Promise.resolve();
    expect(domFocused).toBe(0);
  });

  it('does nothing at all when there is no window object', () => {
    delete (globalThis as unknown as Record<string, unknown>)['window'];
    expect(() => {
      focusAppWindow();
    }).not.toThrow();
  });
});

describe('getTauriInvoke', () => {
  it('finds the core bridge, and reports its absence rather than inventing one', () => {
    const invoke = (): Promise<unknown> => Promise.resolve('ok');
    installTauri({}, { invoke });
    expect(getTauriInvoke()).toBe(invoke);

    // Present shell, no core — every caller must handle undefined.
    installTauri({});
    expect(getTauriInvoke()).toBeUndefined();
    delete (globalThis as unknown as Record<string, unknown>)['window'];
    expect(getTauriInvoke()).toBeUndefined();
  });
});
