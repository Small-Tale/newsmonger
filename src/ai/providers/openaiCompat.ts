import { buildSummarizePrompt, buildUserPrompt, groundedSystemPrompt, offlineSystemPrompt, parseNewsResult, searchingSystemPrompt } from '../prompt.js';
import type { SearchResult } from '../search/types.js';
import type { FoundNewsItem, KnownItem } from '../types.js';

export type FetchImpl = typeof fetch;

/** Response shape of `GET {endpoint}/models` (OpenAI-compatible). */
export function parseModelList(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || !('data' in body)) return [];
  const { data } = body;
  if (!Array.isArray(data)) return [];
  return data
    .map((m: unknown) => (typeof m === 'object' && m !== null && 'id' in m ? m.id : undefined))
    .filter((id): id is string => typeof id === 'string' && id !== '');
}

/** Extract assistant text from an OpenAI-compatible chat completion. */
export function extractChatContent(body: unknown): string {
  const choices = typeof body === 'object' && body !== null && 'choices' in body ? body.choices : undefined;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('response had no choices');
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  if (typeof message?.content !== 'string') throw new Error('response choice had no message content');
  return message.content;
}

async function fetchJson(
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`${url} returned ${res.status}${await errorDetail(res)}`);
    return (await res.json()) as unknown;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`request to ${url} timed out`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort extraction of a server error message (OpenAI `{error:{message}}` shape). */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const err = body.error;
      const message =
        typeof err === 'string' ? err : typeof err === 'object' && err !== null && 'message' in err ? err.message : undefined;
      if (typeof message === 'string' && message !== '') return `: ${message}`;
    }
  } catch {
    // non-JSON body — nothing useful to add
  }
  return '';
}

/** Normalize a base URL: drop a trailing slash so `${base}/models` is clean. */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

/**
 * Shared machinery for OpenAI-compatible chat backends (Ollama today; hosted
 * OpenAI-compatible gateways later). Handles model discovery, the JSON request,
 * and response parsing; callers supply endpoint/model resolution, capability,
 * and any auth header.
 */
export interface OpenAICompatConfig {
  name: 'ollama';
  endpoint: string;
  /** Chosen model, or '' to auto-pick the first listed model. */
  model: string;
  searchesWeb: boolean;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  /** Extra headers (e.g. Authorization) for hosted gateways. */
  headers?: Record<string, string>;
}

export function createOpenAICompatBackend(config: OpenAICompatConfig): {
  listModels(): Promise<string[]>;
  resolveModel(): Promise<string>;
  complete(system: string, prompt: string): Promise<string>;
} {
  const endpoint = normalizeEndpoint(config.endpoint);
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 120_000;
  const headers = { 'Content-Type': 'application/json', ...config.headers };

  async function listModels(): Promise<string[]> {
    return parseModelList(await fetchJson(fetchImpl, `${endpoint}/models`, { method: 'GET', headers }, 3_000));
  }

  async function resolveModel(): Promise<string> {
    if (config.model !== '') return config.model;
    const models = await listModels();
    if (models.length === 0) {
      throw new Error(`no models available at ${endpoint} — pull one first (e.g. \`ollama pull llama3.2\`)`);
    }
    return models[0];
  }

  async function complete(system: string, prompt: string): Promise<string> {
    const model = await resolveModel();
    const body = await fetchJson(
      fetchImpl,
      `${endpoint}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          stream: false,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        }),
      },
      timeoutMs,
    );
    return extractChatContent(body);
  }

  return { listModels, resolveModel, complete };
}

/** Build a checkTopic that runs the shared backend with the right prompts. */
export function openAICompatCheckTopic(
  backend: { complete(system: string, prompt: string): Promise<string> },
  searchesWeb: boolean,
): (topicName: string, known: KnownItem[], sinceIso: string | null) => Promise<FoundNewsItem[]> {
  return async (topicName, known, sinceIso) => {
    const system = searchesWeb ? searchingSystemPrompt() : offlineSystemPrompt();
    const text = await backend.complete(system, buildUserPrompt(topicName, known, sinceIso, { searchesWeb }));
    return parseNewsResult(text);
  };
}

/** Build a summarize() that grounds the backend on pre-fetched search results. */
export function openAICompatSummarize(
  backend: { complete(system: string, prompt: string): Promise<string> },
): (topicName: string, known: KnownItem[], results: SearchResult[]) => Promise<FoundNewsItem[]> {
  return async (topicName, known, results) => {
    if (results.length === 0) return [];
    const text = await backend.complete(groundedSystemPrompt(), buildSummarizePrompt(topicName, known, results));
    return parseNewsResult(text);
  };
}
