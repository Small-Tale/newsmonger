import { describe, expect, it } from 'vitest';

import { createAnthropicProvider } from '../../src/ai/providers/anthropic.js';
import { AUTO_ORDER, resolveProvider } from '../../src/ai/providers/index.js';
import { createMockProvider } from '../../src/ai/providers/mock.js';
import type { ConcreteProviderName, NewsProvider } from '../../src/ai/types.js';
import { fakeProvider } from '../helpers/provider.js';

function factoriesWith(available: Partial<Record<ConcreteProviderName, boolean>>) {
  const make = (name: ConcreteProviderName): NewsProvider => fakeProvider(() => Promise.resolve([]), { name });
  return {
    anthropic: () => ({ ...make('anthropic'), isAvailable: () => Promise.resolve(available.anthropic ?? false) }),
    openai: () => ({ ...make('openai'), isAvailable: () => Promise.resolve(available.openai ?? false) }),
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

  it('auto throws an actionable error when nothing is available', async () => {
    await expect(
      resolveProvider({ provider: 'auto', model: '', endpoint: '' }, factoriesWith({})),
    ).rejects.toThrow(/No AI provider has an API key/);
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

  it('resolves the real openai factory', async () => {
    const { FACTORIES } = await import('../../src/ai/providers/index.js');
    const p = FACTORIES.openai({ provider: 'openai', model: 'gpt-x', endpoint: '' });
    expect(p.name).toBe('openai');
    expect(p.model).toBe('gpt-x');
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
  it('is always available', async () => {
    expect(await createMockProvider().isAvailable()).toBe(true);
  });

  it('returns two deterministic stories and records calls', async () => {
    const p = createMockProvider();
    const items = await p.checkTopic('Fusion', [], null);
    expect(items).toHaveLength(2);
    expect(p.calls).toHaveLength(1);
  });
});

describe('createAnthropicProvider', () => {
  it('reports availability from the key check', async () => {
    const withKey = createAnthropicProvider({ runner: { run: () => Promise.resolve('') }, getApiKey: () => Promise.resolve('test-key') });
    expect(withKey.model).toBe('claude-opus-4-8');
    expect(await withKey.isAvailable()).toBe(true);

    const noKey = createAnthropicProvider({ runner: { run: () => Promise.resolve('') }, getApiKey: () => Promise.resolve(null) });
    expect(await noKey.isAvailable()).toBe(false);
  });

  it('parses the fenced-JSON result from the injected runner', async () => {
    const runner = {
      run: () =>
        Promise.resolve('Here you go:\n```json\n{"items":[{"title":"T","summary":"S","sources":[]}]}\n```'),
    };
    const p = createAnthropicProvider({ runner, getApiKey: () => Promise.resolve('test-key') });
    const items = await p.checkTopic('AI', [], null);
    expect(items).toEqual([{ title: 'T', summary: 'S', sources: [] }]);
  });

  it('surfaces a refusal as an error', async () => {
    const runner = {
      run: () => Promise.reject(new Error('Claude declined to research this topic')),
    };
    const p = createAnthropicProvider({ runner, getApiKey: () => Promise.resolve('test-key') });
    await expect(p.checkTopic('X', [], null)).rejects.toThrow(/declined/);
  });
});
