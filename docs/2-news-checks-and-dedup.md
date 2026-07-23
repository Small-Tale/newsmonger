# 2 — News Checks and Deduplication

How a check turns a topic name into deduplicated, summarized news items.

## Claude integration

- **FR-2.1** Checks are performed by Claude (`claude-opus-4-8`) via the Anthropic API with adaptive thinking and the `web_search_20260209` server tool (max 8 searches per check), streamed to avoid HTTP timeouts.
- **FR-2.2** The prompt includes: the topic name, the current date, the last-checked time (first checks focus on roughly the past week), and the titles of up to 60 previously reported stories with instructions not to re-report them.
- **FR-2.3** The model returns a fenced JSON block `{"items": [{title, summary, sources: [{title, url}]}]}`; an empty list means "no new news" and is a successful check. Parsing accepts the last fenced block or a bare trailing JSON object; anything else fails the check.
- **FR-2.4** Summaries are 2–4 sentences; each story carries at least one link to a news article.
- **FR-2.5** `ANTHROPIC_API_KEY` must be set for real checks; the CLI warns at startup when it's missing. `--ai-test` substitutes a deterministic mock service (used by E2E tests and offline development).
- **FR-2.6** A refusal or unparseable response fails the check; the error is recorded on the run.

## Deduplication

- **FR-2.7** Every stored item has a `dedupeKey`: the normalized URL of its first parseable source (`host+path`, lowercased, `www.` stripped, query/hash/trailing-slash dropped), falling back to the normalized title (lowercased, punctuation stripped, whitespace collapsed).
- **FR-2.8** Found stories whose key matches an already-stored item for that topic are dropped (second line of defense after the prompt-level exclusion). Duplicates within a single batch are also collapsed.
- **FR-2.9** Dedup scope is per-topic: the same story may legitimately appear under two different topics.
- **FR-2.10** If the topic is deleted while its check is in flight, the results are discarded.

See also: [1 — Topics and Scheduling](1-topics-and-scheduling.md).
