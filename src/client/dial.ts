import type { StateResp } from '../api/schemas.js';

type Topic = StateResp['topics'][number];

/**
 * How much of a topic's check interval is still to run (NEWS-144).
 *
 * 1 immediately after a check, falling to 0 as the next one comes due. The ring
 * in the sidebar draws this directly, so it **counts down**: a ring that fills
 * up reads as progress toward something the user is waiting for, which is
 * backwards — what is draining is the time left before the app acts on its own.
 *
 * Pure and clamped, so a clock skew or a `lastCheckedAt` in the future can't
 * produce a ring longer than its own circumference.
 */
export function dialRemaining(topic: Pick<Topic, 'lastCheckedAt' | 'paused'>, intervalMs: number): number {
  // A topic that has never been checked shows a full ring: everything is still
  // to come. A paused one does too — its interval isn't running down at all,
  // and draining toward a check that will never fire would be a lie.
  if (topic.lastCheckedAt === null || topic.paused) return 1;
  // A non-positive interval would divide by zero or invert the ring; treat it
  // as "due now", which is what an interval of nothing means.
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  const elapsed = Date.now() - Date.parse(topic.lastCheckedAt);
  if (!Number.isFinite(elapsed)) return 1;
  return Math.min(1, Math.max(0, 1 - elapsed / intervalMs));
}
