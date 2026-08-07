import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { Attendance,ATTENDANCE_WINDOW_MS } from '../../src/attendance.js';
import { CheckRunner } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { createApp } from '../../src/server.js';
import { afterGrace } from '../helpers/grace.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

const T0 = Date.parse('2026-07-24T12:00:00.000Z');

describe('Attendance', () => {
  it('is not attended before any signal', () => {
    // The fail-closed default: an unwired gate must not permit checks.
    expect(new Attendance().isAttended(T0)).toBe(false);
    expect(new Attendance().lastSeenAt()).toBeNull();
  });

  it('is attended right after a signal', () => {
    const a = new Attendance();
    a.record(T0);
    expect(a.isAttended(T0)).toBe(true);
    expect(a.lastSeenAt()).toBe(T0);
  });

  it('stays attended for the whole window', () => {
    const a = new Attendance();
    a.record(T0);
    expect(a.isAttended(T0 + ATTENDANCE_WINDOW_MS - 1)).toBe(true);
  });

  it('lapses exactly at the window boundary', () => {
    const a = new Attendance();
    a.record(T0);
    expect(a.isAttended(T0 + ATTENDANCE_WINDOW_MS)).toBe(false);
    expect(a.isAttended(T0 + ATTENDANCE_WINDOW_MS + 60_000)).toBe(false);
  });

  it('a later signal re-opens the window', () => {
    // Away long enough to lapse, then back — the sequence a single-shot test
    // would miss.
    const a = new Attendance();
    a.record(T0);
    expect(a.isAttended(T0 + ATTENDANCE_WINDOW_MS)).toBe(false);
    a.record(T0 + ATTENDANCE_WINDOW_MS);
    expect(a.isAttended(T0 + ATTENDANCE_WINDOW_MS + 1000)).toBe(true);
  });
});

/** A runner whose provider is subscription-backed, so the gate applies. */
function attendedSetup() {
  const store = new Store(tmpDataDir());
  const attendance = new Attendance();
  const provider = createMockProvider({ attended: true });
  const runner = new CheckRunner(store, asResolver(provider), attendance);
  return { store, attendance, provider, runner };
}

describe('scheduled checks with an attended provider', () => {
  it('are skipped when nobody is watching', async () => {
    const { store, runner, provider } = attendedSetup();
    store.addTopic('fusion energy');

    await runner.checkDue(new Date(T0));

    expect(provider.calls).toHaveLength(0);
    expect(store.listItems()).toEqual([]);
  });

  it('leave the topic due, so nothing is silently lost', async () => {
    // The deferral must not advance lastCheckedAt — otherwise a skipped check
    // would push the topic a full interval into the future.
    const { store, runner } = attendedSetup();
    const topic = store.addTopic('fusion energy');

    await runner.checkDue(new Date(T0));

    expect(store.getTopic(topic.id)?.lastCheckedAt).toBeNull();
    expect(store.listRuns(10)).toEqual([]); // not a failure — no run recorded
  });

  it('run when the app is foregrounded', async () => {
    const { store, runner, attendance, provider } = attendedSetup();
    store.addTopic('fusion energy');
    attendance.record(T0);

    await runner.checkDue(new Date(T0));

    expect(provider.calls).toHaveLength(1);
    expect(store.listItems()).toHaveLength(2);
  });

  it('run on a stale-but-within-window signal', async () => {
    const { store, runner, attendance, provider } = attendedSetup();
    store.addTopic('fusion energy');
    attendance.record(T0);

    await runner.checkDue(new Date(T0 + ATTENDANCE_WINDOW_MS - 1000));

    expect(provider.calls).toHaveLength(1);
  });

  it('catch up as soon as the user comes back', async () => {
    // The full journey: away → deferred → returns → the deferred check runs.
    const { store, runner, attendance, provider } = attendedSetup();
    store.addTopic('fusion energy');

    await runner.checkDue(new Date(T0));
    expect(provider.calls).toHaveLength(0);

    attendance.record(T0 + 60_000);
    await runner.checkDue(new Date(T0 + 60_000));

    expect(provider.calls).toHaveLength(1);
    expect(store.listItems()).toHaveLength(2);
  });

  it('stop again once attendance lapses', async () => {
    // Present → checks; away past the window → stops. Guards against the gate
    // latching open after the first successful sweep.
    const { store, runner, attendance, provider } = attendedSetup();
    const topic = store.addTopic('fusion energy');

    attendance.record(T0);
    await runner.checkDue(new Date(T0));
    expect(provider.calls).toHaveLength(1);

    // Make it due again, then let attendance lapse.
    store.markTopicChecked(topic.id, new Date(T0 - 48 * 60 * 60 * 1000));
    await runner.checkDue(new Date(T0 + ATTENDANCE_WINDOW_MS + 1));

    expect(provider.calls).toHaveLength(1);
  });
});

describe('manual checks are never gated', () => {
  it('checkTopic runs with nobody watching', async () => {
    // Clicking the button is itself proof someone is there.
    const { store, runner, provider } = attendedSetup();
    const topic = store.addTopic('fusion energy');

    const added = await runner.checkTopic(topic.id);

    expect(added).toBe(2);
    expect(provider.calls).toHaveLength(1);
  });

  it('checkAll runs with nobody watching', async () => {
    const { store, runner, provider } = attendedSetup();
    store.addTopic('fusion energy');
    store.addTopic('quantum computing');

    await runner.checkAll();

    expect(provider.calls).toHaveLength(2);
  });
});

describe('manual checks record attendance (NEWS-44)', () => {
  it('a manual check-all keeps the scheduler ungated for the rest of a long sweep', async () => {
    // The reported bug: click Check all now on a subscription provider, then
    // background the app; topics late in the slow sequential sweep were then
    // gated out of the scheduler and had to wait. A manual check now counts as
    // activity, so a scheduler tick during the sweep isn't gated.
    const { store, runner, attendance, provider } = attendedSetup();
    store.addTopic('fusion energy');
    store.addTopic('quantum computing');
    expect(attendance.isAttended(Date.now())).toBe(false); // backgrounded

    await runner.checkAll();

    // checkAll ran every topic (it's ungated)...
    expect(provider.calls.length).toBe(2);
    // ...and recorded attendance, so a scheduled sweep right after is NOT gated.
    expect(attendance.isAttended(Date.now())).toBe(true);
  });

  it('a manual single-topic check records attendance', async () => {
    const { store, runner, attendance } = attendedSetup();
    const topic = store.addTopic('fusion energy');
    expect(attendance.isAttended(Date.now())).toBe(false);

    await runner.checkTopic(topic.id, { manual: true });

    expect(attendance.isAttended(Date.now())).toBe(true);
  });

  it('a SCHEDULED check does not record attendance', async () => {
    // checkTopic without the manual flag (the scheduler's path) must not stamp
    // attendance — otherwise one scheduled check would prop the gate open.
    const { store, runner, attendance } = attendedSetup();
    const topic = store.addTopic('fusion energy');

    await runner.checkTopic(topic.id); // no manual flag

    expect(attendance.isAttended(Date.now())).toBe(false);
  });

  it('after a manual sweep, a backgrounded scheduled check runs within the window', async () => {
    // End to end: manual sweep -> attendance fresh -> the very next scheduled
    // sweep (still backgrounded) checks a now-due topic instead of deferring it.
    const { store, runner, provider } = attendedSetup();
    const topic = store.addTopic('fusion energy');

    await runner.checkAll(); // records attendance
    provider.calls.length = 0;

    // Make it due again, then run the scheduler while still backgrounded.
    store.markTopicChecked(topic.id, new Date(Date.now() - 48 * 60 * 60 * 1000));
    await runner.checkDue(new Date());

    expect(provider.calls.length).toBe(1); // ran, not deferred
  });
});

describe('unattended (API-key) providers are unaffected', () => {
  it('scheduled checks run with no foreground signal at all', async () => {
    const store = new Store(tmpDataDir());
    const provider = createMockProvider(); // attended: false, like anthropic/openai
    const runner = new CheckRunner(store, asResolver(provider), new Attendance());
    store.addTopic('fusion energy');

    await runner.checkDue(new Date(T0));

    expect(provider.calls).toHaveLength(1);
    expect(store.listItems()).toHaveLength(2);
  });

  it('a paused topic is still skipped regardless of attendance', async () => {
    const { store, runner, attendance, provider } = attendedSetup();
    const topic = store.addTopic('fusion energy');
    store.setTopicPaused(topic.id, true);
    attendance.record(T0);

    await runner.checkDue(new Date(T0));

    expect(provider.calls).toHaveLength(0);
  });
});

describe('the manual check routes record attendance (NEWS-44)', () => {
  it('POST /api/check (all) records attendance', async () => {
    const store = new Store(tmpDataDir());
    const attendance = new Attendance();
    const runner = new CheckRunner(store, asResolver(createMockProvider({ attended: true })), attendance);
    const app = createApp({ store, runner, attendance });
    store.addTopic('fusion energy');
    expect(attendance.isAttended(Date.now())).toBe(false);

    await app.request('/api/check', { method: 'POST', body: JSON.stringify({}) });
    expect(attendance.isAttended(Date.now())).toBe(true);
  });

  it('POST /api/check {topicId} records attendance', async () => {
    const store = new Store(tmpDataDir());
    const attendance = new Attendance();
    const runner = new CheckRunner(store, asResolver(createMockProvider({ attended: true })), attendance);
    const app = createApp({ store, runner, attendance });
    const topic = store.addTopic('fusion energy');
    expect(attendance.isAttended(Date.now())).toBe(false);

    await app.request('/api/check', { method: 'POST', body: JSON.stringify({ topicId: topic.id }) });
    expect(attendance.isAttended(Date.now())).toBe(true);
  });
});

describe('the /api/foreground route drives the gate', () => {
  it('a heartbeat unblocks a scheduled check', async () => {
    // Wiring test: the route and the runner must share one Attendance, or the
    // client could report foreground all day and nothing would ever run.
    const store = new Store(tmpDataDir());
    const attendance = new Attendance();
    const provider = createMockProvider({ attended: true });
    const runner = new CheckRunner(store, asResolver(provider), attendance);
    const app = createApp({ store, runner, attendance });
    store.addTopic('fusion energy');

    // Past the new-topic grace (NEWS-366) so the gate under test is attendance
    // and nothing else. Still well inside the attendance window, which is five
    // minutes.
    await runner.checkDue(afterGrace());
    expect(provider.calls).toHaveLength(0);

    const res = await app.request('/api/foreground', { method: 'POST' });
    expect(res.status).toBe(200);

    await runner.checkDue(afterGrace());
    expect(provider.calls).toHaveLength(1);
  });

  it('records the moment it was called', async () => {
    const store = new Store(tmpDataDir());
    const attendance = new Attendance();
    const runner = new CheckRunner(store, asResolver(createMockProvider()), attendance);
    const app = createApp({ store, runner, attendance });

    expect(attendance.lastSeenAt()).toBeNull();
    await app.request('/api/foreground', { method: 'POST' });
    expect(attendance.lastSeenAt()).not.toBeNull();
  });
});

describe('gate does not swallow provider-resolution failures', () => {
  it('still records a failed run when no provider is available', async () => {
    // The gate resolves the provider to read `attended`. A resolution failure
    // must fall through to the normal per-topic error recording, not be
    // mistaken for "defer quietly".
    const store = new Store(tmpDataDir());
    const runner = new CheckRunner(
      store,
      () => Promise.reject(new Error('No AI provider has an API key')),
      new Attendance(),
    );
    store.addTopic('fusion energy');

    await runner.checkDue(new Date(T0));

    const runs = store.listRuns(10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error).toMatch(/no ai provider/i);
  });
});

describe('a deferred sweep is recorded, so the banner can tell why (NEWS-247)', () => {
  /**
   * The "falling behind" banner reads lateness off `lastCheckedAt`, and the
   * wall clock cannot tell *we cannot keep up* from *we were not permitted to
   * try*. Leaving the app in the background with a subscription provider was
   * enough to make every topic look badly overdue — and the banner then advised
   * fewer topics, a longer interval, or a faster provider, none of which was
   * the problem.
   *
   * The gate that turns a sweep away is the one place that knows, so it says so.
   */
  it('moves the watermark when work was waiting and was not allowed to run', async () => {
    const { store, runner } = attendedSetup();
    store.addTopic('fusion energy');
    // `afterGrace()`, not `checksPossibleSince() + 60_000` (NEWS-411). The
    // watermark starts at the runner's construction, and `addTopic` stamps
    // `createdAt` from the real clock *afterwards* — so a sweep an even minute
    // past the watermark can still land inside the topic's own settling grace if
    // the insert took a millisecond. Then no work is waiting, nothing is
    // deferred, and the watermark does not move: a ~25% flake whose message
    // blames the assertion rather than the clock.
    const now = afterGrace().getTime();

    await runner.checkDue(new Date(now));

    expect(runner.checksPossibleSince()).toBe(now);
  });

  it('never reports a moment before the process was running', async () => {
    // The watermark is the later of process start and the last deferral, so a
    // deferral timestamped in the past cannot drag it backwards. It answers
    // "since when could we have checked", and before startup the answer is
    // never — this is what keeps a reopened app from being judged on the days
    // it spent closed.
    const { store, runner } = attendedSetup();
    store.addTopic('fusion energy');
    const start = runner.checksPossibleSince();

    await runner.checkDue(new Date(T0)); // T0 is long before this process began

    expect(runner.checksPossibleSince()).toBe(start);
  });

  it('leaves it alone when there was simply nothing due', async () => {
    // An idle sweep is not a deferral. Counting one would push the watermark
    // forward every single minute and silence the banner permanently — the
    // failure mode that turns a fix into a mute button.
    const { runner } = attendedSetup();
    const before = runner.checksPossibleSince();

    await runner.checkDue(new Date(T0));

    expect(runner.checksPossibleSince()).toBe(before);
  });

  it('leaves it alone when the sweep actually ran', async () => {
    const { store, runner, attendance } = attendedSetup();
    store.addTopic('fusion energy');
    attendance.record(T0);
    const before = runner.checksPossibleSince();

    await runner.checkDue(new Date(T0));

    expect(runner.checksPossibleSince()).toBe(before);
  });

  it('tracks the most recent deferral, not the first', async () => {
    // The watermark answers "since when has checking been possible", so a later
    // deferral has to move it forward. Keeping the first would let a single
    // early background stretch excuse every lateness thereafter.
    const { store, runner } = attendedSetup();
    store.addTopic('fusion energy');
    const base = runner.checksPossibleSince();

    await runner.checkDue(new Date(base + 60_000));
    await runner.checkDue(new Date(base + 120_000));

    expect(runner.checksPossibleSince()).toBe(base + 120_000);
  });
});
