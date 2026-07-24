import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { Attendance,ATTENDANCE_WINDOW_MS } from '../../src/attendance.js';
import { CheckRunner } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { createApp } from '../../src/server.js';
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

    await runner.checkDue(new Date());
    expect(provider.calls).toHaveLength(0);

    const res = await app.request('/api/foreground', { method: 'POST' });
    expect(res.status).toBe(200);

    await runner.checkDue(new Date());
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
