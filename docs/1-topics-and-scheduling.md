# 1 — Topics and Scheduling

The core of the app: a list of topics the user follows, checked for news on a schedule.

## Topics

- **FR-1.1** The user can add a topic by name. Names are trimmed; empty names are rejected.
- **FR-1.2** Topic names are unique, case-insensitively. Adding a duplicate is rejected with a clear error.
- **FR-1.3** The user can delete a topic. Deleting a topic removes all of its news items and check-run records.
- **FR-1.4** The user can pause and resume a topic. Paused topics are skipped by both scheduled and "check all" sweeps (an explicit per-topic "Check" still works via the API only when unpaused — the UI disables nothing, but scheduled/check-all never touch paused topics).
- **FR-1.5** Each topic tracks when it was last checked (`lastCheckedAt`); this is shown in the UI as relative time.
- **FR-1.13** A topic may carry optional free-text **guidance** describing what the user wants from it, which is fed to every check's prompt. Empty by default, so a plain topic behaves exactly as before. Full spec in [18 — Topic Guidance](18-topic-guidance.md).

## Scheduling

- **FR-1.6** A single global check interval applies to all topics (default: 1 day). The user can change it; allowed range is 5 minutes and up (UI offers 1h–1 week presets).
- **FR-1.7** A scheduler sweeps once per minute (plus once ~3 s after startup) and checks every unpaused topic whose last check is older than the interval, or that has never been checked.
- **FR-1.8** Sweeps never overlap; topics are checked sequentially within a sweep; a topic is never checked concurrently with itself.
- **FR-1.9** A failed check still advances `lastCheckedAt`, so a broken topic retries next interval instead of hammering the API every minute. The failure is recorded in the run history and surfaced in the UI.
- **FR-1.10** *(Shipped)* A topic tracks **two** clocks, because they answer different questions:

  | Field | Advances on | Drives |
  |---|---|---|
  | `lastCheckedAt` | every attempt, success **or** failure | `isDue()` — the retry throttle above |
  | `coveredThroughAt` | successes only | `sinceIso` in the prompt — how far back to ask |

  A single failed check used to move `lastCheckedAt` to now, and the prompt asked from there — so one rate-limit blip with five days of news pending discarded all five days, permanently and silently. Keeping the covered-through point separate means a failure delays the catch-up without shrinking it. An attendance deferral (see [6 — AI Providers](6-providers.md)) advances neither.
- **FR-1.14** *(Shipped)* **Two schedule modes** (NEWS-84), chosen in Settings:

  - `interval` (default, and what every existing install keeps on load) — the original behaviour: a duration since the last check.
  - `daily` — fixed local times of day (`HH:MM`, comma separated, up to 8). "The 8am briefing" is how people actually think about a digest, and an interval anchored to whenever the last check happened to run slowly walks around the clock.

  Evaluated by the same minute-tick scheduler: `isDueUnderSchedule` picks the rule, so the scheduler gains no second mechanism.

  Three properties that decide whether this is a schedule or an alarm:

  1. **A missed slot stays outstanding.** Due means "the most recent slot has passed and nothing has run since" — not "it is 08:00 right now". The app may be closed at 08:00; a morning briefing should still be there at lunchtime rather than being skipped to tomorrow.
  2. **Before the day's first slot, the standing obligation is yesterday's last one.** Otherwise a topic last checked two days ago reads as up to date at 3am.
  3. **High-priority topics stay on their interval.** "Every 2 hours" is the whole point of that tier (FR-12.4); folding it into a twice-daily schedule would silently make it check *less* often.

  Times are evaluated in **local** time, so "8am" keeps meaning eight o'clock where the user is across a DST change. An empty list falls back to the interval — the mode can never leave a topic unscheduled forever. The store sorts and de-duplicates the list on save, so every reader sees the same canonical value; the UI refuses unparseable input and restores the saved value rather than clearing the schedule.

- **FR-1.11** The user can trigger an immediate check for one topic or all unpaused topics ("Check all now").
- **FR-1.12** *(Shipped)* **Adding a topic checks it immediately** rather than leaving it for the next scheduler tick (up to a minute away) — the user just added it and is watching for the first results. The initial check is treated as **manual** (`checkTopic({ manual: true })`): it records attendance and so runs even for a subscription provider with no prior foreground signal, matching the Check-now buttons. It is fired in the background, so `POST /api/topics` returns immediately; the client's `/api/state` poll surfaces the in-flight state and then the items. The in-flight guard (FR-1.8) means a scheduler tick that also finds the new topic due won't double-run it.

Per-topic interval overrides (high-priority topics) are covered in [12 — Topic Priority](12-topic-priority.md). What happens when a cycle can't keep up with the interval — immediate restart, most-overdue-first ordering, and the falling-behind signal — is in [13 — Scheduling Under Load](13-scheduling-under-load.md).

See also: [2 — News Checks and Deduplication](2-news-checks-and-dedup.md), [4 — CLI, Server, and Storage](4-cli-server-storage.md), [18 — Topic Guidance](18-topic-guidance.md).
