# 6 — AI Providers

News checks run through a pluggable provider abstraction so you can choose which AI finds and summarizes news.

## Scope: web-searching platforms only

- **FR-6.0** Only AI platforms that perform **their own web search** are supported. Finding genuinely *new* news requires live browsing, and the app deliberately does not carry a search backend to compensate for models that can't browse. A local model would answer from its training cutoff — plausible-sounding but not actually news — so those providers are out of scope. (`mock` is a test-only provider for `--ai-test`.)

## The abstraction

- **FR-6.1** `NewsProvider` (`src/ai/types.ts`) extends `NewsService` with `name`, `model`, and `isAvailable()`. Providers are plain factory functions returning object literals (no base class), registered in `src/ai/providers/index.ts`.

- **FR-6.11** *(Shipped, NEWS-124)* `NewsService` has **two** methods: `checkTopic` (what is new about X) and `suggestTopics` (what might you want to follow at all — see [24 — Topic Discovery](24-topic-discovery.md)). `suggestTopics` is **required rather than optional**: discovery has no "this provider can't do it" state in the design, and making it optional would push a capability check into the UI that FR-24 never describes.

  The two subscription CLIs take the JSON Schema as a **parameter** on their runner seam rather than closing over a constant, because they return different shapes through the same binary. Handing the CLI the news schema for a discovery call makes it reject a perfectly good answer, so the wiring is asserted per provider in `tests/unit/suggest-providers.test.ts`.

## Selection & config

- **FR-6.2** Provider, model, and endpoint are **persisted settings** (`Settings.provider` / `.model` / `.endpoint`), changeable at runtime from the UI's Source block (`PATCH /api/settings`) or seeded at startup by `--provider auto|anthropic|openai|mock`, `--model <id>`, `--endpoint <url>` / `NEWS_PROVIDER`, `NEWS_MODEL`, `NEWS_ENDPOINT`. `--ai-test` forces the mock provider without touching settings.
- **FR-6.3** `resolveProvider()` runs per check. For `auto` it returns the first available provider in `AUTO_ORDER` (`anthropic`, then `openai`); for an explicit choice it returns that provider if available, else throws an actionable message (e.g. "Anthropic has no API key — add one in Settings, or set ANTHROPIC_API_KEY"). If nothing is available, the check fails with a clear error rather than crashing the app. The provider that ran is recorded on the `CheckRun`.
- **FR-6.4** A stored provider that no longer exists in the schema degrades to `auto` (`z.enum(...).catch('auto')`) rather than failing the whole data file — see [4 — CLI, Server, and Storage](4-cli-server-storage.md) FR-4.9.

## Providers

| Provider | Config | Status |
|---|---|---|
| `claude-cli` | Claude Pro/Max subscription via the Claude Code CLI; no key — see [9](9-subscription-providers.md) | **Shipped** |
| `codex-cli` | ChatGPT subscription via the Codex CLI; no key — see [9](9-subscription-providers.md) | **Shipped** |
| `anthropic` | key from Settings or `ANTHROPIC_API_KEY`; default model `claude-opus-4-8` | **Shipped** |
| `openai` | key from Settings or `OPENAI_API_KEY`, plus `OPENAI_BASE_URL`; default model `gpt-5` | **Shipped** (live path needs a key to verify) |
| `mock` | none (`--ai-test` / `--provider mock`) | **Shipped** (tests / offline) |

### Anthropic

Claude with adaptive thinking and the `web_search_20260209` server tool (max 8 searches per check), streamed to avoid HTTP timeouts.

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

See also: [2 — News Checks and Deduplication](2-news-checks-and-dedup.md), [4 — CLI, Server, and Storage](4-cli-server-storage.md).

Key storage and the Settings dialog are covered in [7 — API Keys and Settings Dialog](7-api-keys.md). Providers still report token usage on each check and it is stored on the `CheckRun`, but nothing reads it: the spend estimate, the budget cap and the price table were removed in NEWS-119. The counts are kept as telemetry rather than deleted, since dropping the column would be a migration for no visible gain.
