# Retries and rate limits

What happens when a provider call fails. Related: [providers](./6-providers.md), [news checks](./2-news-checks-and-dedup.md), [cost visibility](./19-cost-visibility.md).

## What it was before (NEWS-109)

Nothing, at the check level. A failed check advanced the topic's attempt clock and recorded a failed run — so a socket hangup or a momentary 429 cost that topic a **full interval**, up to a day, of missed news. The Anthropic and OpenAI SDKs retry twice internally, which covered some of it; the `claude-cli` and `codex-cli` providers, which spawn a process, had nothing.

## Requirements

- **FR-23.1** *(Shipped)* A failed provider call is retried with **linear, jittered backoff**: 15 s, then 30 s, then 45 s, ±20 %, capped at 240 s. Four attempts in total.

  **Linear rather than exponential** because what's being retried is a check that takes minutes and may cost money. Exponential backoff is tuned for cheap idempotent requests, where waiting is cheap and a thundering herd is the main risk; here the request is expensive and the herd is at most `checkConcurrency` wide.

  **Four attempts, not sixteen.** Walking 15 s → 240 s in 15 s steps would hold a check open for over half an hour, occupying one of only `checkConcurrency` slots the whole time. Three retries bound the extra wait at ~90 s. A failure that outlives that is handled by FR-23.4 instead.

  Jitter is ± a fraction of the delay so that checks which failed together — a whole sweep hitting the same outage — don't come back in lockstep.

- **FR-23.2** *(Shipped)* Failures are **classified**, and only some are retried:

  | Kind | Examples | Behaviour |
  |---|---|---|
  | `rate-limited` | HTTP 429; "rate limit", "overloaded", "quota" in the message | Retried, and trips the global gate (FR-23.3) |
  | `retryable` | 408, 409, 5xx, socket hangups, **anything unrecognised** | Retried |
  | `fatal` | 401, 403, 404, other 4xx; "invalid api key" | **Not** retried |

  A fatal failure fails identically however often it is asked, so retrying only delays the report the user needs — and repeatedly presenting bad credentials is its own kind of rude.

  **Unrecognised failures are retried**, deliberately. An unknown error is more often a blip than a permanent misconfiguration; not retrying costs a whole interval of news, while retrying costs ninety seconds. The SDK errors carry a numeric `status`; the CLI providers throw whatever the process printed, so those are matched on text.

- **FR-23.3** *(Shipped)* A rate-limit response **pauses every scheduled check** until the window is expected to reopen, not just the topic that hit it.

  Rate limiting is a condition of the account, not of a topic. Without a shared gate, a sweep of twenty topics answers one 429 by making twenty more requests — precisely what the limit is asking us to stop doing.

  **Manual checks ignore the gate.** The user asked, and a single request is how you find out whether the window has reopened.

- **FR-23.4** *(Shipped)* A rate-limited check **does not advance the topic's attempt clock**, unlike every other failure.

  Throttling is temporary and has nothing to do with the topic. Advancing the clock for it would convert a few seconds of throttling into a full interval of missed news — the exact failure this work exists to prevent. Leaving the clock alone makes the topic due again immediately; the gate in FR-23.3 is what stops that becoming a hot loop.

  Other failures still advance it, so a genuinely broken provider isn't hammered every tick. See [Known gap](#known-gap).

- **FR-23.5** *(Shipped)* **`Retry-After` beats the computed backoff**, in both delta-seconds and HTTP-date form. The server knows when its window resets and we are guessing. It is clamped to 240 s: a server asking for an hour is answered by failing the attempt and letting the scheduler return later, rather than holding a concurrency slot for an hour.

- **FR-23.6** *(Shipped)* `coveredThroughAt` is untouched by any of this, as before — whatever news was pending is still asked for by the next successful check, however many attempts it took.

## Known gap

A **non-rate-limit** failure that survives all four attempts still advances the attempt clock, so the topic waits a full interval. For a five-minute network outage that means up to a day of missed news for that topic.

Fixing it properly needs a per-topic cooldown — a stored `consecutiveFailures` and a `retryAfter` the due-check honours — so the topic can come back in minutes without being retried every 60-second tick. That is a schema change and is deliberately out of scope here; the rate-limit case, which is both more common and more clearly temporary, is handled. Tracked separately.

## Testing

`tests/unit/retry.test.ts` covers the pure policy (linear schedule, cap, jitter bounds, classification of every kind, `Retry-After` in both forms plus every unparseable case) and the runner behaviour (retry-then-succeed, the attempt cap, no retry on fatal, the exact wait sequence, `Retry-After` winning, the gate pausing a sweep, manual checks bypassing it, and the gate reopening).

Verified non-vacuous: reducing the loop to a single attempt and disabling the gate fails exactly the six behavioural tests and none of the policy ones.

**A note for anyone writing tests against a failing provider:** the real policy sleeps, so use `instantRetry` from `tests/helpers/provider.ts`. If the test asserts on the *gate*, use `fastRetry` instead — the gate's length is derived from the backoff, so a zeroed config produces a gate that has already expired, which looks exactly like the gate not working.
