import { describe, expect, it } from 'vitest';

import { createOpenAIProvider, DEFAULT_OPENAI_MODEL, looksLikeEffortRejection } from '../../src/ai/providers/openai.js';

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

describe('effort on the OpenAI provider (NEWS-245)', () => {
  const NEWS_JSON = JSON.stringify({
    items: [{ title: 'T', summary: 'S', sources: [{ title: 'Ex', url: 'https://ex.test/a' }] }],
  });
  const ok = (calls: (string | undefined)[]) => ({
    run: (_s: string, _p: string, _m: string, effort?: string) => {
      calls.push(effort);
      return Promise.resolve({ text: NEWS_JSON, usage: null });
    },
  });
  const key = () => Promise.resolve('test-key');

  it('sends the configured level on a check', async () => {
    const calls: (string | undefined)[] = [];
    await createOpenAIProvider({ runner: ok(calls), getApiKey: key, effort: 'high' }).checkTopic('fusion', [], null);
    expect(calls).toEqual(['high']);
  });

  it('sends nothing when no level is set', async () => {
    // '' is "provider default": the request has to be the one it always was,
    // not a request naming a level called "".
    const calls: (string | undefined)[] = [];
    await createOpenAIProvider({ runner: ok(calls), getApiKey: key }).checkTopic('fusion', [], null);
    expect(calls).toEqual(['']);
  });

  it('reports the level on the provider, so the run log records it', () => {
    // `CheckRunner` stores `provider.effort` against the run (NEWS-226). This
    // was hardcoded to '' here, so every OpenAI check logged as "no effort set".
    expect(createOpenAIProvider({ runner: ok([]), getApiKey: key, effort: 'xhigh' }).effort).toBe('xhigh');
    expect(createOpenAIProvider({ runner: ok([]), getApiKey: key }).effort).toBe('');
  });

  it('does not spend effort on topic discovery', async () => {
    // The same rule as the other three: effort is about how hard a *check*
    // works, and discovery already runs on a cheap model.
    const calls: (string | undefined)[] = [];
    const runner = {
      run: (_s: string, _p: string, _m: string, effort?: string) => {
        calls.push(effort);
        return Promise.resolve({ text: JSON.stringify({ suggestions: [] }), usage: null });
      },
    };
    await createOpenAIProvider({ runner, getApiKey: key, effort: 'max' }).suggestTopics({
      scope: { kind: 'describe', query: '' },
      exclude: [],
    });
    expect(calls).toEqual([undefined]);
  });
});

describe('when the model does not do reasoning (NEWS-245)', () => {
  const NEWS_JSON = JSON.stringify({
    items: [{ title: 'T', summary: 'S', sources: [{ title: 'Ex', url: 'https://ex.test/a' }] }],
  });
  const key = () => Promise.resolve('test-key');
  /** A model that rejects `reasoning.effort` the way the Responses API would. */
  const rejecting = (calls: (string | undefined)[]) => ({
    run: (_s: string, _p: string, _m: string, effort?: string) => {
      calls.push(effort);
      if (effort !== undefined && effort !== '') {
        return Promise.reject(
          Object.assign(new Error("Unsupported parameter: 'reasoning.effort' is not supported with this model."), {
            status: 400,
            param: 'reasoning.effort',
          }),
        );
      }
      return Promise.resolve({ text: NEWS_JSON, usage: null });
    },
  });

  it('retries without effort rather than failing the check', async () => {
    // Unlike the two CLIs, this provider takes any model id and can point at a
    // gateway via OPENAI_BASE_URL, so nothing here can know which models do
    // reasoning. It asks and takes the answer, instead of carrying a list of
    // model prefixes that goes stale the moment a family ships.
    const calls: (string | undefined)[] = [];
    const result = await createOpenAIProvider({ runner: rejecting(calls), getApiKey: key, effort: 'high' }).checkTopic(
      'fusion',
      [],
      null,
    );
    expect(calls).toEqual(['high', '']);
    expect(result.items).toHaveLength(1);
  });

  it('pays the wasted request once, not on every check', async () => {
    const calls: (string | undefined)[] = [];
    const p = createOpenAIProvider({ runner: rejecting(calls), getApiKey: key, effort: 'high' });
    await p.checkTopic('fusion', [], null);
    await p.checkTopic('fusion', [], null);
    await p.checkTopic('fusion', [], null);
    // First check probes and falls back; the rest go straight through.
    expect(calls).toEqual(['high', '', '', '']);
  });

  it('does not swallow a real failure', async () => {
    // A 400 that says nothing about reasoning is a bad key, a bad model, a
    // malformed prompt. Retrying those would double every failing request and
    // hide the cause behind a second identical failure.
    const calls: (string | undefined)[] = [];
    const runner = {
      run: (_s: string, _p: string, _m: string, effort?: string) => {
        calls.push(effort);
        return Promise.reject(Object.assign(new Error('Incorrect API key provided'), { status: 401 }));
      },
    };
    await expect(
      createOpenAIProvider({ runner, getApiKey: key, effort: 'high' }).checkTopic('fusion', [], null),
    ).rejects.toThrow('Incorrect API key');
    expect(calls, 'a real failure must not be retried').toHaveLength(1);
  });
});

describe('looksLikeEffortRejection (NEWS-245)', () => {
  it('recognises the parameter being refused, by param or by message', () => {
    expect(looksLikeEffortRejection({ status: 400, param: 'reasoning.effort' })).toBe(true);
    expect(
      looksLikeEffortRejection({ status: 400, message: "Unsupported parameter: 'reasoning.effort'" }),
    ).toBe(true);
    expect(looksLikeEffortRejection({ status: 400, code: 'unsupported_reasoning' })).toBe(true);
  });

  it('ignores anything that is not a 400 about reasoning', () => {
    // Narrow on purpose. Widening this turns every unrelated failure into two.
    expect(looksLikeEffortRejection({ status: 401, param: 'reasoning.effort' })).toBe(false);
    expect(looksLikeEffortRejection({ status: 400, message: 'Incorrect API key provided' })).toBe(false);
    expect(looksLikeEffortRejection({ status: 500, message: 'reasoning' })).toBe(false);
    expect(looksLikeEffortRejection(new Error('reasoning'))).toBe(false);
    expect(looksLikeEffortRejection(null)).toBe(false);
    expect(looksLikeEffortRejection('reasoning')).toBe(false);
  });

  /**
   * Errors captured from the **real OpenAI API**, through the SDK this provider
   * actually uses — so these are the objects `looksLikeEffortRejection` will be
   * handed in production, not an approximation of them.
   *
   * They replace guesses. The predicate was originally written from an assumed
   * error shape because there was no key on this machine, which is the same
   * move that was wrong twice earlier in the week (NEWS-239, NEWS-244). A
   * temporary key settled it: both branches are now pinned to verbatim
   * responses, and the whole path was exercised end to end — a real
   * `checkTopic` with `effort: 'high'` against `gpt-4o`, a model that cannot
   * take it, returned two real stories in 7 seconds by falling back.
   */
  describe('against errors captured from the live API', () => {
    it('matches the real refusal, as the SDK throws it', () => {
      // Verbatim from `openai` SDK `BadRequestError`, `POST /v1/responses` with
      // `model: gpt-4o, reasoning: { effort: 'high' }`. A control request
      // without the parameter succeeded on the same key and model, so this is
      // the parameter being refused and not the model being unavailable.
      const real = {
        status: 400,
        param: 'reasoning.effort',
        code: 'unsupported_parameter',
        type: 'invalid_request_error',
        message: "400 Unsupported parameter: 'reasoning.effort' is not supported with this model.",
      };
      expect(looksLikeEffortRejection(real)).toBe(true);
    });

    it('does not match a real 400 about something else', () => {
      // Verbatim from the same endpoint and key with `max_output_tokens: 1`.
      // A genuine 400 with a genuine `param`, and nothing to do with reasoning —
      // the case the narrowness exists for. Retrying it would send the identical
      // bad request again and bury the real message under a second copy.
      const real = {
        status: 400,
        param: 'max_output_tokens',
        code: 'integer_below_min_value',
        type: 'invalid_request_error',
        message: "400 Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 1 instead.",
      };
      expect(looksLikeEffortRejection(real)).toBe(false);
    });

    it('does not match the Codex account gate', () => {
      // From `codex exec -m gpt-4o`. Reached while trying to produce the
      // refusal above without a key — a ChatGPT subscription offers reasoning
      // models only and rejects the rest *before* the parameter is evaluated,
      // which is why that route could never answer the question.
      const real = {
        status: 400,
        type: 'invalid_request_error',
        message: "The 'gpt-4o' model is not supported when using Codex with a ChatGPT account.",
      };
      expect(looksLikeEffortRejection(real)).toBe(false);
    });
  });
});
