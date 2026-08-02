import { describe, expect, it } from 'vitest';

import type { CodexCliRunner } from '../../src/ai/providers/codex-cli.js';
import { combinePrompt, createCodexCliProvider } from '../../src/ai/providers/codex-cli.js';
import { PROVIDER_EFFORT_LEVELS } from '../../src/ai/types.js';

const NEWS = JSON.stringify({
  items: [
    { title: 'Fusion milestone', summary: 'A thing happened.', sources: [{ title: 'Ex', url: 'https://ex.test/a' }] },
  ],
});

/** A runner that never spawns anything — the CLI is not exercised in tests. */
function fakeRunner(over: Partial<CodexCliRunner> = {}): CodexCliRunner {
  return { run: () => Promise.resolve(NEWS), available: () => Promise.resolve(true), ...over };
}

describe('combinePrompt', () => {
  it('joins the system and user prompts with a visible boundary', () => {
    // Codex has no separate system-prompt flag, so the two share one
    // positional argument and need something to separate them.
    const combined = combinePrompt('SYSTEM RULES', 'Topic: fusion');
    expect(combined.startsWith('SYSTEM RULES')).toBe(true);
    expect(combined.endsWith('Topic: fusion')).toBe(true);
    expect(combined).toContain('\n\n---\n\n');
  });
});

describe('createCodexCliProvider', () => {
  it('is an attended provider — it spends subscription quota', () => {
    expect(createCodexCliProvider({ runner: fakeRunner() }).attended).toBe(true);
  });

  it('identifies as codex-cli', () => {
    expect(createCodexCliProvider({ runner: fakeRunner() }).name).toBe('codex-cli');
  });

  it('reports the default model when none is configured', () => {
    expect(createCodexCliProvider({ runner: fakeRunner() }).model).toBe('codex default');
    expect(createCodexCliProvider({ runner: fakeRunner(), model: 'gpt-5' }).model).toBe('gpt-5');
  });

  it('parses stories out of a successful run', async () => {
    const result = await createCodexCliProvider({ runner: fakeRunner() }).checkTopic('fusion energy', [], null);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe('Fusion milestone');
  });

  it('passes the shared prompts through, including the dedup list', async () => {
    const seen: { system: string; prompt: string; model: string | undefined }[] = [];
    const p = createCodexCliProvider({
      runner: fakeRunner({
        run: (system, prompt, model) => {
          seen.push({ system, prompt, model });
          return Promise.resolve(NEWS);
        },
      }),
    });

    await p.checkTopic('fusion energy', [{ title: 'Old story', foundAt: '2026-07-20T00:00:00.000Z' }], null);

    expect(seen[0]?.system).toMatch(/news research assistant/);
    expect(seen[0]?.prompt).toContain('Topic: fusion energy');
    expect(seen[0]?.prompt).toContain('Old story');
    expect(seen[0]?.model).toBeUndefined();
  });

  it('forwards a configured model', async () => {
    const seen: (string | undefined)[] = [];
    const p = createCodexCliProvider({
      model: 'gpt-5',
      runner: fakeRunner({
        run: (_s, _p, model) => {
          seen.push(model);
          return Promise.resolve(NEWS);
        },
      }),
    });
    await p.checkTopic('t', [], null);
    expect(seen[0]).toBe('gpt-5');
  });

  it('surfaces a runner failure rather than swallowing it', async () => {
    const p = createCodexCliProvider({
      runner: fakeRunner({ run: () => Promise.reject(new Error('Codex CLI exited with code 1: not logged in')) }),
    });
    await expect(p.checkTopic('t', [], null)).rejects.toThrow(/not logged in/);
  });

  it('fails clearly when the agent produced no final message', async () => {
    const p = createCodexCliProvider({
      runner: fakeRunner({ run: () => Promise.reject(new Error('Codex CLI returned no result')) }),
    });
    await expect(p.checkTopic('t', [], null)).rejects.toThrow(/no result/);
  });

  it('fails clearly when the final message is not parseable', async () => {
    const p = createCodexCliProvider({ runner: fakeRunner({ run: () => Promise.resolve('I could not find anything.') }) });
    await expect(p.checkTopic('t', [], null)).rejects.toThrow(/could not parse/);
  });

  it('reports availability from the runner', async () => {
    expect(await createCodexCliProvider({ runner: fakeRunner() }).isAvailable()).toBe(true);
    expect(
      await createCodexCliProvider({ runner: fakeRunner({ available: () => Promise.resolve(false) }) }).isAvailable(),
    ).toBe(false);
  });

  it('inherits the shared markup sanitizer', async () => {
    const withCite = JSON.stringify({
      items: [
        {
          title: 'Headline',
          summary: 'Body. <cite index="1">Cited bit.</cite>',
          sources: [{ title: 'Ex', url: 'https://ex.test/a' }],
        },
      ],
    });
    const p = createCodexCliProvider({ runner: fakeRunner({ run: () => Promise.resolve(withCite) }) });
    expect((await p.checkTopic('t', [], null)).items[0]?.summary).toBe('Body. Cited bit.');
  });
});

describe('effort reaches Codex (NEWS-244)', () => {
  /**
   * The claim this replaces was that Codex "documents no equivalent key", which
   * was true of its `--help` and false of Codex. Effort rides the generic
   * `-c key=value` override, so no flag appears in help — and I had treated that
   * absence as an answer.
   *
   * The key is not a guess. With `--strict-config`, `codex exec` accepts
   * `model_reasoning_effort` and rejects an invented key outright:
   *
   *   Error loading config.toml: unknown configuration field
   *   `definitely_not_a_real_key_xyz` in -c/--config override
   *
   * **Without `--strict-config` an unknown key is swallowed in silence**, which
   * is the part worth remembering: the check that made this verifiable is not
   * the one a normal invocation performs.
   */
  function recordingRunner(calls: (string | undefined)[]): CodexCliRunner {
    return fakeRunner({
      run: (_s, _p, _m, _schema, effort) => {
        calls.push(effort);
        return Promise.resolve(NEWS);
      },
    });
  }

  it('passes the configured level on a check', async () => {
    const calls: (string | undefined)[] = [];
    await createCodexCliProvider({ runner: recordingRunner(calls), effort: 'high' }).checkTopic('fusion', [], null);
    expect(calls).toEqual(['high']);
  });

  it('sends nothing when no level is set', async () => {
    // '' is "provider default" — the flag must be absent rather than empty, or
    // Codex would be told to reason at a level called "".
    const calls: (string | undefined)[] = [];
    await createCodexCliProvider({ runner: recordingRunner(calls) }).checkTopic('fusion', [], null);
    expect(calls).toEqual(['']);
  });

  it('reports the level on the provider, so the run log records it', () => {
    // `CheckRunner` stores `provider.effort` against the run (NEWS-226). Left
    // hardcoded at '' — as it was — every Codex check logs as "no effort set"
    // however hard it actually worked.
    expect(createCodexCliProvider({ runner: fakeRunner(), effort: 'xhigh' }).effort).toBe('xhigh');
    expect(createCodexCliProvider({ runner: fakeRunner() }).effort).toBe('');
  });

  it('does not spend effort on topic discovery', async () => {
    // Same rule as the other providers: the setting is about how hard a *check*
    // works, and discovery already runs on a cheap model because it produces a
    // suggestion list rather than a news lookup.
    const calls: (string | undefined)[] = [];
    const runner = fakeRunner({
      run: (_s, _p, _m, _schema, effort) => {
        calls.push(effort);
        return Promise.resolve(JSON.stringify({ suggestions: [] }));
      },
    });
    await createCodexCliProvider({ runner, effort: 'max' }).suggestTopics({
      scope: { kind: 'describe', query: '' },
      exclude: [],
    });
    expect(calls).toEqual([undefined]);
  });

  it('offers only levels Codex accepts', () => {
    // Narrowed in NEWS-250. This used to assert every level in `EFFORT_LEVELS`,
    // which was right while that list was the *intersection* across providers
    // and became wrong the moment it grew into the superset — `none` and
    // `minimal` are OpenAI-only and would fail here for a reason that has
    // nothing to do with Codex. The claim worth keeping is about **this
    // provider's** set.
    //
    // Two sources, both from the vendor: the API named its own list in a 400
    // ("Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'"),
    // and `ultra` was confirmed live — `codex exec -m gpt-5.6-sol -c
    // model_reasoning_effort=ultra` answered normally, while the same level on
    // `gpt-5.4` was refused. Which is the whole point of NEWS-250: acceptance
    // is per model, and the per-model narrowing is tested in
    // `effort-levels.test.ts`.
    const CODEX_ACCEPTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    for (const level of PROVIDER_EFFORT_LEVELS['codex-cli']) {
      expect(CODEX_ACCEPTS, level).toContain(level);
    }
  });
});
