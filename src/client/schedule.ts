import type { StateResp } from '../api/schemas.js';

type Topic = StateResp['topics'][number];
type Settings = StateResp['settings'];

/**
 * The interval a topic is checked on. Mirrors the server's `effectiveInterval`
 * (src/checks.ts) — reimplemented here rather than imported, since that module
 * pulls in Node-only dependencies the client bundle can't take.
 */
function effectiveIntervalMs(topic: Topic, settings: Settings): number {
  return topic.highPriority ? settings.highPriorityIntervalMs : settings.checkIntervalMs;
}

/**
 * Whether one topic is falling behind schedule (NEWS-59): not paused, checked
 * at least once, and now overdue by **more than a full extra interval** — i.e.
 * the real cadence is running ~2× slower than the interval the user chose.
 *
 * The 2× bar is deliberately conservative: a topic is always a little past due
 * at the moment it's checked, so flagging at the first overrun would cry wolf.
 * Never-checked topics are excluded — they're new, not behind.
 */
export function isBehindSchedule(topic: Topic, settings: Settings, nowMs: number): boolean {
  if (topic.paused || topic.lastCheckedAt === null) return false;
  const age = nowMs - Date.parse(topic.lastCheckedAt);
  return age > 2 * effectiveIntervalMs(topic, settings);
}

/** The topics currently falling behind schedule (NEWS-59). */
export function topicsBehindSchedule(topics: Topic[], settings: Settings, nowMs: number): Topic[] {
  return topics.filter((t) => isBehindSchedule(t, settings, nowMs));
}
