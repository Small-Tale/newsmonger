import { NEW_TOPIC_GRACE_MS } from '../../src/checks.js';

/**
 * A sweep time past a just-created topic's settling grace (NEWS-366).
 *
 * `store.addTopic` stamps `createdAt` from the real clock, and `checkDue` skips
 * a topic for the first minute of its life so the user can write guidance
 * first. A test whose subject is something else — pausing, concurrency, the
 * failure cooldown, the attendance gate — needs its topics to be past that
 * window, or the sweep finds nothing and the test passes or fails for a reason
 * it is not about.
 *
 * Reads as what it means at the call site: *a minute later, when the new topics
 * are eligible*. Preferred over `new Date()` in any test that creates a topic
 * and then sweeps.
 */
export function afterGrace(offsetMs = 0): Date {
  return new Date(Date.now() + NEW_TOPIC_GRACE_MS + offsetMs);
}
