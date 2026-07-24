# 1 — Topics and Scheduling

The core of the app: a list of topics the user follows, checked for news on a schedule.

## Topics

- **FR-1.1** The user can add a topic by name. Names are trimmed; empty names are rejected.
- **FR-1.2** Topic names are unique, case-insensitively. Adding a duplicate is rejected with a clear error.
- **FR-1.3** The user can delete a topic. Deleting a topic removes all of its news items and check-run records.
- **FR-1.4** The user can pause and resume a topic. Paused topics are skipped by both scheduled and "check all" sweeps (an explicit per-topic "Check" still works via the API only when unpaused — the UI disables nothing, but scheduled/check-all never touch paused topics).
- **FR-1.5** Each topic tracks when it was last checked (`lastCheckedAt`); this is shown in the UI as relative time.

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
- **FR-1.11** The user can trigger an immediate check for one topic or all unpaused topics ("Check all now").
- **FR-1.12** *(Shipped)* **Adding a topic checks it immediately** rather than leaving it for the next scheduler tick (up to a minute away) — the user just added it and is watching for the first results. The initial check is treated as **manual** (`checkTopic({ manual: true })`): it records attendance and so runs even for a subscription provider with no prior foreground signal, matching the Check-now buttons. It is fired in the background, so `POST /api/topics` returns immediately; the client's `/api/state` poll surfaces the in-flight state and then the items. The in-flight guard (FR-1.8) means a scheduler tick that also finds the new topic due won't double-run it.

Per-topic interval overrides (high-priority topics) are covered in [12 — Topic Priority](12-topic-priority.md). What happens when a cycle can't keep up with the interval — immediate restart, most-overdue-first ordering, and the falling-behind signal — is in [13 — Scheduling Under Load](13-scheduling-under-load.md).

See also: [2 — News Checks and Deduplication](2-news-checks-and-dedup.md), [4 — CLI, Server, and Storage](4-cli-server-storage.md).
