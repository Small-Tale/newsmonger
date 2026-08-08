import { beforeEach, describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import type { KeyVerdict, KeyVerifier } from '../../src/ai/verify-key.js';
import { CheckRunner } from '../../src/checks.js';
import { __resetKeychainForTests } from '../../src/keychain.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpStore } from '../helpers/tmp.js';

/** Record what the route asked, and answer with a scripted verdict. */
function stubVerifier(verdict: KeyVerdict): KeyVerifier & { calls: { provider: string; key: string }[] } {
  const calls: { provider: string; key: string }[] = [];
  const fn = (provider: string, key: string): Promise<KeyVerdict> => {
    calls.push({ provider, key });
    return Promise.resolve(verdict);
  };
  return Object.assign(fn as KeyVerifier, { calls });
}

function makeApp(verifyKey: KeyVerifier | null) {
  const store = tmpStore();
  const runner = new CheckRunner(store, asResolver(createMockProvider()));
  return createApp({ store, runner, verifyKey });
}

async function put(app: ReturnType<typeof makeApp>, key: string) {
  return app.request('/api/keys/anthropic', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  });
}

describe('key verification before save (NEWS-78)', () => {
  beforeEach(() => {
    process.env['NEWSMONGER_FAKE_KEYCHAIN'] = '1';
    // The fake keychain is process-global, so a key saved by an earlier test
    // would otherwise make "was it stored?" assertions read the wrong state.
    __resetKeychainForTests();
  });

  it('saves a key the vendor accepts', async () => {
    const verifier = stubVerifier({ status: 'valid' });
    expect((await put(makeApp(verifier), 'sk-ant-good')).status).toBe(200);
    expect(verifier.calls).toEqual([{ provider: 'anthropic', key: 'sk-ant-good' }]);
  });

  it('rejects a key the vendor refuses, with the vendor’s reason', async () => {
    const res = await put(makeApp(stubVerifier({ status: 'invalid', message: 'Anthropic rejected that key.' })), 'oops');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Anthropic rejected that key.' });
  });

  it('does not store a key it just rejected', async () => {
    const app = makeApp(stubVerifier({ status: 'invalid', message: 'nope' }));
    await put(app, 'oops');
    const keys = (await (await app.request('/api/keys')).json()) as {
      keys: { provider: string; configured: boolean }[];
    };
    expect(keys.keys.find((k) => k.provider === 'anthropic')?.configured).toBe(false);
  });

  it('saves anyway when the check itself could not run', async () => {
    // Offline, proxied, or a vendor outage. Telling the user their key is wrong
    // because *we* couldn't reach the vendor would be the worse failure — it
    // sends them off to regenerate a key that was fine.
    const app = makeApp(stubVerifier({ status: 'unknown', message: 'Couldn’t reach Anthropic.' }));
    expect((await put(app, 'sk-ant-probably-fine')).status).toBe(200);
  });

  it('verifies the trimmed key, not the raw paste', async () => {
    const verifier = stubVerifier({ status: 'valid' });
    await put(makeApp(verifier), '  sk-ant-pasted \n');
    expect(verifier.calls[0]?.key).toBe('sk-ant-pasted');
  });

  it('skips the check entirely when no verifier is configured (--ai-test)', async () => {
    expect((await put(makeApp(null), 'obviously-fake')).status).toBe(200);
  });

  it('never reaches the vendor for an empty key', async () => {
    const verifier = stubVerifier({ status: 'valid' });
    expect((await put(makeApp(verifier), '   ')).status).toBe(400);
    expect(verifier.calls).toHaveLength(0);
  });
});
