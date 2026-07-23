import { describe, expect, it, vi } from 'vitest';

import { createOllamaProvider, DEFAULT_OLLAMA_ENDPOINT, resolveOllamaEndpoint } from '../../src/ai/providers/ollama.js';
import { extractChatContent, normalizeEndpoint, parseModelList } from '../../src/ai/providers/openaiCompat.js';

const NEWS_JSON = '{"items":[{"title":"T","summary":"S","sources":[{"title":"Src","url":"https://a.com/x"}]}]}';

/** Fake fetch routing /models and /chat/completions to canned responses. */
function fakeFetch(opts: {
  models?: string[];
  content?: string;
  modelsStatus?: number;
  chatStatus?: number;
  onChatBody?: (body: unknown) => void;
}): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) {
      const ok = (opts.modelsStatus ?? 200) < 400;
      return Promise.resolve({
        ok,
        status: opts.modelsStatus ?? 200,
        json: () => Promise.resolve({ data: (opts.models ?? []).map((id) => ({ id })) }),
      } as Response);
    }
    if (url.endsWith('/chat/completions')) {
      if (opts.onChatBody) opts.onChatBody(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      const ok = (opts.chatStatus ?? 200) < 400;
      return Promise.resolve({
        ok,
        status: opts.chatStatus ?? 200,
        json: () => Promise.resolve({ choices: [{ message: { content: opts.content ?? NEWS_JSON } }] }),
      } as Response);
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
}

describe('parseModelList', () => {
  it('pulls ids from the OpenAI models shape', () => {
    expect(parseModelList({ data: [{ id: 'llama3.2' }, { id: 'mistral' }] })).toEqual(['llama3.2', 'mistral']);
  });
  it('is defensive against malformed bodies', () => {
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList({})).toEqual([]);
    expect(parseModelList({ data: 'nope' })).toEqual([]);
    expect(parseModelList({ data: [{ id: 5 }, {}] })).toEqual([]);
  });
});

describe('extractChatContent', () => {
  it('returns the first choice message content', () => {
    expect(extractChatContent({ choices: [{ message: { content: 'hi' } }] })).toBe('hi');
  });
  it('throws on missing choices or content', () => {
    expect(() => extractChatContent({ choices: [] })).toThrow(/no choices/);
    expect(() => extractChatContent({ choices: [{ message: {} }] })).toThrow(/no message content/);
  });
});

describe('normalizeEndpoint / resolveOllamaEndpoint', () => {
  it('drops trailing slashes', () => {
    expect(normalizeEndpoint('http://h/v1/')).toBe('http://h/v1');
  });
  it('defaults, honors env, and appends /v1 to a bare host', () => {
    expect(resolveOllamaEndpoint('', {})).toBe(DEFAULT_OLLAMA_ENDPOINT);
    expect(resolveOllamaEndpoint('', { NEWS_OLLAMA_HOST: 'http://box:11434' })).toBe('http://box:11434/v1');
    expect(resolveOllamaEndpoint('http://box:1234/v1', {})).toBe('http://box:1234/v1');
    expect(resolveOllamaEndpoint('', { NEWS_OLLAMA_ENDPOINT: 'http://a/v1' })).toBe('http://a/v1');
  });
  it('explicit config wins over env', () => {
    expect(resolveOllamaEndpoint('http://explicit/v1', { NEWS_OLLAMA_HOST: 'http://env' })).toBe('http://explicit/v1');
  });
});

describe('createOllamaProvider', () => {
  it('never claims to search the web', () => {
    expect(createOllamaProvider({ fetchImpl: fakeFetch({}) }).searchesWeb).toBe(false);
  });

  it('is available iff at least one model is listed', async () => {
    expect(await createOllamaProvider({ fetchImpl: fakeFetch({ models: ['llama3.2'] }), env: {} }).isAvailable()).toBe(true);
    expect(await createOllamaProvider({ fetchImpl: fakeFetch({ models: [] }), env: {} }).isAvailable()).toBe(false);
    expect(
      await createOllamaProvider({ fetchImpl: fakeFetch({ modelsStatus: 500 }), env: {} }).isAvailable(),
    ).toBe(false);
  });

  it('checks a topic and parses the JSON result', async () => {
    const p = createOllamaProvider({ model: 'llama3.2', fetchImpl: fakeFetch({}), env: {} });
    const items = await p.checkTopic('Fusion', [], null);
    expect(items).toEqual([{ title: 'T', summary: 'S', sources: [{ title: 'Src', url: 'https://a.com/x' }] }]);
  });

  it('requests JSON via response_format and sends system+user messages', async () => {
    let sent: unknown;
    const p = createOllamaProvider({
      model: 'llama3.2',
      env: {},
      fetchImpl: fakeFetch({
        onChatBody: (b) => {
          sent = b;
        },
      }),
    });
    await p.checkTopic('Fusion', [], null);
    const body = sent as { model: string; response_format: { type: string }; messages: { role: string }[]; stream: boolean };
    expect(body.model).toBe('llama3.2');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.stream).toBe(false);
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('auto-discovers the first model when none is configured', async () => {
    let sent: { model?: string } = {};
    const p = createOllamaProvider({
      env: {},
      fetchImpl: fakeFetch({
        models: ['mistral', 'llama3.2'],
        onChatBody: (b) => {
          sent = b as { model?: string };
        },
      }),
    });
    await p.checkTopic('Fusion', [], null);
    expect(sent.model).toBe('mistral');
  });

  it('throws a pull hint when no model is configured and none are listed', async () => {
    const p = createOllamaProvider({ env: {}, fetchImpl: fakeFetch({ models: [] }) });
    await expect(p.checkTopic('Fusion', [], null)).rejects.toThrow(/ollama pull/);
  });

  it('times out a hung request', async () => {
    vi.useFakeTimers();
    try {
      const hangingFetch = ((url: string, init?: RequestInit) => {
        if (url.endsWith('/chat/completions')) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [{ id: 'm' }] }) } as Response);
      }) as typeof fetch;
      const p = createOllamaProvider({ model: 'm', fetchImpl: hangingFetch, env: {}, timeoutMs: 50 });
      const pending = p.checkTopic('Fusion', [], null);
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
