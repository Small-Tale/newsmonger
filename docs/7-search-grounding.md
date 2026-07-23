# 7 — Search Grounding (design)

**Status: design + foundation.** This decouples *finding* candidate articles from *summarizing* them, so a provider that can't browse (Ollama, local, OpenAI-compatible gateways without a hosted search tool) can still produce genuinely fresh news. Tracks NEWS-12; build split into NEWS-13/14/15.

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
- **NEWS-14** — thread it through `CheckRunner`: grounded path (`summarize`), `searchProvider` setting, `auto` allowing grounded locals, run records note grounding. Adversarial/transition tests around the three pipeline branches.
- **NEWS-15** — UI: search-provider picker + key status; suppress the NOT-LIVE badge for grounded runs; show "grounded via \<search\>".

## Open questions (for the maintainer)

- Default search provider = Tavily OK, or prefer Brave/SerpAPI/self-hosted SearXNG?
- Should a configured search provider ground **all** providers (even Anthropic/OpenAI, replacing their native search) or **only** non-searching ones? (Proposed: only non-searching, to avoid double-paying for search.)
