# 12 — Topic Priority

A topic can be marked **high priority** so it's checked on a shorter interval than the rest, without changing how often everything else is checked. See also [1 — Topics and Scheduling](1-topics-and-scheduling.md).

## Status: shipped

- **FR-12.1** *(Shipped)* A topic is either **normal** or **high priority** — a single boolean (`highPriority` on the topic), not a multi-level scale. Defaults to normal. New and legacy topics load as normal.

- **FR-12.2** *(Shipped)* There are **two global intervals** in Settings: the default ("Check every") and a separate high-priority one ("High-priority topics every"). A normal topic is checked on the default interval; a high-priority topic on the high-priority interval. Selecting each: `effectiveInterval(topic, settings)` in `src/checks.ts`, used by `checkDue`.

- **FR-12.3** *(Shipped)* The high-priority interval is always **≤ the default interval** — a "high priority" topic must never be checked *less* often than a normal one. The store enforces this by **clamping the value the user did not just change** (`updateSettings`):
  - Shorten the default below the high-priority value → the high-priority value follows **down** to match.
  - Lengthen the high-priority value past the default → the default follows **up** to match.
  - If both arrive in one request, the default is the ceiling (high-priority clamps down).

  The invariant is also enforced on **load** (a `.transform` on `SettingsSchema`), so a legacy data file whose default interval is shorter than the field's 1-day default can't come back with an inverted pair.

- **FR-12.4** *(Shipped)* High priority changes **cadence only** — not ordering within a sweep, and not the attendance gate. On a subscription provider, scheduled high-priority checks still run only while the app is foregrounded (see [6 — AI Providers](6-providers.md)); high priority makes something check *more often*, not *unattended*. (Servicing high-priority topics first within a long sweep is deliberately **out of scope** here — tracked separately as NEWS-58.)

- **FR-12.5** *(Shipped)* A topic is marked/unmarked via the **right-click menu** ("High priority" / "Normal priority"), next to Pause and Solo, and works on a multi-topic selection (resolving toward high-priority when mixed). High-priority topics show a **star** (Lucide `star`) in the sidebar row, and the row's watch dial fills against the high-priority interval.

## Data & API

- Topic gains `highPriority: boolean` (default false); Settings gains `highPriorityIntervalMs: number` (default = the default interval).
- `PATCH /api/topics/:id` accepts `{ paused?, highPriority? }` (at least one).
- `PATCH /api/settings` accepts `highPriorityIntervalMs` (≥ 5-minute floor, same as the default interval); the ≤-default constraint is applied by clamping, not rejection.

## Testing

- **Unit**: `Store.setTopicHighPriority`; bidirectional interval clamping incl. the both-in-one-patch and non-interval-patch cases; load-time clamp of a legacy short-default file; `effectiveInterval`; a `checkDue` scenario where a high-priority topic is due on the short interval while a normal one isn't; the `PATCH /api/topics` and `PATCH /api/settings` routes.
- **E2E** (`tests/e2e/topics.spec.ts`): mark high priority via the menu → star appears → persists across reload → clear it; and the Settings picker clamping both directions.
