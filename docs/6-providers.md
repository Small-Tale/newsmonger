# 6 — AI Providers

Newsmonger checks run through a pluggable provider abstraction so you can choose which AI finds and summarizes news.

## Scope: web-searching platforms only

- **FR-6.0** Only AI platforms that perform **their own web search** are supported. Finding genuinely *new* news requires live browsing, and the app deliberately does not carry a search backend to compensate for models that can't browse. A local model would answer from its training cutoff — plausible-sounding but not actually news — so those providers are out of scope. (`mock` is a test-only provider for `--ai-test`.)

## The abstraction

- **FR-6.1** `NewsProvider` (`src/ai/types.ts`) extends `NewsService` with `name`, `model`, and `isAvailable()`. Providers are plain factory functions returning object literals (no base class), registered in `src/ai/providers/index.ts`.

- **FR-6.12** *(Shipped, NEWS-132)* **Discovery runs on a fast, cheap model** — `claude-haiku-4-5` on both Claude paths, `gpt-5-mini` on both OpenAI paths (`DISCOVERY_MODELS` in `src/ai/types.ts`). Discovery proposes topic *names* with a one-line reason; a check researches and cites stories. The lighter question gets the lighter model, at roughly a fifth the price and noticeably less latency.

  These are **defaults, not overrides**: a model the user has explicitly chosen in Settings still wins on both paths. Silently ignoring an explicit setting would be the more surprising behaviour, even in the name of speed.

  **The request shape has to vary with the model, not just the model id.** Haiku 4.5 predates two things the check request sends, and rejects both: adaptive thinking (`{type: 'adaptive'}` is 4.6+, and `effort` errors outright on 4.5-generation models) and the `web_search_20260209` tool (older models take the basic `web_search_20250305`). `usesLegacyRequestShape` lists the *exceptions* rather than enumerating current models, so a model released after this code was written gets the modern shape by default. Thinking is **omitted** on those models rather than swapped for a `budget_tokens` budget — discovery needs none, and skipping it is faster.

  Discovery also asks for **3 web searches and 4 000 output tokens** against a check's 8 and 16 000. Each search is money and several seconds; discovery needs only enough live browsing to keep the *ongoing* half of the mix current (FR-24.10).

  The body is built by an exported `messageParams()` rather than inline in the SDK runner, because a wrong answer there is a vendor 400 on every call and it is the one part of the SDK path a test can reach without a real client.

- **FR-6.11** *(Shipped, NEWS-124)* `NewsService` has **two** methods: `checkTopic` (what is new about X) and `suggestTopics` (what might you want to follow at all — see [24 — Topic Discovery](24-topic-discovery.md)). `suggestTopics` is **required rather than optional**: discovery has no "this provider can't do it" state in the design, and making it optional would push a capability check into the UI that FR-24 never describes.

  The two subscription CLIs take the JSON Schema as a **parameter** on their runner seam rather than closing over a constant, because they return different shapes through the same binary. Handing the CLI the news schema for a discovery call makes it reject a perfectly good answer, so the wiring is asserted per provider in `tests/unit/suggest-providers.test.ts`.

## Selection & config

- **FR-6.2** Provider, model, and endpoint are **persisted settings** (`Settings.provider` / `.model` / `.endpoint`), changeable at runtime from the UI's Source block (`PATCH /api/settings`) or seeded at startup by `--provider auto|anthropic|openai|mock`, `--model <id>`, `--endpoint <url>` / `NEWSMONGER_PROVIDER`, `NEWSMONGER_MODEL`, `NEWSMONGER_ENDPOINT`. `--ai-test` forces the mock provider without touching settings.
- **FR-6.3** `resolveProvider()` runs per check. For `auto` it returns the first available provider in `AUTO_ORDER` (`anthropic`, then `openai`); for an explicit choice it returns that provider if available, else throws an actionable message (e.g. "Anthropic has no API key — add one in Settings, or set ANTHROPIC_API_KEY"). If nothing is available, the check fails with a clear error rather than crashing the app. The provider that ran is recorded on the `CheckRun`.
- **FR-6.4** A stored provider that no longer exists in the schema degrades to `auto` (`z.enum(...).catch('auto')`) rather than failing the whole data file — see [4 — CLI, Server, and Storage](4-cli-server-storage.md) FR-4.9.

## Providers

| Provider | Config | Status |
|---|---|---|
| `claude-cli` | Claude Pro/Max subscription via the Claude Code CLI; no key — see [9](9-subscription-providers.md) | **Shipped** |
| `codex-cli` | ChatGPT subscription via the Codex CLI; no key — see [9](9-subscription-providers.md) | **Shipped** |
| `anthropic` | key from Settings or `ANTHROPIC_API_KEY`; default model `claude-opus-4-8` (discovery: `claude-haiku-4-5`) | **Shipped** |
| `openai` | key from Settings or `OPENAI_API_KEY`, plus `OPENAI_BASE_URL`; default model `gpt-5` (discovery: `gpt-5-mini`) | **Shipped** (live path needs a key to verify) |
| `mock` | none (`--ai-test` / `--provider mock`) | **Shipped** (tests / offline) |

### Anthropic

Claude with adaptive thinking and the `web_search_20260209` server tool (max 8 searches per check), streamed to avoid HTTP timeouts. **Discovery calls use a different model and a different request shape** — see FR-6.12.

### OpenAI

The **Responses API** with the hosted `web_search` tool (`client.responses.create({ model, instructions, input, tools: [{type:'web_search'}] })`, reading `output_text`) — the OpenAI analog of Anthropic's server tool. Result parsing reuses the shared fenced-JSON `parseNewsResult`; a strict `json_schema` output was left as a possible enhancement to avoid schema-vs-hosted-tool friction. `OPENAI_BASE_URL` (or `--endpoint`) targets an OpenAI-compatible gateway. **The live request path needs a real key to verify** — see `manual-test-plan.md`.

## Attended providers and the foreground gate

Some providers authenticate with a **personal subscription** (Claude Pro/Max, ChatGPT) rather than an API key. A check on one of those spends the user's plan quota, and a scheduler firing at 3am against someone's subscription is an unattended background agent. So those providers only run **scheduled** checks while the app is actually in front of someone.

- **FR-6.5** *(Shipped)* `NewsProvider` carries `readonly attended: boolean`. True for subscription-backed providers; false for API-key providers and `mock`, whose usage is metered and billed and so is fine to schedule unattended.
- **FR-6.6** *(Shipped)* The client posts `/api/foreground` when the page is **visible AND focused** — on load, on an interval, and on `focus`/`visibilitychange` so returning to the app takes effect immediately. A visible-but-unfocused window on a second monitor is not someone using the app.

  It's a dedicated endpoint rather than a flag inferred from the 4 s `/api/state` poll on purpose: that poll is just an HTTP request, so a stray `curl` would otherwise read as "a person is watching".
- **FR-6.7** *(Shipped)* `Attendance` (`src/attendance.ts`) holds `lastSeenAt` **in memory** — session state, not user data, and a restart genuinely should start from "nobody is watching". A check counts as attended within `ATTENDANCE_WINDOW_MS` (5 minutes) of the last signal.
- **FR-6.8** *(Shipped)* `CheckRunner.checkDue()` resolves the provider once per sweep (the provider comes from global settings, so it's the same for every topic) and returns early when the provider is `attended` and attendance has lapsed. Deferred topics are left untouched — `lastCheckedAt` does not advance and no `CheckRun` is recorded — so they stay due and run as soon as someone opens the app. A deferral is not a failure.
- **FR-6.9** *(Shipped)* **Manual checks are never gated, and they record attendance.** `checkTopic` (a topic's Check button) and `checkAll` (Check all now) always run: clicking is itself proof someone is there. They also **stamp attendance** (`manual: true`), so a scheduler tick that fires during a manual sweep isn't gated either. This matters for a long sweep on a subscription provider (minutes per topic): without it, backgrounding the app mid-sweep would defer the topics the sequential sweep hadn't yet reached, so they wouldn't refresh until you came back (NEWS-44). `checkAll` re-stamps per topic, so even a sweep longer than the 5-minute window stays "attended" throughout. Scheduled checks (`checkDue`) never stamp attendance — otherwise one would prop the gate open.
- **FR-6.10** *(Shipped)* The gate **fails closed**. A fresh `Attendance` reports "not attended", and it is the default constructor argument for `CheckRunner` — so forgetting to wire the tracker stops scheduled checks rather than silently running a subscription provider unattended.

Provider-resolution failures are deliberately *not* swallowed by the gate: if resolving throws, the sweep proceeds so `checkTopic` records the failure per topic exactly as it did before.

**Coverage note:** the gate decision is unit-tested (`tests/unit/attendance.test.ts`, including window boundaries and away→return→away sequences). E2E covers only the *client* half — that the heartbeat is sent on load and on regaining focus — because a Playwright page is always focused, so attendance can't be made stale through the browser.

The Settings model field is a **combobox** (NEWS-37): an editable text input backed by a `<datalist>` of curated per-provider suggestions (`PROVIDER_MODELS` in `src/ai/types.ts`). It stays free-text — a custom OpenAI-compatible gateway, or a model newer than the list, is still typeable — so the suggestions are discovery, not a constraint. An empty value uses the provider's own default.

- **FR-6.13** *(Shipped, NEWS-189)* **Effort is a setting** — a `<select>` in the Source block, `effort` in `Settings`, seeded by `--effort` / `NEWSMONGER_EFFORT`. Levels: `low`, `medium`, `high`, `xhigh`, `max`, plus **"Provider default"** (`''`), which is the default — so behaviour is unchanged until someone chooses.

  A **dropdown, not a slider.** The levels are named rather than numeric, and they are not evenly spaced: NEWS-19 measured `medium` and `low` at the same 72 s while `low` used ~3× the input tokens. A slider would imply a linear axis that does not exist. It also matches every other enumerated setting in the app.

  **Checks only — and that is a correctness constraint, not a preference.** Discovery runs on `claude-haiku-4-5` (`DISCOVERY_MODELS`), and Haiku 4.5 does not ignore `output_config.effort`, it **rejects** it. Carrying the setting into discovery would turn a user's preference into a 400 on every suggestion request. So effort rides on `RunOptions` and is attached to `CHECK_RUN` alone; `messageParams()` additionally refuses to emit it on any legacy-shape model, the same guard that keeps `thinking` off them.

  **Three providers take one: the Anthropic API and both CLI agents.** `providerTakesEffort` in `src/ai/types.ts` is the single list, replacing a hardcoded `provider === 'anthropic'` in the UI.

  - **Claude subscription** (NEWS-239) — `claude --effort <level>`, exactly the levels above.
  - **ChatGPT subscription** (NEWS-244) — `-c model_reasoning_effort=<level>`, not a flag. Every level above is in the set the server accepts (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), so the value passes straight through with no mapping to drift.

  This documentation said twice that the CLI providers "take no such parameter", and the note beside the control told users so. **Both times it was untrue, and both times the evidence was an absence.** For Claude the flag was sitting in `claude --help`. For Codex the help genuinely says nothing — because effort rides the generic `-c key=value` config override, so there is no flag to document. "The help doesn't mention it" was never evidence, and treating it as such cost subscription users on both platforms a setting their own tools support.

  The key name was **verified, not guessed**: with `--strict-config`, Codex accepts `model_reasoning_effort` and rejects an invented key as an "unknown configuration field". Worth knowing that **without `--strict-config` an unknown key is swallowed in silence** — the check that makes this verifiable is not the one a normal invocation performs.

  **The OpenAI API provider is the one left out**, and that is a gap rather than a decision. It has `reasoning.effort`, we do not send it, and it is a smaller gap than it looks: effort applies only to reasoning models, so unlike the two CLIs it is not unconditionally safe to send.

  The control is **disabled** rather than hidden where it does not apply, and since NEWS-239 it both *looks* disabled and states the reason on the page — a `title` tooltip on a disabled control is close to unreachable.

  Stored with `.catch('')` for the same reason `provider` has one: a level that stops being valid must degrade to "provider default", not reset the user's whole settings row.

  **Each run records the level it ran at** (NEWS-226) — `runs.effort`, beside the provider, model and token usage already there, and shown in the diagnostics bundle. It is read off the **provider object**, not off settings: a provider is constructed for the check with the settings as they were then, so that is the level the request actually carried. Reading settings at record time would report a level the run never used if someone changed the dropdown mid-sweep, which is worse than recording nothing.

  `null` and `''` mean different things and are kept apart: `null` is "not recorded" (a run from before the column existed, which the v3 → v4 migration leaves alone), `''` is "ran at the model's default". Collapsing them would make every historical run look like a default-effort data point — poisoning exactly the comparison the column exists to support.

  This is what dissolves NEWS-19's blocker: that ticket is parked waiting on budget for a formal multi-sample effort comparison, and with the level recorded per run, every ordinary check becomes a data point instead.

See also: [2 — News Checks and Deduplication](2-news-checks-and-dedup.md), [4 — CLI, Server, and Storage](4-cli-server-storage.md).

Key storage and the Settings dialog are covered in [7 — API Keys and Settings Dialog](7-api-keys.md). Providers still report token usage on each check and it is stored on the `CheckRun`, but nothing reads it: the spend estimate, the budget cap and the price table were removed in NEWS-119. The counts are kept as telemetry rather than deleted, since dropping the column would be a migration for no visible gain.
