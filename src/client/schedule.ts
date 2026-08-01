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
 * at least once, and still unchecked after **more than two full intervals of
 * time in which checking was actually possible**.
 *
 * The 2× bar is deliberately conservative: a topic is always a little past due
 * at the moment it's checked, so flagging at the first overrun would cry wolf.
 * Never-checked topics are excluded — they're new, not behind.
 *
 * **`possibleSinceMs` is what stops this crying wolf for a different reason
 * (NEWS-247).** Lateness used to be measured from `lastCheckedAt` on the
 * wall clock, and the wall clock cannot tell *we cannot keep up* from *we were
 * not permitted to try*. A subscription provider only runs scheduled checks
 * while the app is attended (FR-6.5–6.8), so leaving the app in the background
 * for a day was enough to make every topic look badly overdue — and the banner
 * then advised fewer topics, a longer interval, or a faster provider, none of
 * which was the problem and none of which would have helped.
 *
 * So the clock starts at whichever is later: the topic's last check, or the
 * moment checking last became possible. Time the app could not have used is
 * not time it wasted.
 */
export function isBehindSchedule(topic: Topic, settings: Settings, nowMs: number, possibleSinceMs = 0): boolean {
  if (topic.paused || topic.lastCheckedAt === null) return false;
  const from = Math.max(Date.parse(topic.lastCheckedAt), possibleSinceMs);
  return nowMs - from > 2 * effectiveIntervalMs(topic, settings);
}

/** The topics currently falling behind schedule (NEWS-59). */
export function topicsBehindSchedule(
  topics: Topic[],
  settings: Settings,
  nowMs: number,
  possibleSinceMs = 0,
): Topic[] {
  return topics.filter((t) => isBehindSchedule(t, settings, nowMs, possibleSinceMs));
}

/**
 * Topics to actually warn about (NEWS-67). During the grace window — just after
 * startup or an interval change — nothing is reported, so shortening the
 * interval doesn't fire the "falling behind" banner *before the scheduler has
 * had a chance to re-check* topics that were perfectly fresh under the old,
 * longer interval. Once the grace passes, a topic that's still overdue is
 * genuinely behind.
 */
export function activeBehindWarnings(
  topics: Topic[],
  settings: Settings,
  nowMs: number,
  graceUntilMs: number,
  possibleSinceMs = 0,
): Topic[] {
  if (nowMs < graceUntilMs) return [];
  return topicsBehindSchedule(topics, settings, nowMs, possibleSinceMs);
}
