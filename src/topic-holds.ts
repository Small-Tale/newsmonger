/**
 * Topics the user currently has a dialog open on (NEWS-366).
 *
 * A scheduled check that lands while someone is typing guidance is the case
 * this exists for: the check runs against the *old* guidance, spends a provider
 * call on it, and fills the feed with the results the user was in the middle of
 * telling it not to want.
 *
 * Deliberately in-memory and not persisted, for the same reason as
 * `src/attendance.ts`: this is session state, not user data, and a restart
 * genuinely should start from "no dialogs are open".
 *
 * **Holds lapse rather than being released.** The client re-asserts on every
 * `/api/state` poll — four seconds, against the window below — so closing the
 * dialog, navigating away, or closing the tab all end the hold within one
 * window without anything having to send a release. There is no release path to
 * forget to call, and no way for a closed browser to hold a topic forever.
 *
 * That is the opposite choice to `Attendance`, which is deliberately its own
 * endpoint so a stray `curl` of `/api/state` cannot read as "a person is
 * watching". The asymmetry is intentional: attendance gates whether a
 * subscription's quota may be spent, so it has to be hard to assert by
 * accident. A hold only ever *delays* a check by a minute or so, so the worst a
 * forged one can do is postpone work the next poll will release.
 */

/**
 * How long a hold survives without being re-asserted.
 *
 * Comfortably more than the client's four-second poll, so an ordinary slow
 * response or a skipped tick never drops a hold while the dialog is still open;
 * short enough that a closed tab frees the topic promptly. The cost of being
 * wrong in either direction is small — a check runs a few seconds later, or a
 * check the user did not want runs a few seconds earlier.
 */
export const TOPIC_HOLD_WINDOW_MS = 15_000;

export class TopicHolds {
  #heldAt = new Map<string, number>();

  /** Record that a dialog is open on this topic right now. */
  hold(topicId: string, now: number = Date.now()): void {
    this.#heldAt.set(topicId, now);
  }

  /**
   * Whether a dialog is open on this topic.
   *
   * A fresh instance holds nothing, so failing to wire this up means checks run
   * exactly as they did before — the gate fails **open**, which is the safe
   * direction here. (`Attendance` fails closed, because the thing it protects is
   * someone's subscription quota; the thing this protects is a minute of the
   * user's typing.)
   */
  isHeld(topicId: string, now: number = Date.now()): boolean {
    const at = this.#heldAt.get(topicId);
    if (at === undefined) return false;
    if (now - at >= TOPIC_HOLD_WINDOW_MS) {
      // Drop it on read: the map would otherwise keep a row per topic ever
      // edited for the life of the process, and nothing else walks it.
      this.#heldAt.delete(topicId);
      return false;
    }
    return true;
  }

  /** Ids currently held, newest assertion first. Exposed for tests and diagnostics. */
  held(now: number = Date.now()): string[] {
    return [...this.#heldAt.keys()].filter((id) => this.isHeld(id, now));
  }
}
