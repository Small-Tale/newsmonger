# 13 — Scheduling Under Load

What happens when there are more topics (or shorter intervals) than a full check cycle can keep up with. Extends [1 — Topics and Scheduling](1-topics-and-scheduling.md); grew out of the NEWS-55 investigation.

The baseline was already safe: the `sweeping` re-entry guard means a long sweep never overlaps or restarts from scratch, nothing hammers the provider, and no news is lost — the interval simply degrades from a guarantee to a target, and topics refresh about every *sweep-duration*. These requirements sharpen that behaviour and make it visible.

## Immediate restart of an overrun cycle

- **FR-13.1** *(Shipped, NEWS-57)* When a sweep takes longer than the interval, the scheduler **restarts the cycle immediately** on completion instead of waiting for the next tick. `startScheduler` drains: it keeps calling `checkDue` while each pass still finds work, and only returns to the 60-second timer once a pass finds nothing due. `checkDue` returns the number of topics it checked, which is the drain signal.

  No busy-loop: a pass that checks nothing returns 0 and stops the drain, and a just-checked topic can't be due again immediately (the 5-minute minimum interval dwarfs a check). The non-overlap guarantee (`sweeping` guard) and single-snapshot-per-pass semantics are unchanged.

## Most-overdue-first ordering

- **FR-13.2** *(Shipped, NEWS-58)* Within a sweep, due topics are serviced **most-overdue-first** rather than in insertion order (`byCheckOrder` in `src/checks.ts`): high-priority topics ([12 — Topic Priority](12-topic-priority.md)) first, then never-checked, then the longest-waiting by `lastCheckedAt`. Under a backlog too large to clear within the interval, this is what keeps freshness fair and lets high-priority topics jump ahead of the pack instead of waiting behind whoever was added first.

  **Caveat (documented, accepted):** under a backlog so large that high-priority topics are *always* due, strict priority-first can starve normal topics. That's an extreme-overload corner — surfaced to the user by FR-13.3 — and high-priority topics are hand-picked and few, so the simple, predictable ordering is preferred over a heavier anti-starvation scheme.

## Falling-behind signal

- **FR-13.3** *(Shipped, NEWS-59)* When the real cadence lags well behind the chosen interval, a **dismissible banner** explains it ("Checks are falling behind your schedule — N topics are refreshing slower than the interval you picked…"). Purely informational — no behaviour change.

  A topic counts as behind when it's not paused, has been checked at least once, and is now overdue by **more than a full extra interval** (`now − lastCheckedAt > 2 × effectiveInterval` — `isBehindSchedule` in `src/client/schedule.ts`). The 2× bar is deliberately conservative: a topic is always slightly past due at the moment it's checked, so flagging the first minor overrun would cry wolf. Never-checked topics are excluded (new, not behind). Dismissal is session-level and reappears on reload if the condition persists.

  **Grace window (NEWS-67).** The banner is suppressed for a grace period (30 min) after **startup** and after any **interval change** (`activeBehindWarnings` + `behindGraceUntil`). Without it, *shortening* the interval instantly reclassified topics that were fresh under the old, longer interval as "behind" — before the scheduler had any chance to re-check them. The grace gives the scheduler a sweep to catch up; a topic still overdue after it is genuinely behind.

  The client reimplements `effectiveInterval` (rather than importing `src/checks.ts`, which pulls in Node-only deps).

## Practical ceiling

The maximum workable topic count depends on provider speed: a subscription provider (`claude-cli`/`codex-cli`) takes minutes per topic, so thousands of topics is infeasible (a cycle would take days, and it only runs while foregrounded — see [6 — AI Providers](6-providers.md)); a fast API provider is seconds per topic. FR-13.3 is what tells the user they've crossed that line for their chosen interval.

## Testing

- **Unit**: `byCheckOrder` (priority, never-checked, staleness, and a mixed-set sort); `checkDue` services in that order and returns a count; the scheduler drains an overrun cycle and doesn't busy-loop when idle; `isBehindSchedule` / `topicsBehindSchedule` (the 2× bar, high-priority interval, paused/never-checked exclusions).
- **E2E**: the falling-behind banner appears after fast-forwarding the clock past 2× the interval and is dismissible (`tests/e2e/app.spec.ts`).
