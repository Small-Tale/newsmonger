# 6 — AI Providers

Newsmonger checks run through a pluggable provider abstraction so you can choose which AI finds and summarizes news.

## Scope: web-searching platforms only

- **FR-6.0** *(Shipped)* Only AI platforms that perform **their own web search** are supported. Finding genuinely *new* news requires live browsing, and the app deliberately does not carry a search backend to compensate for models that can't browse. A local model would answer from its training cutoff — plausible-sounding but not actually news — so those providers are out of scope. (`mock` is a test-only provider for `--ai-test`.)

## The abstraction

- **FR-6.1** *(Shipped)* `NewsProvider` (`src/ai/types.ts`) extends `NewsService` with `name`, `model`, and `isAvailable()`. Providers are plain factory functions returning object literals (no base class), registered in `src/ai/providers/index.ts`.

- **FR-6.12** *(Shipped, NEWS-132)* **Discovery runs on a fast, cheap model** — `claude-haiku-4-5` on both Claude paths, `gpt-5-mini` on both OpenAI paths (`DISCOVERY_MODELS` in `src/ai/types.ts`). Discovery proposes topic *names* with a one-line reason; a check researches and cites stories. The lighter question gets the lighter model, at roughly a fifth the price and noticeably less latency.

  These are **defaults, not overrides**: a model the user has explicitly chosen in Settings still wins on both paths. Silently ignoring an explicit setting would be the more surprising behaviour, even in the name of speed.

  **The request shape has to vary with the model, not just the model id.** Haiku 4.5 predates two things the check request sends, and rejects both: adaptive thinking (`{type: 'adaptive'}` is 4.6+, and `effort` errors outright on 4.5-generation models) and the `web_search_20260209` tool (older models take the basic `web_search_20250305`). `usesLegacyRequestShape` lists the *exceptions* rather than enumerating current models, so a model released after this code was written gets the modern shape by default. Thinking is **omitted** on those models rather than swapped for a `budget_tokens` budget — discovery needs none, and skipping it is faster.

  Discovery also asks for **3 web searches and 4 000 output tokens** against a check's 8 and 16 000. Each search is money and several seconds; discovery needs only enough live browsing to keep the *ongoing* half of the mix current (FR-24.10).

  The body is built by an exported `messageParams()` rather than inline in the SDK runner, because a wrong answer there is a vendor 400 on every call and it is the one part of the SDK path a test can reach without a real client.

- **FR-6.11** *(Shipped, NEWS-124)* `NewsService` has **two** methods: `checkTopic` (what is new about X) and `suggestTopics` (what might you want to follow at all — see [24 — Topic Discovery](24-topic-discovery.md)). `suggestTopics` is **required rather than optional**: discovery has no "this provider can't do it" state in the design, and making it optional would push a capability check into the UI that FR-24 never describes.

  The two subscription CLIs take the JSON Schema as a **parameter** on their runner seam rather than closing over a constant, because they return different shapes through the same binary. Handing the CLI the news schema for a discovery call makes it reject a perfectly good answer, so the wiring is asserted per provider in `tests/unit/suggest-providers.test.ts`.

## Selection & config

- **FR-6.2** *(Shipped)* Provider, model, and endpoint are **persisted settings** (`Settings.provider` / `.model` / `.endpoint`), changeable at runtime from the UI's Source block (`PATCH /api/settings`) or seeded at startup by `--provider auto|anthropic|openai|mock`, `--model <id>`, `--endpoint <url>` / `NEWSMONGER_PROVIDER`, `NEWSMONGER_MODEL`, `NEWSMONGER_ENDPOINT`. `--ai-test` forces the mock provider without touching settings.
- **FR-6.3** *(Shipped)* `resolveProvider()` runs per check. For `auto` it returns the first available provider in `AUTO_ORDER` — **`claude-cli`, `codex-cli`, `anthropic`, `openai`**, subscriptions first, since someone holding a Claude subscription would expect it spent before an API key they also happen to have. (This read "`anthropic`, then `openai`", which predates the two CLI providers.) For an explicit choice it returns that provider if available, else throws an actionable message (e.g. "Anthropic has no API key — add one in Settings, or set ANTHROPIC_API_KEY"). If nothing is available, the check fails with a clear error rather than crashing the app. The provider that ran is recorded on the `CheckRun`.
- **FR-6.4** *(Shipped)* A stored provider that no longer exists in the schema degrades to `auto` (`z.enum(...).catch('auto')`) rather than failing the whole data file — see [4 — CLI, Server, and Storage](4-cli-server-storage.md) FR-4.9.

## Providers

| Provider | Config | Status |
|---|---|---|
| `claude-cli` | Claude Pro/Max subscription via the Claude Code CLI; no key — see [9](9-subscription-providers.md) | **Shipped** |
| `codex-cli` | ChatGPT subscription via the Codex CLI; no key — see [9](9-subscription-providers.md) | **Shipped** |
| `anthropic` | key from Settings or `ANTHROPIC_API_KEY`; default model `claude-opus-4-8` (discovery: `claude-haiku-4-5`) | **Shipped** |
| `openai` | key from Settings or `OPENAI_API_KEY`, plus `OPENAI_BASE_URL`; default model `gpt-5` (discovery: `gpt-5-mini`) | **Shipped** (live path needs a key to verify) |
| `mock` | none (`--ai-test` / `--provider mock`) | **Shipped** (tests / offline) |

The mock keys off the **topic name**, so a test says what it wants by naming a topic: "fail" throws, "empty" returns no stories, **"thread" returns two outlets' coverage of a single subject** (story threading is otherwise unreachable end to end, since the default pair shares only the topic's own name — see [29 — Story Threads](29-story-threads.md)), and anything else returns the same two deterministic stories every call, which is what makes dedup testable. Discovery follows the same convention off a request seed (FR-24.21).

### Anthropic

Claude with adaptive thinking and the `web_search_20260209` server tool (max 8 searches per check), streamed to avoid HTTP timeouts. **Discovery calls use a different model and a different request shape** — see FR-6.12.

### OpenAI

The **Responses API** with the hosted `web_search` tool (`client.responses.create({ model, instructions, input, tools: [{type:'web_search'}] })`, reading `output_text`) — the OpenAI analog of Anthropic's server tool. Result parsing reuses the shared fenced-JSON `parseNewsResult`; a strict `json_schema` output was left as a possible enhancement to avoid schema-vs-hosted-tool friction. `OPENAI_BASE_URL` (or `--endpoint`) targets an OpenAI-compatible gateway. **The live request path needs a real key to verify** — see `manual-test-plan.md`.

## Model suggestions

- **FR-6.14** *(Shipped, NEWS-248)* **The model picker asks the provider.** `GET /api/models` → `CheckRunner.listModels()` → the provider's optional `listModels()`, which for OpenAI is `client.models.list()`. The Settings datalist shows the answer; `PROVIDER_MODELS` in `src/ai/types.ts` survives as the **fallback** for providers that expose no catalogue and for when there is no key to ask with.

  It replaces a hardcoded array that had drifted two and a half generations: it offered `gpt-5`, `gpt-5-mini`, `o3`, `o4-mini` while the live catalogue led with `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`. This is the third time the same staleness has surfaced — NEWS-243 solved it for the Claude CLI with **aliases**, which cannot go stale because the vendor resolves them, and OpenAI has none.

  **Ranked without parsing a single model name** (`rankModels` in `src/ai/model-list.ts`). The catalogue carries a `created` timestamp per model, so newest-first is a sort on a field the vendor maintains. Every previous attempt at this problem failed by encoding knowledge of *which* models exist; this encodes none. Two filters sit in front of it: non-text families are dropped by an **exception list** (an allow-list would go stale exactly like the array it replaces, and its failure mode — a missing frontier model — is the one nobody notices, where a stray image model in a dropdown is visible and harmless), and `-YYYY-MM-DD` snapshots are dropped because the undated id already tracks the newest. Models with no timestamp sort last rather than being dropped: absent metadata is not evidence a model is bad.

  **Fetched on demand** — when the Source tab opens, or the provider or endpoint changes — never on the 4-second poll, since it costs a vendor round trip to answer a question only someone looking at the picker is asking. **Never an error**: a provider that cannot enumerate, a missing key and a vendor outage all answer `[]` and the picker falls back. A dropdown is not worth a red banner.

  **Codex enumerates too, from the machine rather than the network** (NEWS-249). Its catalogue is not OpenAI's — it serves `gpt-5.3-codex-spark`, which `/v1/models` never lists, and refuses every non-reasoning model the API serves happily — and no CLI command prints it (`--help`, `doctor`, `features` all silent; an invalid `-m` names no alternatives). But `~/.codex/models_cache.json` is what the TUI's own picker reads, refreshed against the user's account, so `readCodexModels` reads that: `visibility: hide` entries are skipped (`codex-auto-review` is internal and would otherwise sort third), and Codex's own `priority` decides the order so the app agrees with the tool instead of holding a second opinion. `CODEX_HOME` is honoured. Any unexpected shape yields no models rather than an error — it is another tool's file and may change without notice.

  **The Claude CLI keeps its aliases**, and that is not an omission. There is no machine-local catalogue: no `models` command, nothing under `~/.claude`, `doctor` silent, and an invalid `--model` reports only that the model is unknown. Aliases (`opus`, `sonnet`, `haiku`, `fable`) reach the same goal by another route — the vendor resolves them, so they cannot go stale (NEWS-243).

  **Anthropic enumerates too** (NEWS-251), through the same seam: `client.models.list()`, with two differences worth naming. Its `created_at` is an RFC 3339 **string** where OpenAI uses epoch seconds, so it is converted at the edge rather than teaching `rankModels` about two formats — the ranking stays vendor-agnostic, which is the property that makes it immune to model naming. And each entry carries **`capabilities.effort`**, so the per-model effort narrowing of FR-6.13a is answered from the catalogue here as it is from the cache on Codex: `claude-haiku-4-5` reports `effort.supported: false`, which is the same fact FR-6.12 already relies on. Both questions share one memoised fetch per provider instance, since `/api/models` asks them together.

  Its fixture is **derived from the SDK's type declarations rather than captured**, because there is no Anthropic key on the development machine — a better source than memory, and weaker than a real payload. The tests say which, so nobody reads them as proof the wire matches the spec.

- **FR-6.15** *(Shipped, NEWS-253)* **The model field is a `<select>`, and what it holds is always something the provider has.** It offers the live catalogue (FR-6.14), falling back to `PROVIDER_MODELS` when there is no key to ask with, and it **corrects itself**: switching provider replaces a model that belongs to the one being left.

  `src/client/model-choice.ts` holds the rules, pure and unit-tested:

  - **Nothing chosen gets filled in**, from the live catalogue or the static fallback. `''` ("provider default") is storable but *not representable* in a dropdown — leaving it would make the control display its first option while the setting said something else, which is a control lying about what is stored and precisely what NEWS-238 turned out to be.
  - **Another vendor's model is replaced, catalogue or no catalogue** *(NEWS-278)*. See below — this rule is the exception to the next one, and it exists because the next one had a hole.
  - **Otherwise a real choice is only overruled against a *live* catalogue.** The fallback is four entries and could never contain a gateway's own model id, so correcting against it would clobber exactly the setting free text existed for. No live list means no opinion.
  - **A valid choice is never touched.** Switching provider is not consent to change a model that still works.

  **The hole the live-catalogue rule left** *(NEWS-278)*. Switching *ChatGPT (Codex) → Claude subscription* left `gpt-5.4-mini` selected, and listed above `opus`/`sonnet`/`haiku`/`fable`. Not a bug in that rule so much as a consequence of it: **Claude Code publishes no catalogue at all**, deliberately, because it takes aliases the vendor resolves (FR-6.14, NEWS-243). So there was nothing live to judge against, the cautious branch fired, and the setting was left as it was. Every check afterwards would have failed.

  No catalogue is needed to know a GPT model will not run on a Claude subscription. The new rule asks a different question — **which vendor is this?** — and `claude-cli`/`anthropic` are two routes to Anthropic just as `codex-cli`/`openai` are two routes to OpenAI. Three guards keep it from becoming the over-helpful correction the third rule forbids:

  - It fires only when **another provider's own list names the model**, so an id nobody lists is still nobody's business. That is the gateway escape hatch, untouched.
  - It never fires **within a vendor**. `claude --model` takes a full name as well as an alias, so an Anthropic API model is a valid choice on the subscription, and correcting it would destroy a setting that works.
  - It never fires for an **endpoint-configurable** provider. A base URL can serve anything, including a model listed under another vendor here — which is the exact case the cautious rule exists for, so OpenAI keeps it.
  - Correction runs only where a person can see it — after a provider change, and when the Source tab opens. Applying it in the background would change which model someone's checks use without them touching anything.

  **The default is the small model**: the most recent Haiku on the Claude paths, the mini on the OpenAI ones. Matched on a *family* token rather than a version, so unlike the hardcoded `claude-opus-4-8` of NEWS-243 it cannot go stale — `haiku` follows whatever the newest Haiku is — and it falls back to the newest model when nothing matches, so an unfamiliar catalogue still yields a usable answer. This deliberately reintroduces name matching that NEWS-243/248 removed; the difference is that *"the Haiku one"* has no definition other than its name, where *"the newest model"* had one.

  **Two consequences worth stating rather than discovering.** Checks now default to the small model, where `DISCOVERY_MODELS` previously routed only *discovery* there — a real quality and cost trade, in that direction on purpose. And `claude-haiku-4-5` reports `effort.supported: false`, so defaulting Anthropic to Haiku means **effort is off by default on Claude**.

  **What this takes away:** free text. FR-6.14's escape hatch for OpenAI-compatible gateways is gone. A stored model the catalogue does not list stays selectable and selected, so no existing setting is destroyed by opening Settings — but once changed away from, it cannot be typed back.

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

  **Every provider takes one** except the test-only `mock`. `providerTakesEffort` in `src/ai/types.ts` is the single list, replacing a hardcoded `provider === 'anthropic'` in the UI.

  - **Claude subscription** (NEWS-239) — `claude --effort <level>`, exactly the levels above.
  - **ChatGPT subscription** (NEWS-244) — `-c model_reasoning_effort=<level>`, not a flag. Every level above is in the set the server accepts (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), so the value passes straight through with no mapping to drift.
  - **OpenAI API** (NEWS-245) — `reasoning.effort` on the Responses API. The awkward one: effort applies only to *reasoning* models, and unlike the CLIs this provider accepts any model id and can point at a gateway through `OPENAI_BASE_URL`, so nothing here can know whether a given model qualifies. It **sends the level, and if the API rejects the request for that reason, retries once without it and remembers the model** — one wasted request rather than one per check. Deliberately not a list of reasoning-model prefixes: a list of members goes stale the moment a family ships and fails in the direction hardest to notice (the new model silently doesn't get the effort asked for), which is the same shape as the stale model list corrected in NEWS-243. The rejection test is narrow — a 400 that says nothing about reasoning is a real error, and retrying those would double every failing request.
  - **`auto`** is enabled because `AUTO_ORDER` and this list now coincide, which is a fact about today rather than a principle; `tests/unit/effort.test.ts` pins the relationship so adding a non-effort provider to `AUTO_ORDER` fails a test instead of leaving the control lying about what a check will do.

  This documentation said twice that the CLI providers "take no such parameter", and the note beside the control told users so. **Both times it was untrue, and every time the evidence was an *absence*.** For Claude the flag was sitting in `claude --help`. For Codex the help genuinely says nothing — because effort rides the generic `-c key=value` config override, so there is no flag to document. For OpenAI the absence was our own missing wiring. "The help doesn't mention it" was never evidence.

  The Codex key name was **verified, not guessed**: with `--strict-config`, Codex accepts `model_reasoning_effort` and rejects an invented key as an "unknown configuration field". Worth knowing that **without `--strict-config` an unknown key is swallowed in silence** — the check that makes this verifiable is not the one a normal invocation performs. **Verified against the live API**, not assumed. The refusal is a `400` with `param: "reasoning.effort"`, `code: "unsupported_parameter"`, message *"Unsupported parameter: 'reasoning.effort' is not supported with this model."* — and a control request without the parameter succeeded on the same key and model, so that is the parameter being refused rather than the model being unavailable. The negative case is pinned to a real unrelated `400` (`param: "max_output_tokens"`), which the match correctly ignores. The whole path was exercised end to end: a real check with `effort: 'high'` against `gpt-4o` returned two stories by falling back. Before a key was available this was written from a guess and the guess happened to be right — the tests now hold the evidence rather than the assumption.

  The control is **disabled** rather than hidden where it does not apply, and since NEWS-239 it both *looks* disabled and states the reason on the page — a `title` tooltip on a disabled control is close to unreachable.

- **FR-6.13a** *(Shipped, NEWS-250)* **The levels offered narrow with the model, not just the provider.** `EFFORT_LEVELS` is now the cross-provider **superset** — `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` — and `PROVIDER_EFFORT_LEVELS` plus the provider's `effortLevelsFor(model)` decide the menu. `/api/models` returns both the model list and the levels for the configured model; the Settings control renders those.

  Not cosmetic. Asking Codex for a level the chosen model refuses **fails the check**:

  ```
  400 unsupported_value  param "reasoning.effort"
  "Unsupported value: 'max' is not supported with the 'gpt-5.4-…' model.
   Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'."
  ```

  Every set is the vendor's own statement, not ours: `claude --help` for the Claude CLI; the **SDK type declarations** for Anthropic (`effort?: 'low'|'medium'|'high'|'xhigh'|'max'`, under the comment *"All possible effort levels"*) and OpenAI (`ReasoningEffort`, matching word for word what the live API named in a 400); and `~/.codex/models_cache.json` per model for Codex. The Anthropic set had been carried on inherited habit — the SDK's types turned out to confirm it exactly, which is the verification a missing key had seemed to rule out.

  **`ultra` is Codex-only**, which is why a single global list was the wrong fix: adding it would have offered a level to three providers whose own types exclude it. Each request builder now **drops** a level its API does not declare rather than sending it, so switching provider with `ultra` saved runs at the model's default instead of failing.

  A level the model refuses but the user has **saved** stays visible in the menu, labelled unsupported. Hiding it would leave the `<select>` showing a value absent from its own options — the control misreporting what is stored, the exact class of bug NEWS-238 was — and silently rewriting the setting to tidy the menu would be worse, since switching model is not consent to change it.

  When the server cannot ask — no key, or a provider that cannot say — **every** level is offered. A control greying out all its options because a lookup failed is worse than one offering too much.

  **Tightened in NEWS-254.** The menu now contains **only levels the chosen model accepts**, and the control is **disabled when the model accepts none** — `claude-haiku-4-5` reports `capabilities.effort.supported: false` and rejects the parameter outright (FR-6.12), which enablement keyed off the *provider* could not express.

  That reverses a deliberate NEWS-250 decision — an unsupported *saved* level used to stay listed and labelled, on the grounds that hiding it would leave the `<select>` showing a value absent from its own options. The tension dissolves because the value no longer *stays* invalid: `correctedEffort` moves it to "provider default" as soon as the model changes. **The correction is the point, not the hiding** — narrowing the menu while settings still held an unsupported level would trade a visible oddity for an invisible failure, since the next check would send it and get a `400`.

  It falls back to `''` rather than a guessed equivalent: there is no honest mapping from `ultra` on Codex to anything on Anthropic, and silently substituting a *different* amount of thinking is a worse liberty than declining to choose.

  **`effortLevels` on `/api/models` has three states**, and keeping them apart is most of the work. A list is what to offer; `null` is *could not ask*, so everything is offered rather than greying out over a lookup failure; `[]` is *this model takes none*. They were one value before, which is exactly how the menu came to offer every level on a model that takes none. An empty entry in the static `PROVIDER_EFFORT_LEVELS` table is **not** the third case — that table has nothing to say about `mock`, rather than reporting a refusal — so an empty union stays `null`.

  Stored with `.catch('')` for the same reason `provider` has one: a level that stops being valid must degrade to "provider default", not reset the user's whole settings row.

  **Each run records the level it ran at** (NEWS-226) — `runs.effort`, beside the provider, model and token usage already there, and shown in the diagnostics bundle. It is read off the **provider object**, not off settings: a provider is constructed for the check with the settings as they were then, so that is the level the request actually carried. Reading settings at record time would report a level the run never used if someone changed the dropdown mid-sweep, which is worse than recording nothing.

  `null` and `''` mean different things and are kept apart: `null` is "not recorded" (a run from before the column existed, which the v3 → v4 migration leaves alone), `''` is "ran at the model's default". Collapsing them would make every historical run look like a default-effort data point — poisoning exactly the comparison the column exists to support.

  This is what dissolves NEWS-19's blocker: that ticket is parked waiting on budget for a formal multi-sample effort comparison, and with the level recorded per run, every ordinary check becomes a data point instead.

- **FR-6.16** *(Shipped, NEWS-227)* **An effort comparison** in Settings → App → Diagnostics: median duration and median tokens per level, fastest first. `effortComparison` in `src/client/effort-stats.ts`.

  Held back twice on purpose — a comparison over a handful of runs is noise presented as evidence — and built once the data arrived: a live database showed **24 succeeded runs at the model default (median 61.5s) against 23 at `low` (76.5s)**, which is a comparison worth reading. It is the answer NEWS-19 was parked waiting for.

  Four rules, each of which would otherwise make the table lie:

  - **Median, not mean.** The same real data gives means of 75s and 87s against medians of 61.5s and 76.5s — check durations have a long tail (a stall, a retry, a topic that searched twelve sources) and one outlier is enough to invert a ranking.
  - **`effort === null` runs are dropped**, not folded into `''`. Null is "not recorded"; in that same database 124 of 237 runs are null, so folding them would drown the comparison in pre-NEWS-226 history.
  - **Only succeeded runs count.** A check that failed after four seconds is not evidence that a level is fast, and a level that fails often would otherwise look like the quickest.
  - **Tokens read "not reported" rather than 0** when no run at a level reported any. Both subscription CLIs return `usage: null` because they genuinely cannot report counts, so on a subscription-only install *every* run lands there — and a confident `0 tokens` beside a real duration would be a measurement the app never made. This is the same null-is-not-zero rule `CheckRunSchema` already states, applied to a reader-facing figure.

  **Silent below two levels**, with a note naming the control to change and where it lives. One level is a number with no second number to read it against, and rendering one bar is exactly the "looks broken on first open" outcome the ticket was held back to avoid.

  **Tokens only, no money** — consistent with NEWS-119, which removed the spend estimate, the budget cap and the price table. Reintroducing a currency figure here would partly reverse that decision, so the counts are shown and the reader can price them.

  Only the empty state is reachable in E2E: the mock provider hardcodes `effort: ''`, so every run under `--ai-test` lands on one level. The populated table rests on twelve unit tests plus the real-database check above; seeding demo runs at two levels is filed as a follow-up.

See also: [2 — News Checks and Deduplication](2-news-checks-and-dedup.md), [4 — CLI, Server, and Storage](4-cli-server-storage.md).

Key storage and the Settings dialog are covered in [7 — API Keys and Settings Dialog](7-api-keys.md). Providers still report token usage on each check and it is stored on the `CheckRun`, but nothing reads it: the spend estimate, the budget cap and the price table were removed in NEWS-119. The counts are kept as telemetry rather than deleted, since dropping the column would be a migration for no visible gain.
