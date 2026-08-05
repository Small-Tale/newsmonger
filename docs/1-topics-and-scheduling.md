# 1 — Topics and Scheduling

> Renaming a topic, and optionally clearing the stories found under its old name, is covered by [25 — Topic Editing](25-topic-editing.md).

The core of the app: a list of topics the user follows, checked for news on a schedule.

## Topics

- **FR-1.1** *(Shipped)* The user can add a topic by name. Names are trimmed; empty names are rejected.
- **FR-1.2** *(Shipped)* Topic names are unique, case-insensitively. Adding a duplicate is rejected with a clear error.
- **FR-1.3** *(Shipped)* The user can delete a topic. Deleting a topic removes all of its news items and check-run records.
- **FR-1.4** *(Shipped)* The user can pause and resume a topic. Paused topics are skipped by both scheduled and "check all" sweeps (an explicit per-topic "Check" still works via the API only when unpaused — the UI disables nothing, but scheduled/check-all never touch paused topics).
- **FR-1.5** *(Shipped)* Each topic tracks when it was last checked (`lastCheckedAt`); this is shown in the UI as relative time, or as "not checked yet" when it is null — which includes a topic whose stories have just been cleared (FR-1.15).
- **FR-1.13** *(Shipped)* A topic may carry optional free-text **guidance** describing what the user wants from it, which is fed to every check's prompt. Empty by default, so a plain topic behaves exactly as before. Full spec in [18 — Topic Guidance](18-topic-guidance.md).

## Scheduling

- **FR-1.6** *(Shipped)* A single global check interval applies to all topics (default: 1 day). The user can change it; allowed range is 5 minutes and up (UI offers 1h–1 week presets). **"Single" is no longer literal** — high-priority topics run on their own shorter interval ([12 — Topic Priority](12-topic-priority.md)), and a daily-times schedule replaces the interval entirely (FR-1.14). This remains the default and the fallback both are measured against.
- **FR-1.7** *(Shipped)* A scheduler sweeps once per minute (plus once ~3 s after startup) and checks every unpaused topic whose last check is older than the interval, or that has never been checked.
- **FR-1.8** *(Shipped)* Sweeps never overlap; a topic is never checked concurrently with itself. **"Sequentially within a sweep" was superseded** by [FR-13.4](13-scheduling-under-load.md) — sweeps run with bounded concurrency (`checkConcurrency`, default 3), and a cap of 1 is exactly the behaviour described here. The two invariants either side of that clause still hold and are the load-bearing half.
- **FR-1.9** *(Shipped)* A failed check still advances `lastCheckedAt`, so a broken topic retries next interval instead of hammering the API every minute. The failure is recorded in the run history and surfaced in the UI.
- **FR-1.10** *(Shipped)* A topic tracks **three** clocks, because they answer different questions:

  | Field | Advances on | Drives |
  |---|---|---|
  | `lastCheckedAt` | every attempt, success **or** failure | what the UI displays — "checked 3h ago" vs "not checked yet" |
  | `coveredThroughAt` | successes only | `sinceIso` in the prompt — how far back to ask |
  | `clearedAt` | a clear of the topic's stories (FR-1.15) | nothing on its own; it is the *fallback* due-ness baseline |

  A single failed check used to move `lastCheckedAt` to now, and the prompt asked from there — so one rate-limit blip with five days of news pending discarded all five days, permanently and silently. Keeping the covered-through point separate means a failure delays the catch-up without shrinking it. An attendance deferral (see [6 — AI Providers](6-providers.md)) advances neither.

  Due-ness is measured from the **scheduling baseline**, `lastCheckedAt ?? clearedAt` (`scheduleBaseline` in `src/checks.ts`), not from `lastCheckedAt` alone. The two are the same for every topic that has never been cleared, which is why this is a fallback rather than a new mechanism. `??` rather than a maximum is safe because a clear nulls `lastCheckedAt` in the same transaction that sets `clearedAt`: a non-null check time is therefore always from a check that ran *after* the clear.
- **FR-1.14** *(Shipped)* **Two schedule modes** (NEWS-84), chosen in Settings:

  - `interval` (default, and what every existing install keeps on load) — the original behaviour: a duration since the last check.
  - `daily` — fixed local times of day (`HH:MM`, comma separated, up to 8). "The 8am briefing" is how people actually think about a digest, and an interval anchored to whenever the last check happened to run slowly walks around the clock.

  Evaluated by the same minute-tick scheduler: `isDueUnderSchedule` picks the rule, so the scheduler gains no second mechanism.

  Three properties that decide whether this is a schedule or an alarm:

  1. **A missed slot stays outstanding.** Due means "the most recent slot has passed and nothing has run since" — not "it is 08:00 right now". The app may be closed at 08:00; a morning briefing should still be there at lunchtime rather than being skipped to tomorrow.
  2. **Before the day's first slot, the standing obligation is yesterday's last one.** Otherwise a topic last checked two days ago reads as up to date at 3am.
  3. **High-priority topics stay on their interval.** "Every 2 hours" is the whole point of that tier (FR-12.4); folding it into a twice-daily schedule would silently make it check *less* often.

  Times are evaluated in **local** time, so "8am" keeps meaning eight o'clock where the user is across a DST change. An empty list falls back to the interval — the mode can never leave a topic unscheduled forever. The store sorts and de-duplicates the list on save, so every reader sees the same canonical value; the UI refuses unparseable input and restores the saved value rather than clearing the schedule.

- **FR-1.11** *(Shipped)* The user can trigger an immediate check for one topic or all unpaused topics ("Check all now").
- **FR-1.12** *(Shipped)* **Adding a topic checks it immediately** rather than leaving it for the next scheduler tick (up to a minute away) — the user just added it and is watching for the first results. The initial check is treated as **manual** (`checkTopic({ manual: true })`): it records attendance and so runs even for a subscription provider with no prior foreground signal, matching the Check-now buttons. It is fired in the background, so `POST /api/topics` returns immediately; the client's `/api/state` poll surfaces the in-flight state and then the items. The in-flight guard (FR-1.8) means a scheduler tick that also finds the new topic due won't double-run it.

- **FR-1.15** *(Shipped)* **Clearing a topic's stories resets it to its initial state** (NEWS-291) — in the owner's words, "almost like removing and readding it". This applies to both clear paths: the per-topic clear offered with a rename ([25 — Topic Editing](25-topic-editing.md)) and the app-wide "clear all stories" ([27 — Data Location](27-data-location.md)).

  Reset: `lastCheckedAt`, `coveredThroughAt`, `consecutiveFailures` and `retryAfter`. Set: `clearedAt`. Untouched: the topic's identity and the user's preferences for it — `name`, `guidance`, `paused`, `highPriority`, `category`/`subcategory`/`categorySource`, `createdAt`. The full field-by-field audit, including what is not a column at all, is in [2 — News Checks and Deduplication](2-news-checks-and-dedup.md#what-a-clear-resets).

  **A cleared topic reads as never checked but is not due.** These pull in opposite directions and both are requirements:

  1. Every surface must show a genuinely initial state. "checked 54m ago" beside an empty feed reads as a clear that did not work, and qualifying it ("· no stories") was rejected as insufficient — the user asked for the state where we have never yet checked.
  2. A clear must not make the topic due. Clearing **stops** the checks in flight and the topics queued behind them (FR-27.11); making every cleared topic due would start a fresh sweep on the next minute tick, one minute after the user said they wanted none of it.

  Separating the display field from the scheduling baseline (FR-1.10) is what satisfies both: the UI asks `lastCheckedAt` and sees null; the scheduler asks the baseline and waits a full interval from the clear. In `daily` mode the same baseline means a clear counts as having served the slot that has passed, so the *next* slot is owed — exactly as a real check would leave it.

  Undoing a clear (FR-26.x, [26 — Undo](26-undo.md)) restores every field the reset touched, `clearedAt` included: an undo is an inverse, and leaving the baseline set would hold the topic back on account of an event that no longer happened.

Per-topic interval overrides (high-priority topics) are covered in [12 — Topic Priority](12-topic-priority.md). What happens when a cycle can't keep up with the interval — immediate restart, most-overdue-first ordering, and the falling-behind signal — is in [13 — Scheduling Under Load](13-scheduling-under-load.md).

See also: [2 — News Checks and Deduplication](2-news-checks-and-dedup.md), [4 — CLI, Server, and Storage](4-cli-server-storage.md), [18 — Topic Guidance](18-topic-guidance.md).
