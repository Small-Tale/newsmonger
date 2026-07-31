/**
 * When to offer the backup folder (NEWS-230, FR-27.2 / FR-27.4).
 *
 * Its own module for the same reason `onboarding.ts` and `dial.ts` are: the
 * decision has real branching — a topic threshold, two kinds of dismissal, one
 * of them time-based — and a branch that only ever runs inside a rendered dialog
 * is a branch that only ever gets tested through a browser.
 */

/** How long "Not now" holds the prompt off (FR-27.4). */
export const SNOOZE_MS = 24 * 60 * 60 * 1000;

/** The state the decision reads. All of it is persisted except `now`. */
export interface BackupPromptState {
  /** How many topics are being watched. */
  topicCount: number;
  /** The chosen backup folder; '' means backups are off. */
  backupDir: string;
  /** "Don't ask again" was pressed. */
  never: boolean;
  /** ISO timestamp "Not now" set, or '' if it never was. */
  snoozedUntil: string;
  now: number;
}

/**
 * The number of topics that triggers the offer (FR-27.2).
 *
 * Three, not one: someone with a single topic is still deciding whether they
 * want the app at all, and a dialog about where to keep backups of data they
 * barely have is noise. By the third they have committed enough for losing it to
 * matter — which is the moment the offer is worth making.
 */
export const OFFER_AFTER_TOPICS = 3;

export function shouldOfferBackup(s: BackupPromptState): boolean {
  // Already set up. The offer is to choose a folder; there is nothing to choose.
  if (s.backupDir !== '') return false;
  if (s.never) return false;
  if (s.topicCount < OFFER_AFTER_TOPICS) return false;
  if (s.snoozedUntil !== '') {
    const until = Date.parse(s.snoozedUntil);
    // An unparseable timestamp is treated as *still snoozed*, not as expired.
    // The alternative — re-asking because we couldn't read our own stored value
    // — turns one corrupt field into a dialog the user cannot get rid of.
    if (!Number.isFinite(until)) return false;
    if (s.now < until) return false;
  }
  return true;
}

/** The `snoozedUntil` value "Not now" should store. */
export function snoozeUntil(now: number): string {
  return new Date(now + SNOOZE_MS).toISOString();
}
