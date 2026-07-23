# Manual Test Plan

Features that can't be reliably automated (yet). Remove entries as automated coverage lands and note the move under "Automated Coverage Summary".

## Real Claude news checks (needs `ANTHROPIC_API_KEY`)

1. `npm run dev` with a valid key; add a topic with active news coverage (e.g. "artificial intelligence").
2. Click **Check** — within a couple of minutes, items should appear with plausible titles, 2–4 sentence summaries, and working links to real news articles.
3. Click **Check** again immediately — expect zero or few new items (dedup against the first batch; the model is told what was already reported).
4. Add a very obscure topic — expect a successful check with no items ("Nothing found yet" only if no other topic has items).
5. Unset the key and check — expect the run to fail and the warning banner to name the topic with an auth error.

## Real OpenAI checks (needs `OPENAI_API_KEY`)

1. `npm run dev --provider openai` (or set provider to OpenAI in Settings) with a valid key; add a topic with active coverage.
2. Check — expect live items with real source links (the Responses API `web_search` tool). Confirm the default model (`gpt-5`) is available to the account, or set `--model`.
3. Point `OPENAI_BASE_URL` / `--endpoint` at an OpenAI-compatible gateway and confirm it still works.

## Real Ollama checks (needs a local Ollama with a pulled model)

1. `ollama pull llama3.2` (or similar); `npm run dev --provider ollama`.
2. Check a topic — expect a "not live-searched" badge (NEWS-10) and items summarized from the model's knowledge. Confirm dedup on a second check.
3. Verified during development against `codestral:latest` (returned parseable JSON); `gpt-oss:20b` failed to load on the dev box (surfaced as a clear 500 with the server message).

## Tauri desktop shell (needs Rust toolchain)

1. `npm run tauri:dev` — window shows the loading spinner, then the app once the server prints its readiness line.
2. Click a source link — it should open in the system browser, not inside the webview.
3. Quit the app — the spawned `node` server process must exit too (`pgrep -f cli.ts`).

## System browser opening

1. `npm run dev` (without `--no-open`) — the default browser should open to the app.

## Automated Coverage Summary

- Topics CRUD, scheduling logic, dedup, parsing, API validation, and full UI flows are covered by `npm test` + `npm run test:e2e` (mock AI service).
