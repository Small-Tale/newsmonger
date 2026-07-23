import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deleteApiKey, resolveApiKey, saveApiKey } from '../../src/ai/api-keys.js';
import { isKeyedProvider,KEY_ENV_VARS } from '../../src/ai/types.js';
import { __resetKeychainForTests, keyAccount, keychainGet, winTarget } from '../../src/keychain.js';

/** `delete process.env[expr]` trips no-dynamic-delete; setting '' reads as unset. */
function clearEnv(provider: 'anthropic' | 'openai'): void {
  process.env[KEY_ENV_VARS[provider]] = '';
}

// The in-memory keychain: these tests must never touch the developer's real one.
beforeEach(() => {
  process.env['NEWS_FAKE_KEYCHAIN'] = '1';
  __resetKeychainForTests();
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
});

afterEach(() => {
  delete process.env['NEWS_FAKE_KEYCHAIN'];
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
  __resetKeychainForTests();
});

describe('keychain naming', () => {
  it('namespaces accounts per provider', () => {
    expect(keyAccount('anthropic')).toBe('anthropic-api-key');
    expect(keyAccount('openai')).toBe('openai-api-key');
  });

  it('prefixes the Windows credential target with the service', () => {
    expect(winTarget('anthropic-api-key')).toBe('news-anthropic-api-key');
  });
});

describe('isKeyedProvider', () => {
  it('accepts the providers that authenticate with a key', () => {
    expect(isKeyedProvider('anthropic')).toBe(true);
    expect(isKeyedProvider('openai')).toBe(true);
  });

  it('rejects keyless and unknown providers', () => {
    // `mock` needs no key, and the rest are untrusted path segments.
    expect(isKeyedProvider('mock')).toBe(false);
    expect(isKeyedProvider('auto')).toBe(false);
    expect(isKeyedProvider('ollama')).toBe(false);
    expect(isKeyedProvider('')).toBe(false);
    expect(isKeyedProvider('../../etc/passwd')).toBe(false);
  });
});

describe('resolveApiKey', () => {
  it('reports no key when neither source has one', async () => {
    expect(await resolveApiKey('anthropic')).toEqual({ key: null, source: null });
  });

  it('reads a stored key from the keychain', async () => {
    await saveApiKey('anthropic', 'sk-stored');
    expect(await resolveApiKey('anthropic')).toEqual({ key: 'sk-stored', source: 'keychain' });
  });

  it('reads a key from the environment', async () => {
    process.env[KEY_ENV_VARS.anthropic] = 'sk-env';
    expect(await resolveApiKey('anthropic')).toEqual({ key: 'sk-env', source: 'env' });
  });

  it('prefers the environment over a stored key', async () => {
    await saveApiKey('anthropic', 'sk-stored');
    process.env[KEY_ENV_VARS.anthropic] = 'sk-env';
    expect(await resolveApiKey('anthropic')).toEqual({ key: 'sk-env', source: 'env' });
  });

  it('treats an empty environment variable as unset', async () => {
    // An exported-but-blank variable is the shape you get from `export KEY=`;
    // falling through to the keychain is the useful reading.
    await saveApiKey('anthropic', 'sk-stored');
    process.env[KEY_ENV_VARS.anthropic] = '';
    expect(await resolveApiKey('anthropic')).toEqual({ key: 'sk-stored', source: 'keychain' });
  });

  it('keeps providers separate', async () => {
    await saveApiKey('anthropic', 'sk-ant');
    expect(await resolveApiKey('openai')).toEqual({ key: null, source: null });
    await saveApiKey('openai', 'sk-oai');
    expect((await resolveApiKey('anthropic')).key).toBe('sk-ant');
    expect((await resolveApiKey('openai')).key).toBe('sk-oai');
  });
});

describe('saveApiKey / deleteApiKey', () => {
  it('overwrites rather than duplicating', async () => {
    await saveApiKey('anthropic', 'sk-first');
    await saveApiKey('anthropic', 'sk-second');
    expect((await resolveApiKey('anthropic')).key).toBe('sk-second');
  });

  it('removes a stored key', async () => {
    await saveApiKey('anthropic', 'sk-stored');
    await deleteApiKey('anthropic');
    expect(await resolveApiKey('anthropic')).toEqual({ key: null, source: null });
  });

  it('is idempotent when nothing is stored', async () => {
    await expect(deleteApiKey('anthropic')).resolves.toBeUndefined();
    await expect(deleteApiKey('anthropic')).resolves.toBeUndefined();
  });

  it('deletes only the named provider', async () => {
    await saveApiKey('anthropic', 'sk-ant');
    await saveApiKey('openai', 'sk-oai');
    await deleteApiKey('anthropic');
    expect((await resolveApiKey('openai')).key).toBe('sk-oai');
  });

  it('cannot unset an environment-supplied key', async () => {
    // Nothing in the app can remove a variable it did not set — the UI relies
    // on this by hiding Remove for env-sourced keys.
    process.env[KEY_ENV_VARS.anthropic] = 'sk-env';
    await deleteApiKey('anthropic');
    expect(await resolveApiKey('anthropic')).toEqual({ key: 'sk-env', source: 'env' });
  });

  it('falls back to the keychain when the environment variable goes away', async () => {
    // A sequence, not a single operation: both sources populated, then the
    // higher-precedence one disappears mid-session.
    await saveApiKey('anthropic', 'sk-stored');
    process.env[KEY_ENV_VARS.anthropic] = 'sk-env';
    expect((await resolveApiKey('anthropic')).source).toBe('env');
    clearEnv('anthropic');
    expect(await resolveApiKey('anthropic')).toEqual({ key: 'sk-stored', source: 'keychain' });
  });

  it('round-trips values with characters a shell would mangle', async () => {
    const awkward = `sk-'quo"te $var \`tick\` ümlaut 🔑`;
    await saveApiKey('openai', awkward);
    expect(await keychainGet(keyAccount('openai'))).toBe(awkward);
  });
});
