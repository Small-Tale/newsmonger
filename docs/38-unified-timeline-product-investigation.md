# 38 — Unified Timeline Product Investigation

Status: investigation only (NEWS-456). This is an adjacent-product concept, not a Newsmonger requirement or implementation plan.

## Recommendation

There is a credible product here, but **“one inbox for everything” is the wrong center of gravity**. Existing source apps will remain better at full-fidelity reading and writing. The differentiated product should be an **attention reader**: one calm timeline that normalizes incoming items, groups repetition, surfaces changes and patterns, and deep-links to the source app. Limited actions can follow only where confidence and provider semantics are strong.

Proceed with a narrow, read-only prototype built around RSS/Atom plus one email account. Do not begin with SMS or broad chat coverage. The prototype should prove that cross-source organization and derived lenses save meaningful reading time before paying the privacy, permission, and reply-safety costs of a universal communications client.

## Promising source types

| Source | Value | First useful enrichments | Integration difficulty | Recommendation |
| --- | --- | --- | --- | --- |
| RSS/Atom, newsletters, news alerts | High-volume reading with links and recurring publishers | duplicate collapse, topic grouping, edition comparison, quiet/active cadence | Low | **Start here** |
| Email | Mixes correspondence, receipts, alerts, newsletters, and machine reports | reply-needed queue, status timelines, shipment/renewal tracking, repeated-template extraction | Medium–high | **Prototype read-only**; JMAP where available, provider APIs/IMAP otherwise |
| Calendars | Strong time and identity structure | prep packets, changed-event summaries, relevant-message linking | Medium | Add after the timeline model works |
| GitHub/GitLab, issue trackers, CI and monitoring | Structured events with obvious state transitions | incident/release timelines, blocked-work summaries, regression and ownership patterns | Medium | Excellent early plugin family |
| Team chat (Slack, Teams, Matrix) | High value but high volume and context-sensitive | catch-up briefs, decision/commitment extraction, unanswered mentions | High | Later, workspace-scoped and read-only first |
| Social/fediverse | Natural timeline shape | duplicate-link collapse, topic clustering, source diversity | Medium and policy-dependent | Start with open feeds/APIs such as ActivityPub/Mastodon, not brittle scraping |
| SMS and consumer messaging | Personally important | follow-up reminders, plans and commitments | Very high privacy, platform, and E2EE constraints | **Defer** |
| Local notifications, files, notes, browser history | Useful ambient context | “what changed,” project packets, resurfacing | High noise and permission sensitivity | Opt-in experiments only |

Open protocols make parts of this feasible: JMAP Mail defines efficient query, organization, submission, push, and resynchronization; Matrix exposes timeline events through cursor-like `/sync`; ActivityPub defines inbox/outbox activity streams; and Mastodon exposes timeline APIs. These are useful connector shapes, not evidence that providers share semantics. See [JMAP Mail (RFC 8621)](https://www.rfc-editor.org/rfc/rfc8621), [Matrix Client-Server `/sync`](https://spec.matrix.org/v1.12/client-server-api/#get_matrixclientv3sync), [ActivityPub](https://www.w3.org/TR/activitypub/), and [Mastodon timelines](https://docs.joinmastodon.org/methods/timelines/).

## Product experiences worth testing

1. **Pattern lenses.** Detect recurring machine-generated families, then offer a purpose-built view only after enough examples exist. A status-report series can become a green/red timeline; receipts can become a spend/renewal series; shipment mail can become a delivery tracker. The offer must show the examples that caused it and let the user dismiss or correct the pattern.
2. **Change-first reading.** Collapse syndicated or repeated content and show what changed since the previous item. Preserve every original and its source link.
3. **Cross-source threads.** Bring a calendar change, an email thread, an issue update, and a monitoring alert into one project or incident thread without pretending they are the same item.
4. **Attention queues.** Separate “read,” “reply,” “decide,” “deadline,” and “FYI,” with confidence and a route back to the source. Never auto-send.
5. **Personal digests.** Summarize developments across followed topics and active conversations, distinguishing new evidence from repeated distribution.
6. **Anomaly and cadence views.** Surface missing expected reports, unusual volume, a status flip, or a dormant thread becoming active. Deterministic baselines should drive detection; a model may explain the evidence.

## Architecture direction

Use an append-oriented **source event envelope** plus a normalized projection. Keep the raw provider payload encrypted and access-controlled so normalization can be corrected without refetching. The normalized item should include:

- stable connector/account/external ids and a revision id;
- source type, canonical URL/deep link, provider timestamps, received timestamp, and deletion/tombstone state;
- actors, conversation/thread key, title/summary/body references, attachments, and structured facets;
- capabilities (`can_reply`, `can_archive`, `can_mark_read`, and similar) rather than assuming every item supports email actions;
- provenance for every extracted field or enrichment, including algorithm/model version and source item ids;
- per-source and per-item visibility labels that propagate into every aggregate.

Each connector should implement `initialSync`, cursor-based `syncChanges`, optional webhook wake-up, `hydrate`, and explicitly advertised actions. JMAP and Matrix both demonstrate why cursors/deltas belong in the base contract. At-least-once ingestion plus idempotent external ids is safer than assuming exactly-once delivery.

Enrichment should be a versioned pipeline, not connector code: deterministic parsing and template fingerprints first; embeddings/entity extraction second; model explanation last. Derived artifacts should carry input ids and versions so a changed or deleted source item invalidates only affected results. This is the same principle behind Newsmonger’s deterministic pulse, generalized to heterogeneous data.

## Non-negotiable safeguards

- **Context boundaries:** personal mail, work chat, and public feeds must not silently enrich one another. Cross-source analysis requires an explicit workspace or collection boundary.
- **Provenance:** every claim, pattern, and status point opens the contributing source items. “Why am I seeing this?” is part of the feature, not help text.
- **Prompt-injection resistance:** imported content is untrusted data, never instructions. Connector actions cannot be exposed to an analysis model by default.
- **Deletion and retention:** source deletions/tombstones must remove derived search and enrichment data. Users need per-connector retention controls and a local wipe.
- **Reply safety:** start read-only. Later replies require visible destination, account, recipients, quoted context, and an explicit final send action in the source app or a tightly scoped composer.
- **Encryption reality:** do not claim support for end-to-end encrypted sources unless decryption and indexing happen on a trusted user device with clear consequences.
- **Honest ranking:** distinguish a user rule, deterministic detector, and model inference. Confidence must not masquerade as priority.

## Prototype and go/no-go

Build a local-first prototype for 8–12 participants using RSS/Atom and read-only email over four weeks. Seed three lenses: newsletter/link deduplication, recurring status-report timelines, and reply-needed suggestions. Measure against ordinary source-app usage.

Proceed only if all of these hold:

- at least 70% of active participants use a derived lens weekly after week two;
- median self-reported useful-reading time improves by at least 20% on included sources;
- at least 85% of suggested groupings/status extractions are accepted without correction, with no high-severity cross-context disclosure;
- at least 90% of surfaced claims/pattern points have a source the participant judges directly relevant;
- fewer than 5% of “reply needed” suggestions are dangerously wrong (wrong account/context/recipient implication), and no reply is sent automatically;
- incremental sync and recomputation remain bounded to changed items, with a warm update completing in under five seconds for a 50,000-item local corpus on target hardware.

No-go or narrow the product to a specialist reader if participants mostly open the original apps, cross-source groupings require frequent repair, permission concerns suppress connector adoption, or the value comes only from generic summaries rather than repeatable derived lenses.

## Concrete next steps

1. Specify and test the canonical event envelope, connector capability contract, revisions/tombstones, provenance, and visibility propagation.
2. Build a disposable read-only vertical slice for RSS/Atom plus one mail path, with local storage, cursor sync, source deep links, and no sending.
3. Prototype the recurring-report/status lens with deterministic template grouping, user confirmation, correction, and an evidence-linked timeline.
4. Threat-model cross-context analysis, local encryption, OAuth/token storage, prompt injection, deletion propagation, exports, and telemetry before recruiting participants.

