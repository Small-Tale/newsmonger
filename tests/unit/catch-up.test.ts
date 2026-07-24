import { describe, expect, it } from 'vitest';

import { buildUserPrompt } from '../../src/ai/prompt.js';
import { createMockProvider } from '../../src/ai/providers/index.js';
import { Attendance } from '../../src/attendance.js';
import { CheckRunner } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { fakeProvider } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

/** The line describing the window to cover (third line of the prompt). */
function windowLine(sinceIso: string | null): string {
  return buildUserPrompt('fusion energy', [], sinceIso).split('\n')[2] ?? '';
}

describe('prompt window wording', () => {
  it('asks for roughly a week on a first check', () => {
    expect(windowLine(null)).toMatch(/first check/i);
    expect(windowLine(null)).toMatch(/past week/i);
  });

  it('names a sub-hour gap without a bare zero', () => {
    expect(windowLine(ago(20 * 60_000))).toContain('less than an hour ago');
  });

  it('names an hours-scale gap', () => {
    expect(windowLine(ago(5 * HOUR))).toContain('5 hours ago');
    expect(windowLine(ago(1 * HOUR))).toContain('1 hour ago');
  });

  it('says "1 day" rather than "26 hours"', () => {
    // One day is the default interval, so this is the ordinary case — it reads
    // as a normal cadence, not a backlog.
    const line = windowLine(ago(26 * HOUR));
    expect(line).toContain('1 day ago');
    expect(line).not.toMatch(/whole period/);
  });

  it('switches to catch-up phrasing past two days', () => {
    const line = windowLine(ago(5 * DAY));
    expect(line).toContain('5 days ago');
    expect(line).toMatch(/whole period/);
    expect(line).toMatch(/not just the last day or two/);
    expect(line).toMatch(/oldest to newest/);
  });

  it('scales to a multi-week gap', () => {
    expect(windowLine(ago(21 * DAY))).toContain('21 days ago');
  });

  it('always includes the exact timestamp to anchor the window', () => {
    const since = ago(3 * DAY);
    expect(windowLine(since)).toContain(since);
  });
});

describe('coveredThroughAt survives failures', () => {
  it('a failed check does not shrink the next window', async () => {
    // Regression test for the original bug: one failure moved lastCheckedAt to
    // now, and the prompt asked from there — silently discarding days of
    // pending news.
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('fusion energy');
    const fiveDaysAgo = new Date(Date.now() - 5 * DAY);
    store.markTopicChecked(topic.id, fiveDaysAgo);
    store.markTopicCovered(topic.id, fiveDaysAgo);

    const failing = fakeProvider(() => Promise.reject(new Error('rate limited')));
    await new CheckRunner(store, () => Promise.resolve(failing)).checkTopic(topic.id);

    const after = store.getTopic(topic.id);
    // The attempt clock moved, so the scheduler waits before retrying...
    expect(Date.parse(after?.lastCheckedAt ?? '')).toBeGreaterThan(fiveDaysAgo.getTime());
    // ...but the covered-through point did not, so the news is still pending.
    expect(after?.coveredThroughAt).toBe(fiveDaysAgo.toISOString());
  });

  it('the next successful check asks from the original covered point', async () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('fusion energy');
    const fiveDaysAgo = new Date(Date.now() - 5 * DAY);
    store.markTopicChecked(topic.id, fiveDaysAgo);
    store.markTopicCovered(topic.id, fiveDaysAgo);

    const failing = fakeProvider(() => Promise.reject(new Error('rate limited')));
    await new CheckRunner(store, () => Promise.resolve(failing)).checkTopic(topic.id);

    const provider = createMockProvider();
    await new CheckRunner(store, () => Promise.resolve(provider)).checkTopic(topic.id);

    expect(provider.calls[0]?.sinceIso).toBe(fiveDaysAgo.toISOString());
  });

  it('survives a run of consecutive failures', async () => {
    // Three failures in a row must not compound into three lost windows.
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('fusion energy');
    const start = new Date(Date.now() - 5 * DAY);
    store.markTopicChecked(topic.id, start);
    store.markTopicCovered(topic.id, start);

    const failing = fakeProvider(() => Promise.reject(new Error('down')));
    const runner = new CheckRunner(store, () => Promise.resolve(failing));
    await runner.checkTopic(topic.id);
    await runner.checkTopic(topic.id);
    await runner.checkTopic(topic.id);

    expect(store.getTopic(topic.id)?.coveredThroughAt).toBe(start.toISOString());
  });

  it('a successful check advances both clocks', async () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('fusion energy');
    const start = new Date(Date.now() - 5 * DAY);
    store.markTopicChecked(topic.id, start);
    store.markTopicCovered(topic.id, start);

    await new CheckRunner(store, () => Promise.resolve(createMockProvider())).checkTopic(topic.id);

    const after = store.getTopic(topic.id);
    expect(Date.parse(after?.lastCheckedAt ?? '')).toBeGreaterThan(start.getTime());
    expect(Date.parse(after?.coveredThroughAt ?? '')).toBeGreaterThan(start.getTime());
  });

  it('a first successful check sets both from null', async () => {
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('fusion energy');
    expect(store.getTopic(topic.id)?.coveredThroughAt).toBeNull();

    const provider = createMockProvider();
    await new CheckRunner(store, () => Promise.resolve(provider)).checkTopic(topic.id);

    expect(provider.calls[0]?.sinceIso).toBeNull(); // asked as a first check
    expect(store.getTopic(topic.id)?.coveredThroughAt).not.toBeNull();
  });

  it('an attendance deferral advances neither clock', async () => {
    // A deferred check is not an attempt at all — the window must be intact
    // when the user finally opens the app.
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('fusion energy');
    const start = new Date(Date.now() - 5 * DAY);
    store.markTopicChecked(topic.id, start);
    store.markTopicCovered(topic.id, start);

    const provider = createMockProvider({ attended: true });
    const attendance = new Attendance();
    const runner = new CheckRunner(store, () => Promise.resolve(provider), attendance);

    await runner.checkDue(new Date());
    expect(store.getTopic(topic.id)?.lastCheckedAt).toBe(start.toISOString());
    expect(store.getTopic(topic.id)?.coveredThroughAt).toBe(start.toISOString());

    // Now the user opens the app: the full five-day window is still asked for.
    attendance.record();
    await runner.checkDue(new Date());
    expect(provider.calls[0]?.sinceIso).toBe(start.toISOString());
  });

  it('a failure while away still preserves the window until the user returns', async () => {
    // Compound sequence: away → deferred → user returns → check fails →
    // check succeeds. The original window must survive all of it.
    const store = new Store(tmpDataDir());
    const topic = store.addTopic('fusion energy');
    const start = new Date(Date.now() - 6 * DAY);
    store.markTopicChecked(topic.id, start);
    store.markTopicCovered(topic.id, start);

    const attendance = new Attendance();
    const failing = fakeProvider(() => Promise.reject(new Error('flaky')), { attended: true });
    await new CheckRunner(store, () => Promise.resolve(failing), attendance).checkDue(new Date());
    expect(store.getTopic(topic.id)?.coveredThroughAt).toBe(start.toISOString());

    attendance.record();
    await new CheckRunner(store, () => Promise.resolve(failing), attendance).checkDue(new Date());
    expect(store.getTopic(topic.id)?.coveredThroughAt).toBe(start.toISOString());

    const provider = createMockProvider({ attended: true });
    await new CheckRunner(store, () => Promise.resolve(provider), attendance).checkTopic(topic.id);
    expect(provider.calls[0]?.sinceIso).toBe(start.toISOString());
  });
});
