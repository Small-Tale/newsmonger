# 18 — Topic Guidance

Let a topic carry free-text instructions about what the user actually wants from it. A topic is otherwise just a noun, and real interests are narrower than nouns: "Tesla, but regulatory and safety news only — not stock price moves", "my city, but only civic and planning decisions".

This is the *forward* half of steering a topic. The backward half already exists: [15 — Off-Topic Flagging](15-off-topic-flagging.md) lets the user correct a topic after it has served them the wrong thing. Guidance lets them say it first. See also [1 — Topics and Scheduling](1-topics-and-scheduling.md) and [2 — News Checks and Deduplication](2-news-checks-and-dedup.md).

## Status: shipped

### The field

- **FR-18.1** *(Shipped)* A topic carries an optional `guidance` string (`TopicSchema`), defaulting to `''`. Empty means the topic name alone, which is byte-for-byte the pre-guidance behaviour — a test pins the two prompts as identical so the feature can't quietly change results for topics that don't use it.

- **FR-18.2** *(Shipped)* Guidance is **trimmed** on write (`Store.setTopicGuidance`) so whitespace-only input reads as "none" everywhere downstream: the prompt, the sidebar badge, and the menu label all key off emptiness and must agree. Clearing it is just saving an empty value — there is no separate delete.

- **FR-18.3** *(Shipped)* Length is capped at `MAX_GUIDANCE_LENGTH` (1000 characters). Generous enough for a paragraph of real instructions, small enough that it can't crowd out the rest of the prompt or bloat the data file. The **API rejects** an over-length value with 400 rather than truncating silently — the caller should know its text didn't survive — while the **store truncates**, so a data file that somehow carries a longer string still loads instead of being condemned as corrupt (which would reset every topic).

- **FR-18.4** *(Shipped)* A topic stored before this feature existed has no `guidance` key at all; zod's `.default('')` supplies one on load. No migration, and no risk to the file.

### Editing

- **FR-18.5** *(Shipped)* Guidance is edited from the topic **right-click menu** ("Add guidance" / "Edit guidance" depending on whether there is any), which opens a dialog with a textarea, a placeholder showing the shape of a useful instruction, and Save / Cancel. Cancel discards; the saved text is untouched.

- **FR-18.6** *(Shipped)* The menu entry is **disabled unless exactly one topic is targeted**. Guidance is a paragraph about *this* topic — there is nothing sensible to write across a mixed selection — so it is disabled rather than absent, which says "not for a multi-selection" instead of "doesn't exist".

- **FR-18.7** *(Shipped)* A topic with guidance shows a muted crosshair badge in the sidebar, whose tooltip is the guidance text. Deliberately quieter than the high-priority star: it means "this topic is narrowed", not "this topic is urgent".

- **FR-18.8** *(Shipped)* Saving raises a toast — "Guidance saved — applies from the next check". Guidance changes nothing already in the feed, and without saying so, saving looks like it did nothing until the next sweep.

  > kerf note: the textarea is **uncontrolled** — JSX children seed it and nothing re-renders it while the user types. kerf's morph only syncs a textarea's content when it is *not* the active element, so the 4 s state poll can't clobber a half-written instruction.

### Prompt integration

- **FR-18.9** *(Shipped)* On each check, the topic's guidance travels through `NewsProvider.checkTopic` in a `TopicContext` (alongside the off-topic titles) into `buildUserPrompt`, where it becomes an instruction block: the model is told to follow it, that it takes precedence over the model's own judgement of what is newsworthy, and that a story which doesn't fit should be left out **even if it is significant**. Without that last clause the model treats guidance as a hint and reports the big story anyway — which is exactly the noise the user wrote the guidance to stop.

- **FR-18.10** *(Shipped)* Guidance is placed **before** the off-topic examples in the prompt. The two carry different authority: guidance is what the user *said*, flagged titles are what their behaviour implied, and the explicit instruction should win where they seem to disagree.

- **FR-18.11** *(Shipped)* Guidance applies from the **next** check. Stories already in the feed are not re-filtered — they were reported under the rules in force at the time, and silently deleting past results would make the feed untrustworthy.

  > `checkTopic`'s fourth parameter became a `TopicContext` object here rather than growing a fifth positional argument. Every provider (`anthropic`, `openai`, `claude-cli`, `codex-cli`, `mock`) forwards it unchanged; the mock records it so tests can assert on what the runner passed.

## Testing

- **Unit** (`tests/unit/guidance.test.ts`): prompt with/without guidance (including the identical-output guarantee and whitespace-only input), ordering against the off-topic block, composition with the already-reported list; store round-trip, trim, cap, and loading a topic with no `guidance` key; `CheckRunner` forwarding, including guidance **added and then removed between checks**; the `PATCH /api/topics/:id` route (set, clear, combined with another field, over-length rejection, unknown id).
- **E2E** (`tests/e2e/topics.spec.ts`): add via the menu → badge with the text in its tooltip → survives reload → reopen shows the saved text → **Cancel after editing leaves the saved text alone** → clear removes the badge; plus the menu item being disabled for a multi-selection.
