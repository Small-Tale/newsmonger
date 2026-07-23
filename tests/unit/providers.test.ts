import { describe, expect, it } from 'vitest';

import { createAnthropicProvider } from '../../src/ai/providers/anthropic.js';
import { AUTO_ORDER, resolveProvider } from '../../src/ai/providers/index.js';
import { createMockProvider } from '../../src/ai/providers/mock.js';
import type { ConcreteProviderName, NewsProvider } from '../../src/ai/types.js';
import { fakeProvider } from '../helpers/provider.js';

function factoriesWith(available: Partial<Record<ConcreteProviderName, boolean>>) {
  const make = (name: ConcreteProviderName): NewsProvider =>
    fakeProvider(() => Promise.resolve([]), { name, searchesWeb: name !== 'ollama' && name !== 'mock' });
  return {
    anthropic: () => ({ ...make('anthropic'), isAvailable: () => Promise.resolve(available.anthropic ?? false) }),
    openai: () => ({ ...make('openai'), isAvailable: () => Promise.resolve(available.openai ?? false) }),
    ollama: () => ({ ...make('ollama'), isAvailable: () => Promise.resolve(available.ollama ?? false) }),
    mock: () => make('mock'),
  };
}

describe('resolveProvider', () => {
  it('auto prefers anthropic when available', async () => {
    const p = await resolveProvider(
      { provider: 'auto', model: '', endpoint: '' },
      factoriesWith({ anthropic: true, openai: true }),
    );
    expect(p.name).toBe('anthropic');
  });

  it('auto falls through to openai when anthropic is unavailable', async () => {
    const p = await resolveProvider(
      { provider: 'auto', model: '', endpoint: '' },
      factoriesWith({ anthropic: false, openai: true }),
    );
    expect(p.name).toBe('openai');
  });

  it('auto never selects a non-web-searching provider, and throws when none available', async () => {
    await expect(
      resolveProvider({ provider: 'auto', model: '', endpoint: '' }, factoriesWith({ ollama: true })),
    ).rejects.toThrow(/No web-searching AI provider/);
  });

  it('auto only tries web-searching providers', () => {
    expect(AUTO_ORDER).toEqual(['anthropic', 'openai']);
  });

  it('explicit provider is returned when available', async () => {
    const p = await resolveProvider({ provider: 'mock', model: '', endpoint: '' }, factoriesWith({}));
    expect(p.name).toBe('mock');
  });

  it('explicit unavailable provider throws an actionable message', async () => {
    await expect(
      resolveProvider({ provider: 'anthropic', model: '', endpoint: '' }, factoriesWith({ anthropic: false })),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('a factory that throws (unimplemented provider) is skipped by auto', async () => {
    const factories = {
      ...factoriesWith({ openai: true }),
      anthropic: () => {
        throw new Error('boom');
      },
    };
    const p = await resolveProvider({ provider: 'auto', model: '', endpoint: '' }, factories);
    expect(p.name).toBe('openai');
  });
});

describe('createMockProvider', () => {
  it('is available and does not search the web', async () => {
    const p = createMockProvider();
    expect(p.searchesWeb).toBe(false);
    expect(await p.isAvailable()).toBe(true);
  });

  it('returns two deterministic stories and records calls', async () => {
    const p = createMockProvider();
    const items = await p.checkTopic('Fusion', [], null);
    expect(items).toHaveLength(2);
    expect(p.calls).toHaveLength(1);
  });
});

describe('createAnthropicProvider', () => {
  it('declares web search and reports availability from the key check', async () => {
    const withKey = createAnthropicProvider({ runner: { run: () => Promise.resolve('') }, hasApiKey: () => true });
    expect(withKey.searchesWeb).toBe(true);
    expect(withKey.model).toBe('claude-opus-4-8');
    expect(await withKey.isAvailable()).toBe(true);

    const noKey = createAnthropicProvider({ runner: { run: () => Promise.resolve('') }, hasApiKey: () => false });
    expect(await noKey.isAvailable()).toBe(false);
  });

  it('parses the fenced-JSON result from the injected runner', async () => {
    const runner = {
      run: () =>
        Promise.resolve('Here you go:\n```json\n{"items":[{"title":"T","summary":"S","sources":[]}]}\n```'),
    };
    const p = createAnthropicProvider({ runner, hasApiKey: () => true });
    const items = await p.checkTopic('AI', [], null);
    expect(items).toEqual([{ title: 'T', summary: 'S', sources: [] }]);
  });

  it('surfaces a refusal as an error', async () => {
    const runner = {
      run: () => Promise.reject(new Error('Claude declined to research this topic')),
    };
    const p = createAnthropicProvider({ runner, hasApiKey: () => true });
    await expect(p.checkTopic('X', [], null)).rejects.toThrow(/declined/);
  });
});
