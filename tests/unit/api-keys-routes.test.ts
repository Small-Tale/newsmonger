import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { KeysRespSchema } from '../../src/api/schemas.js';
import { CheckRunner } from '../../src/checks.js';
import { Store } from '../../src/db/store.js';
import { __resetKeychainForTests } from '../../src/keychain.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

function makeApp() {
  const store = new Store(tmpDataDir());
  const runner = new CheckRunner(store, asResolver(createMockProvider()));
  return { app: createApp({ store, runner }), store };
}

async function json(res: Response): Promise<unknown> {
  return (await res.json()) as unknown;
}

const SECRET = 'sk-ant-secret-value-do-not-leak';

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

describe('GET /api/keys', () => {
  it('lists every keyed provider as unconfigured to start', async () => {
    const { app } = makeApp();
    const body = KeysRespSchema.parse(await json(await app.request('/api/keys')));
    expect(body.keys.map((k) => k.provider)).toEqual(['anthropic', 'openai']);
    expect(body.keys.every((k) => !k.configured && k.source === null)).toBe(true);
    expect(body.keychainAvailable).toBe(true);
  });

  it('names the environment variable for each provider', async () => {
    const { app } = makeApp();
    const body = KeysRespSchema.parse(await json(await app.request('/api/keys')));
    expect(body.keys.find((k) => k.provider === 'anthropic')?.envVar).toBe('ANTHROPIC_API_KEY');
    expect(body.keys.find((k) => k.provider === 'openai')?.envVar).toBe('OPENAI_API_KEY');
  });

  it('reports a stored key as configured via the keychain', async () => {
    const { app } = makeApp();
    await app.request('/api/keys/anthropic', { method: 'PUT', body: JSON.stringify({ key: SECRET }) });
    const body = KeysRespSchema.parse(await json(await app.request('/api/keys')));
    const anthropic = body.keys.find((k) => k.provider === 'anthropic');
    expect(anthropic?.configured).toBe(true);
    expect(anthropic?.source).toBe('keychain');
  });

  it('reports an environment key as configured via env', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-from-env';
    const { app } = makeApp();
    const body = KeysRespSchema.parse(await json(await app.request('/api/keys')));
    expect(body.keys.find((k) => k.provider === 'openai')?.source).toBe('env');
  });

  it('never returns the key itself, in any form', async () => {
    // The contract the whole feature rests on: status carries provenance, not
    // the secret, and not a masked fragment of it either.
    const { app } = makeApp();
    await app.request('/api/keys/anthropic', { method: 'PUT', body: JSON.stringify({ key: SECRET }) });
    process.env['OPENAI_API_KEY'] = 'sk-env-secret-value';

    const raw = await (await app.request('/api/keys')).text();
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('sk-env-secret-value');
    // Not even a tail fragment — a mask would leak length and a distinguisher.
    expect(raw).not.toContain('leak');
    expect(raw).not.toContain('secret');
  });
});

describe('PUT /api/keys/:provider', () => {
  it('stores a key and flips provider availability', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/keys/anthropic', { method: 'PUT', body: JSON.stringify({ key: SECRET }) });
    expect(res.status).toBe(200);

    const providers = (await json(await app.request('/api/providers'))) as {
      providers: { name: string; available: boolean | null }[];
    };
    expect(providers.providers.find((p) => p.name === 'anthropic')?.available).toBe(true);
  });

  it('rejects an unknown provider', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/keys/ollama', { method: 'PUT', body: JSON.stringify({ key: SECRET }) });
    expect(res.status).toBe(404);
  });

  it('rejects a keyless provider', async () => {
    const { app } = makeApp();
    expect((await app.request('/api/keys/mock', { method: 'PUT', body: JSON.stringify({ key: 'x' }) })).status).toBe(404);
    expect((await app.request('/api/keys/auto', { method: 'PUT', body: JSON.stringify({ key: 'x' }) })).status).toBe(404);
  });

  it('rejects a missing, empty, or whitespace-only key', async () => {
    const { app } = makeApp();
    for (const body of ['{}', JSON.stringify({ key: '' }), JSON.stringify({ key: '   ' })]) {
      expect((await app.request('/api/keys/anthropic', { method: 'PUT', body })).status).toBe(400);
    }
  });

  it('rejects a malformed body', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/keys/anthropic', { method: 'PUT', body: 'not json' });
    expect(res.status).toBe(400);
  });

  it('trims surrounding whitespace from a pasted key', async () => {
    // Copying a key out of a web page routinely brings a trailing newline.
    const { app } = makeApp();
    await app.request('/api/keys/anthropic', { method: 'PUT', body: JSON.stringify({ key: `  ${SECRET}\n` }) });
    const body = KeysRespSchema.parse(await json(await app.request('/api/keys')));
    expect(body.keys.find((k) => k.provider === 'anthropic')?.configured).toBe(true);
  });

  it('replaces an existing key', async () => {
    const { app } = makeApp();
    await app.request('/api/keys/anthropic', { method: 'PUT', body: JSON.stringify({ key: 'sk-first' }) });
    const res = await app.request('/api/keys/anthropic', { method: 'PUT', body: JSON.stringify({ key: 'sk-second' }) });
    expect(res.status).toBe(200);
    const body = KeysRespSchema.parse(await json(await app.request('/api/keys')));
    expect(body.keys.find((k) => k.provider === 'anthropic')?.source).toBe('keychain');
  });
});

describe('DELETE /api/keys/:provider', () => {
  it('removes a stored key', async () => {
    const { app } = makeApp();
    await app.request('/api/keys/anthropic', { method: 'PUT', body: JSON.stringify({ key: SECRET }) });
    expect((await app.request('/api/keys/anthropic', { method: 'DELETE' })).status).toBe(200);
    const body = KeysRespSchema.parse(await json(await app.request('/api/keys')));
    expect(body.keys.find((k) => k.provider === 'anthropic')?.configured).toBe(false);
  });

  it('succeeds when there is nothing to remove', async () => {
    const { app } = makeApp();
    expect((await app.request('/api/keys/anthropic', { method: 'DELETE' })).status).toBe(200);
  });

  it('rejects an unknown provider', async () => {
    const { app } = makeApp();
    expect((await app.request('/api/keys/ollama', { method: 'DELETE' })).status).toBe(404);
  });

  it('leaves an environment key in place', async () => {
    // Deleting clears the keychain; the environment still supplies a key, so
    // the provider stays configured — just from a different source.
    process.env['ANTHROPIC_API_KEY'] = 'sk-from-env';
    const { app } = makeApp();
    await app.request('/api/keys/anthropic', { method: 'DELETE' });
    const body = KeysRespSchema.parse(await json(await app.request('/api/keys')));
    const anthropic = body.keys.find((k) => k.provider === 'anthropic');
    expect(anthropic?.configured).toBe(true);
    expect(anthropic?.source).toBe('env');
  });
});

describe('key lifecycle sequences', () => {
  it('survives save → delete → save', async () => {
    const { app } = makeApp();
    const configured = async (): Promise<boolean> =>
      KeysRespSchema.parse(await json(await app.request('/api/keys'))).keys.find((k) => k.provider === 'anthropic')
        ?.configured ?? false;

    await app.request('/api/keys/anthropic', { method: 'PUT', body: JSON.stringify({ key: 'sk-one' }) });
    expect(await configured()).toBe(true);
    await app.request('/api/keys/anthropic', { method: 'DELETE' });
    expect(await configured()).toBe(false);
    await app.request('/api/keys/anthropic', { method: 'PUT', body: JSON.stringify({ key: 'sk-two' }) });
    expect(await configured()).toBe(true);
  });

  it('hands precedence back to the keychain when the env var is removed', async () => {
    // Both sources populated, then the higher-precedence one disappears — the
    // transition a single-operation test never exercises.
    process.env['ANTHROPIC_API_KEY'] = 'sk-env';
    const { app } = makeApp();
    await app.request('/api/keys/anthropic', { method: 'PUT', body: JSON.stringify({ key: 'sk-stored' }) });

    let body = KeysRespSchema.parse(await json(await app.request('/api/keys')));
    expect(body.keys.find((k) => k.provider === 'anthropic')?.source).toBe('env');

    delete process.env['ANTHROPIC_API_KEY'];
    body = KeysRespSchema.parse(await json(await app.request('/api/keys')));
    expect(body.keys.find((k) => k.provider === 'anthropic')?.source).toBe('keychain');
  });

  it('keeps a check working after the key is swapped mid-session', async () => {
    // The provider caches its SDK client; a replaced key must not keep
    // authenticating as the old one.
    const { app } = makeApp();
    await app.request('/api/keys/openai', { method: 'PUT', body: JSON.stringify({ key: 'sk-first' }) });
    let body = KeysRespSchema.parse(await json(await app.request('/api/keys')));
    expect(body.keys.find((k) => k.provider === 'openai')?.configured).toBe(true);

    await app.request('/api/keys/openai', { method: 'PUT', body: JSON.stringify({ key: 'sk-second' }) });
    body = KeysRespSchema.parse(await json(await app.request('/api/keys')));
    expect(body.keys.find((k) => k.provider === 'openai')?.source).toBe('keychain');
  });
});
