# 39 — Evidence-Linked Story Thread Briefs

Thread briefs are the first model-assisted analysis over Newsmonger’s stored archive. They sit inside an existing multi-story thread and orient the reader without replacing the underlying timeline.

Related: [Story threads](29-story-threads.md), [AI providers](6-providers.md), and [UI](3-ui.md).

## Requirements

- **FR-39.1** *(Shipped, NEWS-454)* A multi-story thread offers an explicit **Generate thread brief** action. A single-story thread offers no analysis action.
- **FR-39.2** *(Shipped, NEWS-454)* The brief answers three separate questions: what changed, what is consistent across reports, and what remains disputed or unknown. A section with no supported claim says so rather than inventing filler.
- **FR-39.3** *(Shipped, NEWS-454)* Every claim cites at least one stored story id, and every citation displayed to the reader is a clickable link to that story’s primary stored source. A provider response citing an unknown id is rejected in full.
- **FR-39.4** *(Shipped, NEWS-454)* Each claim labels its support as independent reporting, repeated coverage, or unclear independence. Repeated/syndicated wording is never presented as source consensus.
- **FR-39.5** *(Shipped, NEWS-454)* The brief shows generation time, number of input stories, and an explicit low/medium/high uncertainty state.
- **FR-39.6** *(Shipped, NEWS-454)* Generation is on demand, never during feed rendering or ordinary thread expansion. The model receives only the stored thread stories and is instructed not to browse or use outside knowledge.
- **FR-39.7** *(Shipped, NEWS-454)* A successful brief is cached for the process lifetime by an exact fingerprint of story ids, titles, and summaries. Reopening or requesting an unchanged thread reuses it; thread growth or changed evidence produces a new fingerprint and recomputes. Failures are not cached.
- **FR-39.8** *(Shipped, NEWS-454)* Provider output is schema-validated at the provider boundary. Claims require non-empty text, at least one source id, a support classification, and a valid uncertainty state; model markup is stripped.
- **FR-39.9** *(Shipped, NEWS-454)* All configured providers expose the analysis operation. Subscription CLIs receive the strict JSON schema; API providers use the same prompt and validator; the test/demo providers return deterministic evidence-linked fixtures.
- **FR-39.10** *(Shipped, NEWS-454)* A failed generation stays local to the expanded story pane and offers retry. It does not replace the feed or appear as a page-wide check failure.

## Schema and cache design

`POST /api/items/:id/thread-brief` resolves the item’s complete unflagged thread and rejects unknown or single-story subjects. Its response contains `changed`, `consistent`, `unknown`, `uncertainty`, `generatedAt`, and `storyCount`. Every claim is `{ text, sourceIds, support }`.

The cache is deliberately derived and process-local. Its key contains every input id/title/summary, so growth invalidates without a separate invalidation path; source links are resolved from the freshly loaded thread at render time. Durable storage would require invalidation across clear, import, retention, flagging, and future thread regrouping before it bought user-visible value, so it is deferred until measured demand justifies that second source of truth.

