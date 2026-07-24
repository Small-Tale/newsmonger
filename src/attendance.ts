/**
 * Tracks whether the app is in front of a user right now.
 *
 * Providers that authenticate with a subscription (Claude Pro/Max, ChatGPT)
 * spend the user's plan quota rather than metered API credit, and a scheduler
 * firing at 3am against someone's subscription is an unattended background
 * agent. Gating those checks on the app actually being open makes the usage
 * user-attended by construction.
 *
 * Deliberately in-memory and not persisted: this is session state, not user
 * data, and a restart genuinely should start from "nobody is watching".
 */

/** How long after the last foreground signal a check still counts as attended. */
export const ATTENDANCE_WINDOW_MS = 5 * 60 * 1000;

export class Attendance {
  #lastSeenAt: number | null = null;

  /** Record that the UI is foregrounded right now. */
  record(now: number = Date.now()): void {
    this.#lastSeenAt = now;
  }

  /**
   * Whether the app counts as attended.
   *
   * A fresh instance is NOT attended. That matters: the failure mode of
   * forgetting to wire this up is then "scheduled checks don't run", not
   * "subscription quota is spent unattended" — the gate fails closed, in the
   * direction that can't violate the thing it exists to protect.
   */
  isAttended(now: number = Date.now()): boolean {
    return this.#lastSeenAt !== null && now - this.#lastSeenAt < ATTENDANCE_WINDOW_MS;
  }

  /** Epoch ms of the last foreground signal, or null if there has never been one. */
  lastSeenAt(): number | null {
    return this.#lastSeenAt;
  }
}
