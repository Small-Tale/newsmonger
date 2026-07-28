# Retries and rate limits

What happens when a provider call fails. Related: [providers](./6-providers.md), [news checks](./2-news-checks-and-dedup.md), [cost visibility](./19-cost-visibility.md).

## What it was before (NEWS-109)

Nothing, at the check level. A failed check advanced the topic's attempt clock and recorded a failed run — so a socket hangup or a momentary 429 cost that topic a **full interval**, up to a day, of missed news. The Anthropic and OpenAI SDKs retry twice internally, which covered some of it; the `claude-cli` and `codex-cli` providers, which spawn a process, had nothing.

## Requirements

There are **two** backoffs, doing different jobs. Confusing them is the easiest mistake to make here:

| | `DEFAULT_BACKOFF` | `FAILURE_COOLDOWN` |
|---|---|---|
| Governs | retries *inside* one check | when the *scheduler* comes back |
| Cost of waiting | holds a `checkConcurrency` slot | nothing |
| Schedule | 15 s, one retry | 2 min, 4, 6 … capped at 30 min |

- **FR-23.1** *(Shipped, revised NEWS-110)* A failed provider call is retried **once**, after 15 s ±20 %, within the same check.

  It was three retries (15/30/45 s) when NEWS-109 shipped. NEWS-110 cut it to one: every second spent waiting here holds one of only `checkConcurrency` slots, and the per-topic cooldown now brings the scheduler back in about two minutes without holding anything. So this loop only has to cover the genuinely momentary blip — a single dropped socket — and anything longer is cheaper to wait out in the scheduler.

  **Linear rather than exponential** because what's being retried is a check that takes minutes and may cost money. Exponential backoff is tuned for cheap idempotent requests, where waiting is cheap and a thundering herd is the main risk; here the request is expensive and the herd is at most `checkConcurrency` wide.

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

- **FR-23.4** *(Shipped, extended NEWS-110)* A failure **does not advance the topic's attempt clock** unless it is fatal.

  `lastCheckedAt` means "we have news up to here". Moving it for a network outage claims a check happened when none did, which is what made a five-minute outage cost a whole interval of news. The three kinds diverge here:

  | Kind | Attempt clock | Held back by |
  |---|---|---|
  | `rate-limited` | not advanced | the account-wide gate (FR-23.3) |
  | `retryable` | not advanced | a per-topic cooldown (FR-23.7) |
  | `fatal` | **advanced** | the normal interval |

  Fatal keeps the old behaviour deliberately: nothing will change until a human fixes the key, so a short cooldown would only be a shorter wait for the same certain failure — and **Check now** is the route back the moment they do.

- **FR-23.5** *(Shipped)* **`Retry-After` beats the computed backoff**, in both delta-seconds and HTTP-date form. The server knows when its window resets and we are guessing. It is clamped to 240 s: a server asking for an hour is answered by failing the attempt and letting the scheduler return later, rather than holding a concurrency slot for an hour.

- **FR-23.6** *(Shipped)* `coveredThroughAt` is untouched by any of this, as before — whatever news was pending is still asked for by the next successful check, however many attempts it took.

- **FR-23.7** *(Shipped, NEWS-110)* A retryable failure sets a **per-topic cooldown** that grows with the consecutive-failure streak: 2 min, 4, 6 … capped at 30 min, ±20 %. `consecutiveFailures` and `retryAfter` are stored on the topic (schema v3); any success clears both, so a later failure starts from the bottom rather than from wherever the last streak left off.

  The cooldown **gates the schedule rather than replacing it** — once it expires the normal rules apply, so an overdue topic runs immediately. It is per-topic, so one broken feed doesn't stall the rest of a sweep, and **manual checks ignore it**: if the user asks, the outage may well be over, and they're the ones who would know.

  The floor is above the 60-second scheduler tick, or the cooldown would be indistinguishable from none. The ceiling means a provider broken for an hour is asked twice, not sixty times — both far better than the previous behaviour of waiting a full check interval.

## Testing

`tests/unit/retry.test.ts` covers the pure policy — the linear schedule, the cap, jitter bounds, classification of every kind, and `Retry-After` in both forms plus every unparseable case — and the runner behaviour: retry-then-succeed, the attempt cap, no retry on fatal, the exact wait sequence, `Retry-After` winning, the gate pausing a sweep, manual checks bypassing it, and the gate reopening.

The cooldown has its own set: the growth schedule, the floor being above the scheduler tick, a failing topic held back from the next sweep and then let through, the streak lengthening, a success clearing it, manual checks bypassing it, rate limits *not* setting one (the gate owns that, and both would compound), and one broken topic not stalling its neighbours.

`tests/unit/catch-up.test.ts` pins the divergence in FR-23.4 directly: a retryable failure leaves both clocks alone and sets a cooldown; a fatal one advances the attempt clock and sets none.

**Verified non-vacuous**, twice. Disabling the retry loop and the rate-limit gate fails exactly the six behavioural tests in NEWS-109's set and none of the policy ones. Removing the `retryAfter` check from `isDueUnderSchedule` fails the one test that asserts the cooldown is *honoured* — the others assert it is *stored*, which is a different thing and is checked by exact values.

**A note for anyone writing tests against a failing provider:** the real policy sleeps, so use `instantRetry` from `tests/helpers/provider.ts`. If the test asserts on the *gate*, use `fastRetry` instead — the gate's length is derived from the backoff, so a zeroed config produces a gate that has already expired, which looks exactly like the gate not working. `INSTANT_BACKOFF` spreads `DEFAULT_BACKOFF` so its `maxAttempts` can't drift from the real one; it was written out by hand once and went stale the moment the real cap changed.
