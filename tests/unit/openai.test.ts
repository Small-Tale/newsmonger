import { describe, expect, it } from 'vitest';

import { createOpenAIProvider, DEFAULT_OPENAI_MODEL } from '../../src/ai/providers/openai.js';

const NEWS = '```json\n{"items":[{"title":"T","summary":"S","sources":[{"title":"Src","url":"https://a.com/x"}]}]}\n```';

describe('createOpenAIProvider', () => {
  it('has the expected name and default model', () => {
    const p = createOpenAIProvider({ runner: { run: () => Promise.resolve({ text: '', usage: null }) }, getApiKey: () => Promise.resolve('test-key') });
    expect(p.name).toBe('openai');
    expect(p.model).toBe(DEFAULT_OPENAI_MODEL);
  });

  it('reports availability from the key check', async () => {
    expect(await createOpenAIProvider({ runner: { run: () => Promise.resolve({ text: '', usage: null }) }, getApiKey: () => Promise.resolve('test-key') }).isAvailable()).toBe(true);
    expect(await createOpenAIProvider({ runner: { run: () => Promise.resolve({ text: '', usage: null }) }, getApiKey: () => Promise.resolve(null) }).isAvailable()).toBe(false);
  });

  it('parses a fenced-JSON result from the runner', async () => {
    const p = createOpenAIProvider({ runner: { run: () => Promise.resolve({ text: `Here:\n${NEWS}`, usage: null }) }, getApiKey: () => Promise.resolve('test-key') });
    const result = await p.checkTopic('AI', [], null);
    expect(result.items).toEqual([
      {
        title: 'T',
        summary: 'S',
        // Absent in the model's output → normalised to null, not dropped.
        sources: [{ title: 'Src', url: 'https://a.com/x', outlet: null, publishedAt: null }],
      },
    ]);
  });

  it('parses an empty result', async () => {
    const p = createOpenAIProvider({
      runner: { run: () => Promise.resolve({ text: '```json\n{"items":[]}\n```', usage: null }) },
      getApiKey: () => Promise.resolve('test-key'),
    });
    expect((await p.checkTopic('AI', [], null)).items).toEqual([]);
  });

  it('passes the resolved model and both prompts to the runner', async () => {
    let seen: { system: string; prompt: string; model: string } | undefined;
    const p = createOpenAIProvider({
      model: 'gpt-x',
      runner: {
        run: (system, prompt, model) => {
          seen = { system, prompt, model };
          return Promise.resolve({ text: '```json\n{"items":[]}\n```', usage: null });
        },
      },
      getApiKey: () => Promise.resolve('test-key'),
    });
    await p.checkTopic('Fusion', [{ title: 'old', foundAt: '2026-07-01T00:00:00Z' }], '2026-07-20T00:00:00Z');
    expect(seen?.model).toBe('gpt-x');
    expect(seen?.system).toMatch(/web search/i);
    expect(seen?.prompt).toMatch(/Topic: Fusion/);
    expect(seen?.prompt).toMatch(/Already reported/);
  });

  it('throws when the model returns no parseable result', async () => {
    const p = createOpenAIProvider({ runner: { run: () => Promise.resolve({ text: 'no json here', usage: null }) }, getApiKey: () => Promise.resolve('test-key') });
    await expect(p.checkTopic('AI', [], null)).rejects.toThrow(/could not parse/);
  });
});
