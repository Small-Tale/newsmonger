import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateResp } from '../../src/api/schemas.js';
import {
  __resetNotificationsForTests,
  clock,
  focusProbe,
  noteState,
} from '../../src/client/notifications.js';
import { appStore } from '../../src/client/stores.js';

const BASE_SETTINGS: StateResp['settings'] = {
  checkIntervalMs: 86_400_000,
  highPriorityIntervalMs: 86_400_000,
  provider: 'auto',
  model: '',
  endpoint: '',
  notifyOnNewItems: true,
};

function state(itemIds: string[]): StateResp {
  return {
    topics: [],
    items: itemIds.map((id) => ({
      id,
      topicId: 't1',
      title: 'x',
      summary: 'y',
      sources: [],
      image: null,
      saved: false,
      offTopic: false,
      dedupeKey: id,
      foundAt: '2026-07-24T00:00:00.000Z',
    })),
    settings: BASE_SETTINGS,
    runs: [],
    checking: [],
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
