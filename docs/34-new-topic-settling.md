# 34 — Letting a New Topic Settle

Adding a topic and saying what you want from it are two separate actions, and the scheduler runs between them. This document covers the two rules that keep a check from beating the user to their own guidance.

Related: [1 — Topics and Scheduling](1-topics-and-scheduling.md) (when a topic is due), [18 — Topic Guidance](18-topic-guidance.md) (what guidance is and how it reaches the prompt), [25 — Topic Editing](25-topic-editing.md) (the rename dialog), [13 — Scheduling Under Load](13-scheduling-under-load.md) (the sweep), [9 — Subscription Providers](9-subscription-providers.md) (why a wasted check costs quota, not just time).

## The problem

The scheduler ticks once a minute, and a topic that has never been checked is due the instant it exists ([1 — Topics and Scheduling](1-topics-and-scheduling.md)). So a topic added at 12:00:59 is checked at 12:01:00 — against its name alone, while the user is still opening the guidance box.

The result is not *wrong*, it is **premature**, and it is expensive in three ways at once:

- it spends a provider call, which on a subscription is plan quota ([9 — Subscription Providers](9-subscription-providers.md));
- it fills the feed with exactly the broad results the guidance existed to narrow;
- those stories are now in the dedup ledger, so the *next* check — the one that finally knows what the user wanted — will not report them again.

That third one is why "just ignore the bad stories" is not an answer. A premature check does not merely produce noise; it consumes the news it was too early to summarise properly.

## Requirements

- **FR-34.1** *(Shipped, NEWS-366)* **A brand-new topic waits one minute before its first scheduled check.** `NEW_TOPIC_GRACE_MS` in `src/checks.ts`, applied in `CheckRunner.checkDue` beside the dialog hold.

  It **gates rather than replaces**, as the failure cooldown does: a minute later the ordinary rules apply and the topic runs on the next tick, with no separate "now it may run" state to get stuck in.

  The length is injectable on the runner (`newTopicGraceMs`), for the same reason `sleep` is. A test whose subject is the retry gate or the failure cooldown creates topics and sweeps in the same breath, and *cannot* simply sweep a minute later — those gates are measured against the real clock, so moving the sweep's `now` forward expires the very window under test. Passing 0 says "this test is not about the grace" without distorting anything else; `instantRetry` and `fastRetry` in `tests/helpers/provider.ts` carry it for exactly that reason.

- **FR-34.2** *(Shipped, NEWS-366)* **The grace applies only to a topic that has never been checked *and* never been cleared.** The condition is `scheduleBaseline(topic) === null`, which is true exactly once in a topic's life.

  A cleared topic is deliberately excluded. It reads as never-checked for *display* ([FR-3.x](3-ui.md), NEWS-273) but keeps its `clearedAt` baseline for *scheduling* (NEWS-291), so it already waits a full interval — and the user who just cleared it has said what they want. Giving it a second settling minute would delay a check nobody was going to edit.

- **FR-34.3** *(Shipped, NEWS-366)* **A missing, unparseable, or future `createdAt` means no grace.** Consistent with how `clearedAt` and `retryAfter` degrade: an absent field restores the behaviour from before that field existed, rather than inventing a delay from a timestamp nobody supplied.

  The *future* case is the one worth stating, because the obvious implementation gets it wrong. "Created less than a minute ago" written as `now - created < GRACE` is also true when `now` is **before** `created` — a clock that has jumped backwards — and after a large correction that holds the topic back until the clock catches up, potentially for days. The condition is `0 <= elapsed < GRACE`: how long the topic has existed is unknowable in that state, so it fails open and the topic runs.

- **FR-34.4** *(Shipped, NEWS-366)* **A topic with its edit or guidance dialog open is not checked by a sweep.** `TopicHolds` in `src/topic-holds.ts`, filtered in `CheckRunner.checkDue`.

  A minute buys time to *start* typing; this covers the rest of it. The two rules are deliberately different mechanisms because they answer different questions — "has this topic had a chance yet" is a fact about the topic, and "is someone editing it right now" is a fact about the session.

- **FR-34.5** *(Shipped, NEWS-366)* **Holds lapse; they are never released.** The client re-asserts on every `/api/state` poll (four seconds) and a hold expires after `TOPIC_HOLD_WINDOW_MS` (15 s) without one.

  There is no release endpoint, so there is no release path to forget. Both dialogs can be dismissed several ways — the button, the backdrop, Escape, the topic being deleted underneath them — and a push model would need every one of those to remember to send one. Closing the tab ends a hold exactly as closing the dialog does.

  The client reads the id from the same store fields that decide whether the dialog is *rendered* (`guidanceTopicId ?? renameTopicId`), so the hold cannot fall out of step with what is on screen.

- **FR-34.6** *(Shipped, NEWS-366)* **The hold rides the state poll rather than getting its own endpoint — the opposite of `/api/foreground`, and deliberately.**

  Attendance is its own endpoint precisely so a stray `curl` of `/api/state` cannot read as "a person is watching" ([9 — Subscription Providers](9-subscription-providers.md)). That reasoning does not transfer: attendance gates whether a subscription's quota may be spent, so it must be hard to assert by accident, while a hold only ever *delays* a check. The worst a forged hold can do is postpone work that the next poll will release.

- **FR-34.7** *(Shipped, NEWS-366)* **Both gates live in `checkDue`, not in `isDueUnderSchedule`** — a topic in its grace, and a topic with a dialog open, are both genuinely *due*. They are being given a moment, which is not the same as not being owed a check.

  `isDueUnderSchedule` stays a pure function of the topic and the settings, and that is what the client's countdown dial is derived from. Folding either fact into it would make the dial answer "is someone typing" — a different question, and a confusing thing to watch happen, since the countdown would reset whenever the guidance box opened.

  This was not the first shape tried. The grace initially sat inside `isDueUnderSchedule` next to the failure cooldown, which reads naturally — both are "not now" — and it broke twenty-one existing tests. Most were tests of pausing, concurrency and cooldowns that happened to create a topic and sweep immediately, and would have broken either way; but the split above is what let the schedule predicate and its own tests stay untouched.

- **FR-34.8** *(Shipped, NEWS-366)* **Neither rule affects a manual check.** "Check now" and "Check all now" are explicit user requests; a user who adds a topic and immediately asks for a check has said what they want more clearly than any heuristic here can.

  So `checkAll` and the single-topic check path are untouched — the grace and the hold both live on the *scheduled* path only.

- **FR-34.9** *(Shipped, NEWS-366)* **Both gates fail open.** A fresh `TopicHolds` holds nothing, and an absent `createdAt` grants no grace, so failing to wire either up leaves scheduled checks behaving exactly as they did before.

  This is the opposite of `Attendance`, which fails *closed*, and the asymmetry is the point: attendance protects someone's subscription quota, so its failure mode must be "checks do not run". These protect a minute of typing, so their failure mode should be "checks run as they always did" rather than "a topic is never checked again".

## Notes

**Why one minute.** Long enough to open the dialog and start typing, short enough that a user who adds a topic and walks away is not left wondering why nothing happened. It is not a setting: a knob here would need explaining in terms of a race the user cannot see, and the honest fix for "I need longer" is that the hold already covers as long as the dialog is open.

**The two rules compose, and the order matters.** The grace covers the gap between *creating* the topic and *opening* the dialog — a window no client signal can cover, because the dialog is not open yet. The hold covers the dialog being open. Neither alone is sufficient: without the grace, a sweep can land in the seconds before the dialog opens; without the hold, a minute expires while the user is mid-sentence.

**What is deliberately not covered.** A user who adds a topic, does not open a dialog, and starts typing guidance more than a minute later gets a check first. Closing that window entirely would mean either a much longer grace (delaying every new topic for the sake of a rare one) or inferring intent from keystrokes outside a dialog. The hold is the supported way to say "wait, I am editing this".
