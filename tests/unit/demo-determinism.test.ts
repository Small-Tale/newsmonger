import type { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { demoKeysResponse, demoProbeProviders } from '../../src/ai/providers/demo.js';
import { createMockProvider } from '../../src/ai/providers/index.js';
import { AUTO_ORDER, KEYED_PROVIDERS, PROVIDER_NAMES } from '../../src/ai/types.js';
import { KeysRespSchema, ProvidersRespSchema } from '../../src/api/schemas.js';
import { CheckRunner } from '../../src/checks.js';
import { sourceStatus } from '../../src/client/source-status.js';
import { Store } from '../../src/db/store.js';
import { createApp } from '../../src/server.js';
import type { AppEnv } from '../../src/types.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

/**
 * `--demo` must photograph the app, not the machine holding the camera (NEWS-315).
 *
 * `assets/stills/*.png` are tracked binaries and function as documentation of
 * the UI, so a regeneration on a different laptop must produce the same image.
 * `settings-source.png` did not: it read *"ready — via Claude subscription
 * (Claude Code)"* on the owner's machine and would read *"no provider is signed
 * in or keyed"* on one with nothing configured.
 *
 * It was deterministic by accident until NEWS-308, which is why nothing caught
 * it — before then the status line rendered blank on the default `auto` setting,
 * so there was nothing to vary. That is the argument for testing this at all:
 * the property held for a year without anything asserting it, and stopped
 * holding because of a change to a different file.
 *
 * **Two environmental inputs, not one.** The ticket named the provider probe.
 * The same screenshot also renders `GET /api/keys` — which key is configured,
 * where it came from, and what the OS calls its credential store — and that was
 * varying too. Hence the env-var assertions below: setting `ANTHROPIC_API_KEY`
 * is the cheapest way to make the machine "different" inside one test run, and
 * it is the exact difference that would have changed the picture.
 */

function demoApp() {
  const store = new Store(tmpDataDir());
  const runner = new CheckRunner(store, asResolver(createMockProvider()));
  return createApp({ store, runner, probe: demoProbeProviders, demoKeys: demoKeysResponse() });
}

/** GET a route and validate the body, so nothing downstream is `any`. */
async function get<T>(app: Hono<AppEnv>, path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await (await app.request(path)).json());
}

/** Run `fn` with an API key exported, then put the environment back. */
async function withEnvKey<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env['ANTHROPIC_API_KEY'];
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-not-a-real-key';
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = before;
  }
}

describe('the demo provider probe (NEWS-315)', () => {
  it('reports exactly one provider available', async () => {
    const probed = await demoProbeProviders();
    expect(probed.filter((p) => p.available).map((p) => p.name)).toEqual(['anthropic']);
  });

  it('covers every provider the picker can show', async () => {
    // A demo probe that answered for a subset would silently drop a row from the
    // Settings dropdown in every screenshot — the picker would be photographed
    // shorter than it really is. `auto` is excluded because it is the *absence*
    // of a choice and is added by the route, not the probe.
    const probed = await demoProbeProviders();
    const concrete = PROVIDER_NAMES.filter((n) => n !== 'auto');
    expect(probed.map((p) => p.name).sort()).toEqual([...concrete].sort());
  });

  it('resolves to a named provider under the default `auto` setting', async () => {
    // The whole point: the status line's most informative state. `unknown` and
    // `none-usable` both render something a README should not be advertising.
    const probed = await demoProbeProviders();
    const providers = [{ name: 'auto' as const, label: 'Auto', endpointConfigurable: false, available: null }, ...probed];
    expect(sourceStatus(providers, 'auto')).toEqual({ kind: 'ready', via: 'anthropic' });
    // And the provider it names is one `resolveProvider` would actually pick,
    // rather than a label invented for the screenshot.
    expect(AUTO_ORDER).toContain('anthropic');
  });
});

describe('the demo API-key panel (NEWS-315)', () => {
  it('reports no key configured, whatever the machine has', () => {
    const resp = demoKeysResponse();
    expect(resp.keys.map((k) => k.provider).sort()).toEqual([...KEYED_PROVIDERS].sort());
    expect(resp.keys.every((k) => !k.configured && k.source === null)).toBe(true);
    expect(resp.keychainAvailable).toBe(true);
    // Pinned rather than platform-derived: `keychainLabel()` answers "System
    // Keyring" on Linux and "Credential Manager" on Windows, and the sentence
    // under the key fields quotes it.
    expect(resp.keychainLabel).toBe('Keychain');
  });
});

describe('the demo server answers the same on any machine (NEWS-315)', () => {
  it('/api/providers ignores the environment', async () => {
    const app = demoApp();
    const plain = await get(app, '/api/providers', ProvidersRespSchema);
    const keyed = await withEnvKey(() => get(app, '/api/providers', ProvidersRespSchema));
    expect(plain).toEqual(keyed);
  });

  it('/api/keys ignores the environment', async () => {
    const app = demoApp();
    const plain = await get(app, '/api/keys', KeysRespSchema);
    const keyed = await withEnvKey(() => get(app, '/api/keys', KeysRespSchema));
    expect(plain).toEqual(keyed);
    // Not vacuously equal — assert the content the still shows, so a demo
    // response that started answering "configured" in both runs would fail here
    // rather than pass the equality above.
    expect(plain.keys.every((k) => !k.configured)).toBe(true);
  });

  it('does not leak the fixture into an ordinary server', async () => {
    // The other direction, and the one that would make every real install wrong:
    // the demo answers are opt-in dependencies, and a default that pointed at
    // them would tell a user with a working key that they have none. It is also
    // what proves the two tests above are measuring something — the environment
    // really does change this response.
    const store = new Store(tmpDataDir());
    const app = createApp({ store, runner: new CheckRunner(store, asResolver(createMockProvider())) });
    const keys = await get(app, '/api/keys', KeysRespSchema);
    const configured = await withEnvKey(() => get(app, '/api/keys', KeysRespSchema));
    expect(keys.keys.find((k) => k.provider === 'anthropic')?.configured).toBe(false);
    expect(configured.keys.find((k) => k.provider === 'anthropic')?.configured).toBe(true);
  });
});
