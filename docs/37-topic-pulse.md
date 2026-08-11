# 37 — Topic Pulse

Topic Pulse turns the stories Newsmonger already holds into a calm orientation layer. It does not search again and it does not ask a model to interpret the archive. Every number is deterministic metadata analysis over the same ordinary-feed rows the reader can open.

Related: [Topics and scheduling](1-topics-and-scheduling.md), [UI](3-ui.md), [Topic categories](22-topic-categories.md), and [Story threads](29-story-threads.md).

## Requirements

- **FR-37.1** *(Shipped, NEWS-453)* Every watched topic shows a seven-local-day activity sparkline in the Watching rail. All topic sparklines use the same seven-bucket shape; an accessible label states the exact story count for the period.
- **FR-37.2** *(Shipped, NEWS-453; clarified NEWS-459)* Exactly one soloed topic shows a compact 30-day pulse above its feed: story count, active-thread count, distinct primary outlets, the named top primary source with its share, daily volume, comparison with the previous 30 days, and a small-sample warning below ten stories. A percentage must never be labeled only as "top source" without naming that source.
- **FR-37.3** *(Shipped, NEWS-453)* Solo keeps the existing generic mode banner for its announcement and exit. Exactly one soloed topic additionally gets the compact pulse; multiple soloed topics do not silently combine into one analysis.
- **FR-37.4** *(Shipped, NEWS-453)* The compact pulse is a reading aid, not a dashboard takeover. It leaves the story feed visible and provides one explicit **Explore topic pulse** action into the detailed view.
- **FR-37.5** *(Shipped, NEWS-453)* An active top-level category or subcategory filter shows a restrained rollup under the taxonomy bar: stored-story volume, change from the previous equivalent period, and a sparkline. Opening it uses the same detailed view as a topic.
- **FR-37.6** *(Shipped, NEWS-453)* The detailed pulse supports exact 7-, 30-, and 90-local-day windows. Changing the period recomputes from the complete archive, not from the current feed page.
- **FR-37.7** *(Shipped, NEWS-453)* The detail view shows daily new-story and thread-update counts, coverage cadence, longest quiet run, most active day, primary-source concentration, and the three most-updated threads.
- **FR-37.8** *(Shipped, NEWS-453)* Every chart has a textual equivalent. Sparklines carry an accessible summary; the daily chart has a disclosure table with date, story count, and update count.
- **FR-37.9** *(Shipped, NEWS-453)* `foundAt` owns the local-calendar bucket, matching feed day headings. Off-topic stories are excluded, matching the ordinary feed.
- **FR-37.10** *(Shipped, NEWS-453)* One story contributes at most one source observation: its primary source. The outlet label is used when present, otherwise the source hostname minus `www.`. Source share is therefore `stories attributed to that primary source / stories with usable primary-source metadata`; unsourced stories remain in story totals but not that denominator.
- **FR-37.11** *(Shipped, NEWS-453)* A thread update is a story whose thread has an earlier stored member. The earlier member may predate the selected window; the first in-window row is still an update when the subject began before the window.
- **FR-37.12** *(Shipped, NEWS-453)* “Active threads” means distinct thread ids represented in the selected period. “Most-updated threads” excludes threads with no update in that period.
- **FR-37.13** *(Shipped, NEWS-453)* Category and subcategory pulses aggregate only stories belonging to topics currently classified under that taxonomy selection. They claim coverage in this personal Newsmonger archive, never worldwide importance or comprehensiveness.
- **FR-37.14** *(Shipped, NEWS-453)* Pulse surfaces state that figures come from stored stories and use no AI analysis. They do not infer political leaning, factuality, sentiment, independence, importance, or causal relationships.
- **FR-37.15** *(Shipped, NEWS-453)* On viewports below 860px the existing stacked layout remains: taxonomy, Watching rail, compact pulse, then the one-column feed. The detail view and its metric grid collapse to one column without horizontal page overflow.

## Implementation notes

`src/pulse.ts` owns the pure analysis and local-day buckets. `GET /api/pulse/topics` supplies the seven-bucket rail series; `GET /api/pulse` accepts either `topic=<id>` or `category=<slug>` plus an optional `subcategory` and `days=7|30|90`. The client fetches the compact surfaces when the archive signature or active view changes, and loads full detail only after a reader asks for it.

The pulse is intentionally derived rather than stored. Caching an aggregate would create a second source of truth that every import, clear, undo, flag, retention prune, and topic reclassification would have to invalidate.
