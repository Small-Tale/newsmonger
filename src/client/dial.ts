import type { StateResp } from '../api/schemas.js';

type Topic = StateResp['topics'][number];

/** What the dial measures from: the same fields the server schedules on. */
type Dialled = Pick<Topic, 'lastCheckedAt' | 'paused'> & Partial<Pick<Topic, 'clearedAt'>>;

/**
 * The moment the countdown runs from — a client-side mirror of the server's
 * `scheduleBaseline` (`src/checks.ts`), reimplemented here for the same reason
 * `effectiveIntervalMs` is in `schedule.ts`: that module pulls in Node-only
 * dependencies the client bundle can't take.
 *
 * The dial must use the *scheduling* baseline rather than `lastCheckedAt`, or a
 * cleared topic shows a full ring and "Waiting for first check" for a whole
 * interval while a check quietly approaches (NEWS-291). The row's *text* is a
 * different question and correctly says "not checked yet" — that is a claim
 * about the past, and it is true. The ring is a claim about the future, and it
 * would not be.
 */
function baselineOf(topic: Dialled): string | null {
  return topic.lastCheckedAt ?? topic.clearedAt ?? null;
}

/**
 * How much of a topic's check interval is still to run (NEWS-144).
 *
 * 1 immediately after a check, falling to 0 as the next one comes due. The ring
 * in the sidebar draws this directly, so it **counts down**: a ring that fills
 * up reads as progress toward something the user is waiting for, which is
 * backwards — what is draining is the time left before the app acts on its own.
 *
 * Pure and clamped, so a clock skew or a baseline in the future can't produce a
 * ring longer than its own circumference.
 */
export function dialRemaining(topic: Dialled, intervalMs: number): number {
  // A topic with nothing to count from shows a full ring: everything is still
  // to come. A paused one does too — its interval isn't running down at all,
  // and draining toward a check that will never fire would be a lie.
  const since = baselineOf(topic);
  if (since === null || topic.paused) return 1;
  // A non-positive interval would divide by zero or invert the ring; treat it
  // as "due now", which is what an interval of nothing means.
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  const elapsed = Date.now() - Date.parse(since);
  if (!Number.isFinite(elapsed)) return 1;
  return Math.min(1, Math.max(0, 1 - elapsed / intervalMs));
}

/**
 * Milliseconds until this topic's next automatic check (NEWS-202).
 *
 * `null` when a countdown would be meaningless — never checked, paused, or an
 * unparseable timestamp. Those states already have their own tooltip wording, and
 * returning 0 for them would claim a check is imminent when none is scheduled.
 *
 * Separate from `dialRemaining` rather than derived from it: that returns a
 * *fraction* for drawing the ring, and multiplying it back out by the interval
 * would reintroduce the rounding it already did.
 */
export function dialCountdownMs(topic: Dialled, intervalMs: number): number | null {
  const since = baselineOf(topic);
  if (since === null || topic.paused) return null;
  // A non-positive interval means "no waiting period", i.e. due now.
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  const elapsed = Date.now() - Date.parse(since);
  if (!Number.isFinite(elapsed)) return null;
  // Clamped: an overdue check is "due now", never a negative countdown. A
  // baseline in the future is capped at the full interval rather than promising
  // a check further out than the schedule allows.
  return Math.min(intervalMs, Math.max(0, intervalMs - elapsed));
}

/**
 * A duration as the tooltip says it (NEWS-202).
 *
 * Deliberately the same compact vocabulary as the "checked 23h ago" label the
 * dial sits beside — `42m`, `3h`, `2d` — so a row doesn't mix two ways of saying
 * how long. Coarse on purpose: the check fires on a minute tick, so second-level
 * precision would be false, and a tooltip that changes while you read it is worse
 * than one that rounds.
 */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'due now';
  // Not "due now" — there is still time left, and saying otherwise would have the
  // tooltip contradict a ring that is visibly not empty.
  if (ms < 60_000) return 'in under a minute';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}
