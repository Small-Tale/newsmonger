import { describe, expect, it } from 'vitest';

import type { CodexCliRunner } from '../../src/ai/providers/codex-cli.js';
import { combinePrompt, createCodexCliProvider } from '../../src/ai/providers/codex-cli.js';

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
