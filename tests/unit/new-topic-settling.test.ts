import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner, inNewTopicGrace, isDueUnderSchedule, NEW_TOPIC_GRACE_MS } from '../../src/checks.js';
import type { Settings } from '../../src/db/schemas.js';
import type { Store } from '../../src/db/store.js';
import { createApp } from '../../src/server.js';
import { TOPIC_HOLD_WINDOW_MS, TopicHolds } from '../../src/topic-holds.js';
import { asResolver } from '../helpers/provider.js';
import { tmpStore } from '../helpers/tmp.js';

/**
 * The new-topic settling rules (NEWS-366).
 *
 * Two mechanisms answering two different questions — "has this topic had a
 * chance to be configured yet" (a fact about the topic) and "is someone editing
 * it right now" (a fact about the session) — so they are tested apart and then
 * together, since the whole point is that they cover each other's gap.
 */

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-08-07T12:00:00.000Z');
const at = (ms: number): Date => new Date(T0 + ms);

const SETTINGS = {
  checkIntervalMs: HOUR,
  highPriorityIntervalMs: HOUR,
  scheduleMode: 'interval',
  dailyTimes: [],
} as unknown as Settings;

const newTopic = (over: Record<string, unknown> = {}): Parameters<typeof isDueUnderSchedule>[0] => ({
  paused: false,
  highPriority: false,
  lastCheckedAt: null,
  createdAt: new Date(T0).toISOString(),
  ...over,
});

describe('the new-topic grace (FR-34.1 – FR-34.3)', () => {
  it('holds a brand-new topic back for a minute, then lets it run', () => {
    const topic = newTopic();
    expect(inNewTopicGrace(topic, at(0))).toBe(true);
    expect(inNewTopicGrace(topic, at(NEW_TOPIC_GRACE_MS - 1))).toBe(true);
    // Exactly the grace is up: `<` not `<=`, so the boundary runs.
    expect(inNewTopicGrace(topic, at(NEW_TOPIC_GRACE_MS))).toBe(false);
    expect(inNewTopicGrace(topic, at(NEW_TOPIC_GRACE_MS * 10))).toBe(false);
    // And it is *due* throughout — being new is not a reason it is not owed a
    // check, only a reason not to run one this instant (FR-34.7).
    expect(isDueUnderSchedule(topic, SETTINGS, at(0))).toBe(true);
  });

  it('fails open when the clock has gone backwards (FR-34.3)', () => {
    // `now - created < GRACE` is also true when `now` precedes `created`, which
    // would hold the topic until the clock caught up — days, after a big
    // correction. How long it has existed is unknowable, so it runs.
    expect(inNewTopicGrace(newTopic(), at(-5 * 60_000))).toBe(false);
  });

  it('is waivable, which is how tests of other gates stay honest', () => {
    // `newTopicGraceMs: 0` on the runner; the predicate is what reads it.
    expect(inNewTopicGrace(newTopic(), at(0), 0)).toBe(false);
    expect(inNewTopicGrace(newTopic(), at(0), NEW_TOPIC_GRACE_MS)).toBe(true);
  });

  it('does not apply once the topic has been checked', () => {
    // The window is a property of a topic that has never run, not a rolling
    // delay: a topic checked an hour ago is due, however recently it was made.
    const checked = newTopic({ lastCheckedAt: new Date(T0 - HOUR).toISOString() });
    expect(isDueUnderSchedule(checked, SETTINGS, at(0))).toBe(true);
    expect(inNewTopicGrace(checked, at(0))).toBe(false);
  });

  it('does not apply to a cleared topic (FR-34.2)', () => {
    // Cleared reads as never-checked for display (NEWS-273) but keeps its
    // scheduling baseline (NEWS-291), so it waits an interval — not a minute,
    // and not both.
    const cleared = newTopic({ lastCheckedAt: null, clearedAt: new Date(T0).toISOString() });
    expect(inNewTopicGrace(cleared, at(0))).toBe(false);
    expect(isDueUnderSchedule(cleared, SETTINGS, at(NEW_TOPIC_GRACE_MS))).toBe(false);
    expect(isDueUnderSchedule(cleared, SETTINGS, at(HOUR))).toBe(true);
  });

  it('grants no grace when createdAt is absent or unparseable (FR-34.3)', () => {
    // Degrades to the pre-NEWS-366 behaviour rather than inventing a delay.
    expect(inNewTopicGrace({ lastCheckedAt: null }, at(0))).toBe(false);
    expect(inNewTopicGrace({ lastCheckedAt: null, createdAt: 'not a date' }, at(0))).toBe(false);
    expect(isDueUnderSchedule({ paused: false, highPriority: false, lastCheckedAt: null }, SETTINGS, at(0))).toBe(true);
  });

  it('does not let a topic through that another gate was refusing', () => {
    // The grace expiring must not read as permission: pause and the cooldown
    // still decide, and they are checked independently.
    expect(isDueUnderSchedule(newTopic({ paused: true }), SETTINGS, at(NEW_TOPIC_GRACE_MS))).toBe(false);
    const cooling = newTopic({ retryAfter: new Date(T0 + 5 * NEW_TOPIC_GRACE_MS).toISOString() });
    expect(isDueUnderSchedule(cooling, SETTINGS, at(NEW_TOPIC_GRACE_MS))).toBe(false);
  });

  it('is independent of the schedule mode', () => {
    // The grace is a property of the topic, not of the schedule, so it cannot
    // be escaped by the branch a topic happens to take.
    const daily = { ...SETTINGS, scheduleMode: 'daily', dailyTimes: ['00:00'] } as unknown as Settings;
    expect(isDueUnderSchedule(newTopic(), daily, at(0))).toBe(true);
    expect(inNewTopicGrace(newTopic(), at(0))).toBe(true);
    expect(inNewTopicGrace(newTopic(), at(NEW_TOPIC_GRACE_MS))).toBe(false);
  });
});

describe('TopicHolds (FR-34.4, FR-34.5)', () => {
  it('holds nothing when fresh, so the gate fails open (FR-34.9)', () => {
    expect(new TopicHolds().isHeld('t1', T0)).toBe(false);
  });

  it('holds a topic for the window, then lapses without a release', () => {
    const holds = new TopicHolds();
    holds.hold('t1', T0);
    expect(holds.isHeld('t1', T0)).toBe(true);
    expect(holds.isHeld('t1', T0 + TOPIC_HOLD_WINDOW_MS - 1)).toBe(true);
    expect(holds.isHeld('t1', T0 + TOPIC_HOLD_WINDOW_MS)).toBe(false);
  });

  it('keeps a hold alive across re-assertions, which is what the 4 s poll does', () => {
    const holds = new TopicHolds();
    let now = T0;
    holds.hold('t1', now);
    // Twenty polls at four seconds — far past the window, never lapsing.
    for (let i = 0; i < 20; i++) {
      now += 4_000;
      expect(holds.isHeld('t1', now)).toBe(true);
      holds.hold('t1', now);
    }
    // And then the client stops: one window later it is gone.
    expect(holds.isHeld('t1', now + TOPIC_HOLD_WINDOW_MS)).toBe(false);
  });

  it('holds each topic independently', () => {
    const holds = new TopicHolds();
    holds.hold('t1', T0);
    holds.hold('t2', T0 + TOPIC_HOLD_WINDOW_MS - 1);
    const later = T0 + TOPIC_HOLD_WINDOW_MS;
    expect(holds.isHeld('t1', later)).toBe(false);
    expect(holds.isHeld('t2', later)).toBe(true);
    expect(holds.held(later)).toEqual(['t2']);
  });

  it('re-holds a topic whose hold had already lapsed', () => {
    // Open, close, reopen — the map entry was dropped on the lapsed read, so
    // this is the path where a naive implementation would fail to re-register.
    const holds = new TopicHolds();
    holds.hold('t1', T0);
    expect(holds.isHeld('t1', T0 + TOPIC_HOLD_WINDOW_MS)).toBe(false);
    holds.hold('t1', T0 + TOPIC_HOLD_WINDOW_MS);
    expect(holds.isHeld('t1', T0 + TOPIC_HOLD_WINDOW_MS)).toBe(true);
  });
});

describe('a sweep skips held topics (FR-34.4, FR-34.7, FR-34.8)', () => {
  /**
   * A store and runner whose provider is the plain mock — `attended: false`,
   * like anthropic/openai — so scheduled checks need no foreground signal and
   * the holds are the only thing gating this sweep.
   */
  const setup = (holds: TopicHolds) => {
    const store = tmpStore();
    const provider = createMockProvider();
    const runner = new CheckRunner(store, asResolver(provider), undefined, null, null, { holds });
    return { store, provider, runner };
  };

  /**
   * Long overdue, and past the new-topic grace.
   *
   * Two days, not two hours: these go through the *store's* settings, whose
   * default interval is a day — so an hours-ago check is not overdue at all and
   * the sweep would find nothing for reasons having nothing to do with holds.
   */
  const CHECKED_AT = new Date(T0 - 48 * HOUR);
  const overdue = (store: Store, name: string): string => {
    const topic = store.addTopic(name);
    store.markTopicChecked(topic.id, CHECKED_AT);
    return topic.id;
  };

  it('leaves a held topic untouched and checks the others', async () => {
    const holds = new TopicHolds();
    const { store, provider, runner } = setup(holds);
    const held = overdue(store, 'held');
    overdue(store, 'free');
    holds.hold(held, T0);

    await runner.checkDue(at(0));

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.topicName).toBe('free');
    expect(store.getTopic(held)?.lastCheckedAt).toBe(CHECKED_AT.toISOString());
  });

  it('checks the topic on the next sweep once the hold lapses', async () => {
    // The transition that matters: held, swept (nothing), released, swept
    // (runs). A gate that marked the topic rather than filtering it fails here.
    const holds = new TopicHolds();
    const { store, provider, runner } = setup(holds);
    const id = overdue(store, 'held then freed');
    holds.hold(id, T0);

    await runner.checkDue(at(0));
    expect(provider.calls).toHaveLength(0);

    await runner.checkDue(at(TOPIC_HOLD_WINDOW_MS));
    expect(provider.calls).toHaveLength(1);
  });

  it('re-holding before the window is up keeps it skipped', async () => {
    // What an open dialog actually looks like: poll, poll, poll. Each sweep in
    // between must find it held.
    const holds = new TopicHolds();
    const { store, provider, runner } = setup(holds);
    const id = overdue(store, 'still typing');

    for (let t = 0; t < 3 * TOPIC_HOLD_WINDOW_MS; t += 4_000) {
      holds.hold(id, T0 + t);
      await runner.checkDue(at(t));
    }
    expect(provider.calls).toHaveLength(0);
  });

  it('does not stop a manual check of a held topic (FR-34.8)', async () => {
    // Holding back a sweep is a courtesy; refusing an explicit request is a bug.
    const holds = new TopicHolds();
    const { store, provider, runner } = setup(holds);
    const id = overdue(store, 'held');
    holds.hold(id, Date.now());

    await runner.checkAll();
    expect(provider.calls).toHaveLength(1);
  });
});

describe('the two rules cover each other (FR-34.1 + FR-34.4)', () => {
  it('a topic created and then edited is never swept in between', () => {
    // The composed timeline, which is the actual feature: created at T0, the
    // dialog opens 30 s later, the user types for three minutes. No instant in
    // that run should be checkable.
    const topic = newTopic();
    const holds = new TopicHolds();
    const id = 'the-topic';

    // 0–30 s: the grace alone is holding it.
    expect(inNewTopicGrace(topic, at(0))).toBe(true);
    expect(inNewTopicGrace(topic, at(30_000))).toBe(true);

    // From 30 s the dialog is open and the poll asserts every 4 s.
    let now = 30_000;
    let sweptWhileEditing = false;
    while (now < 30_000 + 3 * 60_000) {
      holds.hold(id, T0 + now);
      now += 4_000;
      const runnable =
        isDueUnderSchedule(topic, SETTINGS, at(now)) && !inNewTopicGrace(topic, at(now)) && !holds.isHeld(id, T0 + now);
      if (runnable) sweptWhileEditing = true;
    }
    expect(sweptWhileEditing).toBe(false);

    // The dialog closes; the hold lapses, the grace is long gone, and it runs.
    const after = at(now + TOPIC_HOLD_WINDOW_MS);
    expect(isDueUnderSchedule(topic, SETTINGS, after)).toBe(true);
    expect(inNewTopicGrace(topic, after)).toBe(false);
    expect(holds.isHeld(id, T0 + now + TOPIC_HOLD_WINDOW_MS)).toBe(false);
  });
});

describe('the /api/state hold parameter (FR-34.5, FR-34.6)', () => {
  const appWith = (holds: TopicHolds) => {
    const store = tmpStore();
    const runner = new CheckRunner(store, asResolver(createMockProvider()), undefined, null, null, { holds });
    return { store, app: createApp({ store, runner, holds }) };
  };

  it('records a hold named on the poll', async () => {
    const holds = new TopicHolds();
    const { store, app } = appWith(holds);
    const id = store.addTopic('being edited').id;

    const res = await app.request(`/api/state?holding=${id}`);
    expect(res.status).toBe(200);
    expect(holds.isHeld(id)).toBe(true);
  });

  it('holds nothing when the parameter is absent or empty', async () => {
    // The ordinary poll, which is almost all of them.
    const holds = new TopicHolds();
    const { app } = appWith(holds);

    await app.request('/api/state');
    await app.request('/api/state?holding=');
    expect(holds.held()).toEqual([]);
  });

  it('lets the hold lapse when the client stops naming the topic', async () => {
    // Dialog open, then closed: the polls keep coming, they just stop carrying
    // the id. Nothing sends a release, and none is needed (FR-34.5).
    const holds = new TopicHolds();
    const { store, app } = appWith(holds);
    const id = store.addTopic('being edited').id;

    await app.request(`/api/state?holding=${id}`);
    expect(holds.isHeld(id)).toBe(true);
    await app.request('/api/state');
    // Still held right now — the hold expires on time, not on the next poll.
    expect(holds.isHeld(id)).toBe(true);
    expect(holds.isHeld(id, Date.now() + TOPIC_HOLD_WINDOW_MS)).toBe(false);
  });

  it('does not fall over on an id that is not a topic', async () => {
    // Nothing validates this against the store, and nothing needs to: a hold on
    // an id no topic has simply never matches anything in the sweep.
    const holds = new TopicHolds();
    const { app } = appWith(holds);
    const res = await app.request('/api/state?holding=not-a-real-topic');
    expect(res.status).toBe(200);
    expect(holds.isHeld('not-a-real-topic')).toBe(true);
  });
});
