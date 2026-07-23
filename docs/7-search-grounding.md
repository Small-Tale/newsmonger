# 7 — Search Grounding

**Status: shipped** (NEWS-12 epic: NEWS-13 SearchProvider+Tavily, NEWS-14 pipeline, NEWS-15 UI — all done). This decouples *finding* candidate articles from *summarizing* them, so a provider that can't browse (Ollama, local) can still produce genuinely fresh news. Remaining follow-ups: a Brave implementation (currently a stub), and the open questions below.

### UI (NEWS-15)

The Source block shows a **"Ground with search"** picker (None / Tavily / Brave) whenever the selected LLM provider can't browse; picking a backend suppresses the NOT-LIVE badge (the run is now live via search). Persisted like the other provider settings.

## Problem

`searchesWeb: false` providers (Ollama etc.) answer from training data — they can't find news that postdates their cutoff, and the UI has to badge results as "not live" (NEWS-10). That makes local models second-class for this app's whole purpose.

## Approach: separate search from summarization

Introduce a **`SearchProvider`** — a web-search backend independent of the LLM:

```ts
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null; // ISO, when the source exposes it
}
export interface SearchProvider {
  readonly name: string;            // 'tavily' | 'brave' | ...
  isAvailable(): Promise<boolean>;  // key present
  search(topic: string, sinceIso: string | null, maxResults: number): Promise<SearchResult[]>;
}
```

The check pipeline (`CheckRunner`) becomes:

```
if provider.searchesWeb:
    items = provider.checkTopic(topic, known, sinceIso)   # native path — unchanged (Anthropic/OpenAI)
elif searchProvider configured:
    results = searchProvider.search(topic, sinceIso, N)    # live candidates
    items = provider.summarize(topic, known, results)      # LLM summarizes/dedups/filters — no browsing needed
else:
    items = provider.checkTopic(...)                        # offline path (today's behavior) + NOT-LIVE badge
```

So a **grounded** local provider gets real, dated candidate articles in its prompt and only has to summarize + judge relevance + dedup — things a local model does fine. When a search provider is configured, `searchesWeb` is effectively true for the *pipeline* even if the LLM itself can't browse, so the NOT-LIVE badge is suppressed for grounded runs.

### LLM interface

Add an optional `summarize(topic, known, results)` to `NewsProvider` (default: fold results into the existing prompt as a "candidate articles" block and reuse `parseNewsResult`). Web-searching providers can ignore it. This keeps the change additive.

## Which search API

**Default: Tavily** — purpose-built for LLM/agent search, clean JSON (`POST https://api.tavily.com/search`, `{query, max_results, days, include_raw_content:false}` → `{results:[{title,url,content,published_date}]}`), generous free tier, single `TAVILY_API_KEY`. **Alternatives** behind the same interface: **Brave Search** (`X-Subscription-Token`), **SerpAPI**. Pick one keyless-friendly default (Tavily) and make the rest pluggable, exactly like the LLM providers.

## Config

- `NEWS_SEARCH_PROVIDER` (`none` default | `tavily` | `brave`), provider-specific key env (`TAVILY_API_KEY`, `BRAVE_API_KEY`). Persisted setting `searchProvider` (like `provider`), UI-selectable.
- `auto` LLM resolution *may* then include local providers **when a search provider is configured** (a grounded local run does live news). Otherwise `auto` stays web-searching-LLM-only.

## Build plan (sub-tickets)

- **NEWS-13** — ✅ `SearchProvider` interface + registry + a fake + **Tavily** implementation (`src/ai/search/`, raw fetch, injected-fetch tests). Self-contained; no pipeline change. Brave declared in the union but resolves to null (follow-up).
- **NEWS-14** — ✅ threaded through `CheckRunner`: optional `NewsProvider.summarize(topic, known, results)` (implemented on Ollama + mock), the three-branch pipeline, `searchProvider` setting + `--search-provider`/`NEWS_SEARCH_PROVIDER`, `CheckRun.grounded`, and `/api/state.searchesWeb` reflecting the effective pipeline (grounded local = live). Adversarial/transition tests cover all three branches + dedup-across-modes + search failure. **Note**: `auto` still resolves LLM-only (it always finds a web-searching LLM); grounding applies to explicitly-selected local providers — a deliberate simplification.
- **NEWS-15** — ✅ UI: "Ground with search" picker in the Source block (shown for non-searching LLMs); NOT-LIVE badge auto-suppressed for grounded runs (driven by `/api/state.searchesWeb`). E2E covers select→badge-hidden→persist.

## Open questions (for the maintainer)

- Default search provider = Tavily OK, or prefer Brave/SerpAPI/self-hosted SearXNG?
- Should a configured search provider ground **all** providers (even Anthropic/OpenAI, replacing their native search) or **only** non-searching ones? (Proposed: only non-searching, to avoid double-paying for search.)
