import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateResp } from '../../src/api/schemas.js';
import {
  __resetNotificationsForTests,
  clock,
  ensureNotificationPermission,
  focusProbe,
  noteState,
  sendTestNotification,
} from '../../src/client/notifications.js';
import { appStore } from '../../src/client/stores.js';

const BASE_SETTINGS: StateResp['settings'] = {
  checkIntervalMs: 86_400_000,
  highPriorityIntervalMs: 86_400_000,
  provider: 'auto',
  model: '',
  endpoint: '',
  effort: '',
  backupDir: '',
  backupPromptNever: false,
  backupPromptSnoozedUntil: '',
  notifyOnNewItems: true,
  itemRetentionDays: 365,
  scheduleMode: 'interval',
  dailyTimes: ['08:00'],
  checkConcurrency: 3,
};

function state(itemIds: string[]): StateResp {
  return {
    topics: [],
    // noteState reads latestItemIds (NEWS-75); the feed lives on /api/items now.
    latestItemIds: itemIds,
    flaggedByTopic: {},
    todayByTopic: {},
    newestItemAtByTopic: {},
    settings: BASE_SETTINGS,
    runs: [],
    checking: [],
    appVersion: '0.1.0',
    checksPossibleSince: '1970-01-01T00:00:00.000Z',
  };
}

/** Capture Notification constructions without a real OS notification. */
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(() => Promise.resolve(FakeNotification.permission));
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    FakeNotification.instances.push(this);
  }
  close(): void {
    /* noop */
  }
}

let now = 1_000_000;

beforeEach(() => {
  __resetNotificationsForTests();
  FakeNotification.instances = [];
  FakeNotification.permission = 'granted';
  (globalThis as unknown as { Notification: unknown }).Notification = FakeNotification;
  now = 1_000_000;
  clock.now = () => now;
  // Default: app is NOT focused, which is when notifications may fire.
  focusProbe.isFocused = () => false;
  appStore.actions.update({ settings: { ...BASE_SETTINGS } });
});

afterEach(() => {
  clock.now = () => Date.now();
  focusProbe.isFocused = () => false;
});

describe('noteState', () => {
  it('does not notify for the stories already present on first load', () => {
    // The seed call — otherwise opening the app would fire for everything.
    noteState(state(['a', 'b', 'c']));
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('notifies when a new story arrives after the first load', () => {
    noteState(state(['a']));
    noteState(state(['a', 'b']));
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.title).toBe('New story');
  });

  it('counts multiple new stories', () => {
    noteState(state(['a']));
    noteState(state(['a', 'b', 'c', 'd']));
    expect(FakeNotification.instances[0]?.title).toBe('3 new stories');
  });

  it('does NOT notify while the app is focused', () => {
    // Focused means the feed already updated in front of you.
    focusProbe.isFocused = () => true;
    noteState(state(['a']));
    noteState(state(['a', 'b']));
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('does not notify when the setting is off', () => {
    appStore.actions.update({ settings: { ...BASE_SETTINGS, notifyOnNewItems: false } });
    noteState(state(['a']));
    noteState(state(['a', 'b']));
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('does not notify without permission', () => {
    FakeNotification.permission = 'denied';
    noteState(state(['a']));
    noteState(state(['a', 'b']));
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('throttles to once per five minutes', () => {
    noteState(state(['a']));
    noteState(state(['a', 'b'])); // fires
    expect(FakeNotification.instances).toHaveLength(1);

    now += 60_000; // 1 min later — still inside the window
    noteState(state(['a', 'b', 'c']));
    expect(FakeNotification.instances).toHaveLength(1);

    now += 5 * 60_000; // past the window
    noteState(state(['a', 'b', 'c', 'd']));
    expect(FakeNotification.instances).toHaveLength(2);
  });

  it('records throttled ids so they do not re-fire once the window passes', () => {
    // The story that arrived during the throttle must not itself trigger a
    // notification when the window later opens — only genuinely newer ones do.
    noteState(state(['a']));
    noteState(state(['a', 'b'])); // fires for b
    now += 60_000;
    noteState(state(['a', 'b', 'c'])); // throttled, but c is now "seen"

    now += 5 * 60_000;
    noteState(state(['a', 'b', 'c'])); // nothing new -> must not fire
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it('does nothing when the browser has no Notification API', () => {
    (globalThis as unknown as { Notification: unknown }).Notification = undefined;
    noteState(state(['a']));
    expect(() => {
      noteState(state(['a', 'b']));
    }).not.toThrow();
  });

  it('wires an onclick that focuses the app', () => {
    noteState(state(['a']));
    noteState(state(['a', 'b']));
    expect(typeof FakeNotification.instances[0]?.onclick).toBe('function');
  });
});

/**
 * The desktop path (NEWS-66, rewritten in NEWS-260).
 *
 * **These tests used to manufacture `window.__TAURI__.notification` and assert
 * against it, which is why the bug they were meant to cover survived them.** No
 * build of this app defines that global: the Rust crate injects `init-iife.js`,
 * which replaces `window.Notification` and defines no global, and the npm
 * package is not a dependency. The old suite passed in a world we do not ship,
 * while in the one we do the arm check waited forever on a value nothing set and
 * the desktop could not deliver at all.
 *
 * So the environment modelled here is the real one: `__TAURI__` present with
 * core only, and `window.Notification` replaced by a plugin-backed shim.
 */
describe('the desktop path delivers through the replaced window.Notification', () => {
  /** Stands in for the crate's `init-iife.js`: replaces the constructor. */
  class ShimNotification {
    static permission: NotificationPermission = 'granted';
    static requestPermission = vi.fn(() => Promise.resolve<NotificationPermission>('granted'));
    static delivered: { title: string; body?: string }[] = [];
    /** The real shim exposes nothing useful either; kept so this is a value type. */
    onclick: (() => void) | null = null;
    constructor(title: string, options?: NotificationOptions) {
      ShimNotification.delivered.push({ title, ...(options?.body === undefined ? {} : { body: options.body }) });
    }
  }

  beforeEach(() => {
    ShimNotification.delivered = [];
    ShimNotification.permission = 'granted';
    // `__TAURI__` carries `core` and `window` — and deliberately no
    // `notification`, because the real global does not have one.
    (globalThis as unknown as Record<string, unknown>)['window'] = { __TAURI__: { core: {}, window: {} } };
    vi.stubGlobal('Notification', ShimNotification);
  });
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>)['window'];
    vi.unstubAllGlobals();
  });

  // The regression that matters: with the old `tauriGranted` gate this was 0
  // deliveries no matter what, because nothing ever set it.
  it('fires on the desktop, where no notification global exists', () => {
    noteState(state(['a']));
    noteState(state(['a', 'b']));
    expect(ShimNotification.delivered).toHaveLength(1);
    expect(ShimNotification.delivered[0]?.title).toBe('New story');
  });

  it('reports permission granted without asking, as the plugin does', async () => {
    // The desktop implementation hardcodes `Granted` and never asks macOS, so an
    // already-granted shim must short-circuit rather than prompt.
    expect(await ensureNotificationPermission()).toBe(true);
    expect(ShimNotification.requestPermission).not.toHaveBeenCalled();
  });

  // NEWS-261. The dock bounce is the desktop's attention-getter *because* the
  // notification's own click handler cannot fire there, so the two facts belong
  // in one test: delivery happens, and the bounce happens with it. Neither was
  // asserted at this level before.
  it('bounces the dock alongside the delivery, since the click handler cannot fire', () => {
    const win = { requestUserAttention: vi.fn(() => Promise.resolve()) };
    (globalThis as unknown as Record<string, unknown>)['window'] = {
      __TAURI__: { core: {}, window: { getCurrentWindow: () => win } },
    };
    noteState(state(['a']));
    noteState(state(['a', 'b']));
    expect(ShimNotification.delivered).toHaveLength(1);
    expect(win.requestUserAttention).toHaveBeenCalledTimes(1);
  });

  it('survives a shim whose constructed object has no browser API on it', () => {
    // This is the class of bug NEWS-260 and NEWS-261 both are: the desktop's
    // `Notification` is a plain function that delivers and returns a bare object
    // — no `close`, and nothing ever reads `onclick`. Any future code that
    // *depends* on the returned object (calling `close()`, reading `tag`) would
    // throw into `deliver`'s catch, silently, after the notification had already
    // gone out. Pinned so that lands as a failing test instead.
    class BareShim {
      // The real shim does define `permission` (via defineProperty) — it is the
      // constructed *object* that carries nothing, which is what this pins.
      static permission: NotificationPermission = 'granted';
      static delivered = 0;
      /** The real shim's object carries nothing; one inert field keeps this a value type. */
      readonly bare = true;
      constructor() {
        BareShim.delivered += 1;
      }
    }
    vi.stubGlobal('Notification', BareShim);
    expect(() => {
      noteState(state(['a']));
      noteState(state(['a', 'b']));
    }).not.toThrow();
    expect(BareShim.delivered).toBe(1);
  });

  it('still respects the toggle being off', () => {
    appStore.actions.setState({ ...state([]), settings: { ...BASE_SETTINGS, notifyOnNewItems: false } });
    noteState(state(['a']));
    noteState(state(['a', 'b']));
    expect(ShimNotification.delivered).toHaveLength(0);
  });
});

describe('the test notification (NEWS-260)', () => {
  it('delivers immediately, ignoring focus and the throttle', async () => {
    // Both suppressions are deliberate: the user is watching Settings, and a
    // real notification minutes earlier must not make the button appear broken.
    focusProbe.isFocused = (): boolean => true;
    noteState(state(['a']));
    noteState(state(['a', 'b'])); // focused, so nothing fires
    expect(FakeNotification.instances).toHaveLength(0);

    expect(await sendTestNotification()).toBe(true);
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.title).toBe('Newsmonger test');
  });

  it('does not consume the throttle window a real notification uses', async () => {
    // Sending a test must not suppress the next genuine one.
    focusProbe.isFocused = (): boolean => false;
    expect(await sendTestNotification()).toBe(true);
    noteState(state(['a']));
    noteState(state(['a', 'b']));
    expect(FakeNotification.instances.map((n) => n.title)).toEqual(['Newsmonger test', 'New story']);
  });

  it('reports failure rather than throwing when permission is refused', async () => {
    FakeNotification.permission = 'denied';
    expect(await sendTestNotification()).toBe(false);
    expect(FakeNotification.instances).toHaveLength(0);
  });
});
