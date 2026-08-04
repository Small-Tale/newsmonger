# 9 — Subscription Providers

Run checks against a personal Claude subscription instead of a metered API key, by driving the tool that already holds those credentials.

See also: [6 — AI Providers](6-providers.md), [7 — API Keys](7-api-keys.md).

## Status: both shipped

## Why a CLI and not the API

- **FR-9.1** There is **no public OAuth flow** letting a third-party app spend someone's Pro/Max quota against `api.anthropic.com` — that endpoint wants an API key. But the Claude Code CLI already holds subscription credentials (`~/.claude/.credentials.json`, under `claudeAiOauth`), so invoking it inherits them. Verified working with no `ANTHROPIC_API_KEY` present at all.

- **FR-9.2** *(Rejected: the Agent SDK)* `@anthropic-ai/claude-agent-sdk` also works with subscription auth — confirmed, including with the global `claude` removed from `PATH`. It was rejected on size: it vendors **its own 243 MB copy of Claude Code** as a platform-specific optional dependency (298 MB of `node_modules`). `Newsmonger.app` is ~156 MB, so it would roughly triple the desktop bundle to avoid one `spawn`. If its typed streaming API is ever wanted, `query({ pathToClaudeCodeExecutable })` points it at the user's install and skips the vendored binary.

## The `claude-cli` provider

- **FR-9.3** *(Shipped)* Invocation:

  ```
  claude -p "<buildUserPrompt(…)>" \
    --append-system-prompt "<searchingSystemPrompt()>" \
    --allowed-tools WebSearch \
    --output-format json \
    --json-schema "<NEWS_JSON_SCHEMA>"
  ```

  It uses the **shared** prompt builders, so dedup instructions, the catch-up window wording, and the digest-size bound all apply identically to every provider.

- **FR-9.4** *(Shipped)* `--allowed-tools WebSearch` and nothing else. Claude Code can read and write files and run commands; a news lookup has no business doing any of that, so the tool set is narrowed to exactly what the job needs.

- **FR-9.5** *(Shipped)* `--json-schema` takes `NEWS_JSON_SCHEMA` directly, so the CLI returns a **validated object** in `structured_output`. That's preferred over re-parsing prose from `result`, which is only the fallback. On this path JSON compliance is structural rather than requested.

- **FR-9.6** *(Shipped)* `isAvailable()` is two cheap local checks: the binary answers `--version`, **and** `~/.claude/.credentials.json` contains a `claudeAiOauth.accessToken`. Only the *shape* is inspected, never the token value. A probe request would have been the obvious alternative, but it would spend subscription quota just to answer "are you signed in".

- **FR-9.7** *(Shipped)* `attended: true`, so the foreground gate in [6 — AI Providers](6-providers.md) applies automatically: **scheduled** checks run only while the app is open; manual checks always run. This is the mechanism that keeps subscription use user-attended rather than an unattended background agent.

- **FR-9.8** *(Shipped)* A check gets a 10-minute timeout. Claude Code is an agentic loop, not a single request — a measured run took 161 s across 21 turns.

## Ordering and presentation

- **FR-9.9** *(Shipped)* `AUTO_ORDER` is `claude-cli` → `anthropic` → `openai`. **Subscription first by design**: someone holding a subscription expects its quota spent before an API key they also happen to have configured.

- **FR-9.10** *(Shipped)* The provider has **no key row** in Settings — there is no key. Selecting it shows a note explaining that checks use the subscription and that scheduled checks run only while Newsmonger is open. Provider labels were clarified to match: "Claude subscription (Claude Code)" vs "Anthropic API key".

- **FR-9.11** *(Shipped)* The startup warning now probes the way a check does, rather than only looking for API keys — otherwise a signed-in subscriber with no key was told at startup that they had none.

## On cost figures

Claude Code reports `total_cost_usd` (a measured run: $1.35 across 21 turns). For a subscriber **that is an estimate of equivalent API cost, not money charged** — no per-token billing happens. The real constraint is plan rate limits, so treat the turn count as a rate-limit signal and don't present these numbers to users as a price.

## The `codex-cli` provider

- **FR-9.12** *(Shipped)* The OpenAI-side counterpart, on the same reasoning: `~/.codex/auth.json` reports `auth_mode: "chatgpt"` with `OPENAI_API_KEY: null`, so the CLI already holds subscription credentials.

  ```
  codex exec -c tools.web_search=true --skip-git-repo-check -s read-only \
    --output-schema <temp file> --output-last-message <temp file> "<prompt>"
  ```

- **FR-9.12a** *(Shipped, fixed in NEWS-272)* **Web search rides `-c tools.web_search=true`, because `--search` was removed from the CLI.**

  Every check on a ChatGPT subscription failed with `Codex CLI exited with code 2: codex exec [OPTIONS] <COMMAND> [ARGS]` — codex's usage text, meaning it rejected our argv. `codex exec --help` on 0.145.0 mentions "search" nowhere; `--search` is simply gone. Everything else we pass (`-s`, `--skip-git-repo-check`, `--output-schema`, `--output-last-message`) still exists.

  The replacement was verified the same way NEWS-244 settled the effort key rather than guessed at. With `--strict-config`, `tools.web_search` is accepted and `tools.totally_made_up` is rejected as an unknown configuration field — and since *both* `tools.web_search` and `features.web_search` pass that test, a real query was run end to end: it emitted `web search:` lines and returned a story published that day. This uses the key whose effect was actually observed.

  **Nothing caught this, and the reason is structural**: every test in `codex-cli.test.ts` injects a `runner`, so the flag list inside the default one was the one part of the provider the suite never executed. The argv is now built by an exported `codexExecArgs`, tested directly — including that `--search` is absent and that web search is switched on, since losing the latter silently would be *worse* than the crash: Codex would answer from training data and look like it worked.

  A vendor CLI can drop a flag under us again and no test here can prevent that. What changed is that the flags are now visible to the suite and stated in one place.

- **FR-9.12b** *(Shipped, fixed in NEWS-272)* **Every declared property in the shared JSON schemas is listed in `required`**, because OpenAI's strict structured outputs reject a schema where one is not:

  ```
  invalid_json_schema: 'required' is required to be supplied and to be an array
  including every key in properties. Missing 'outlet'.
  ```

  This was the *second* Codex failure, behind the removed `--search` flag: with the argv accepted, every check then died on a 400 from the schema. Optionality in strict mode is expressed by a **nullable type**, never by omission from `required` — so `outlet`, `publishedAt`, `category` and `subcategory` are all `type: ['string', 'null']` *and* named in `required`, meaning "emit the key, as null when there is nothing to say".

  The prompt changed with it. It used to tell the model to *omit* `category`/`subcategory` unless asked to classify, which put the prompt in direct conflict with the schema; it now asks for null.

  **Three instances, and only one was reported.** Fixing the sources object would have moved the same 400 to the top level on the next run, and writing the rule as a recursive test rather than patching the reported path immediately turned up a third in `SUGGEST_JSON_SCHEMA` — which would have broken every Codex *discovery* call the same way. `tests/unit/news-schema.test.ts` checks the invariant offline, which is the point: the alternative is finding out from a live 400 on someone's subscription.

  **Why only Codex saw it.** `claude-cli` passes the same schema through `--json-schema` and Claude tolerates the looser form, so the defect sat there harmlessly; the `anthropic` and `openai` API providers don't use structured outputs at all. Both CLI paths were re-verified end to end after the change — a real check on each returned real stories with outlets.

- **FR-9.12c** *(Shipped, NEWS-274)* **A failed CLI's error is surfaced by finding the message, not by slicing the tail.** `cliErrorDetail` in `src/ai/providers/cli-error.ts`, shared by both CLI providers.

  Both used to build the user-visible detail as `stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)`. The last three lines of a pretty-printed JSON error are its **closing braces**, so the 400 in FR-9.12b — whose payload named the exact schema path and what was wrong with it — reached the user as `Codex CLI exited with code 1: }, "status": 400 }`. The informative line sat four lines above the window, and diagnosing it meant re-running the CLI by hand and reading the whole stream, which a user cannot do.

  It now pulls the last `"message"` value out of the stream and prefixes it with the `"code"` — code first because that is the searchable half, prose second because it explains. Failing that, it takes the tail with blank and brace-only lines removed, so a plain-text failure (a usage dump, a missing binary) still says something and a JSON blob with no `message` cannot degrade to braces again. The cap rose from 300 to 600 characters, because 300 truncated exactly the messages worth reading.

  `tests/unit/cli-error.test.ts` runs against **real captured stderr** from both Codex failures, and one case keeps the old expression alongside the new one — running it on the same payload is a clearer statement of the problem than any comment.

- **FR-9.12d** *(Shipped, NEWS-277)* **Recorded CLI sessions, replayed in every run.** `npm run record:cli-sessions` captures real transcripts to `tests/fixtures/cli-sessions/*.json`; `tests/unit/cli-session-replay.test.ts` replays them through the real provider.

  **The seam moved down a level, and that is the point.** `config.runner` replaces the argv construction, the schema temp file, the spawn *and* the parsing in one go — which is why all of those had no coverage when three of them broke (FR-9.12a, FR-9.12b, FR-9.12c). `spawnRunner(name, exec)` now takes an injectable process boundary, so a replayed test runs `codexExecArgs`, writes the real schema, reads the real last-message file, parses, sanitizes, and formats errors — against byte-exact output from `codex-cli 0.145.0`.

  Five scenarios, and the two failures were produced **on purpose**: a run with the removed `--search` flag (exit 2, usage dump) and a run with the old schema whose `required` omitted declared properties (exit 1, `invalid_json_schema`). Inventing those payloads is how a fixture gets the shape wrong in exactly the way that hides the bug — the recorded stderr ends `}, "status": 400 }`, which is what the user actually saw, and no hand-written fixture would have thought to end there.

  Proven rather than asserted: restoring the old `cliErrorDetail` makes the replay test produce `Codex CLI exited with code 1:   },   …` — the reported string verbatim — and fail.

  **A recording is fidelity, not currency**, and the distinction decides the architecture:

  | | Recorded replay | Live spec (FR-9.12e) |
  |---|---|---|
  | Runs | every `npm test`, including CI | opt-in, by hand |
  | Catches | our handling of what the vendor says | the vendor changing what it says |
  | Cost | milliseconds | minutes and plan quota |

  A frozen recording of a working `--search` would have replayed success for weeks after the flag was removed. So re-record after a CLI upgrade and read the fixture diff as the vendor's changelog; the live spec is what notices drift unprompted. Each fixture carries its `toolVersion` and `recordedAt` so staleness is visible rather than inferred, and a test asserts both are present — a fixture with no provenance is indistinguishable from an invented one.

- **FR-9.12e** *(Shipped, NEWS-276)* **A live-subscription E2E**, `npm run test:e2e:real`, on its own server with no `--ai-test`.

  Deliberately **not** in `test:all`: a check may take up to the providers' own 10-minute ceiling and spends plan quota, while `test:all` has to stay the thing you run before every commit. Skips per provider when the CLI is not signed in, and always in CI.

  Two things learned building it, both now encoded: the wait is **derived from the providers' exported `CHECK_TIMEOUT_MS`** rather than restated, because a test that gives up first reports a failure the app considers a healthy slow check — the first version waited four minutes against a ten-minute ceiling and duly failed one. And it is **not `mode: 'serial'`**, because serial skips the rest of the file after a failure, so one slow Claude check hid the Codex verdict entirely — the opposite of what a provider smoke test is for.

- **FR-9.13** *(Shipped)* **`-s read-only`.** Codex is a coding agent that can execute shell commands; a news lookup must not write anything. This is the equivalent of `claude-cli`'s `--allowed-tools WebSearch` — narrow the agent to the job.

- **FR-9.14** *(Shipped)* Two differences from the Claude CLI drive the implementation:
  - **`--output-schema` takes a file path**, not an inline string, so `NEWS_JSON_SCHEMA` is written to a temp file per run (Claude's `--json-schema` takes it directly).
  - **No separate system-prompt flag**, so system and user prompts are combined into the single positional argument with a `---` boundary (`combinePrompt`).

  The final message is read from `--output-last-message` rather than scraped off stdout, which carries a progress log. Both temp files are cleaned up in a `finally`.

- **FR-9.15** *(Shipped)* `isAvailable()` = the binary answers `--version` **and** `auth.json` reports `auth_mode: "chatgpt"`. Only that field is read, never the tokens beside it. An API key configured in Codex deliberately does *not* qualify — this provider exists to spend subscription quota, and `openai` already covers the key path.

- **FR-9.16** *(Shipped)* Non-empty stderr is **not** treated as failure: some installs emit a benign `could not create PATH aliases` warning. Only the exit code decides.

- **FR-9.17** *(Shipped)* `AUTO_ORDER` is `claude-cli` → `codex-cli` → `anthropic` → `openai`.

## Not covered

The live path is exercised only by the manual test plan — unit tests inject a fake runner and never spawn the CLI, so nothing in the automated suite depends on a signed-in machine.
