import { spawn } from 'node:child_process';
import fs from 'node:fs';

import type { Hono } from 'hono';
import type { z } from 'zod';

import { deleteApiKey, resolveApiKey, saveApiKey } from '../ai/api-keys.js';
import { probeProviders } from '../ai/providers/index.js';
import { isKeyedProvider, KEY_ENV_VARS, KEYED_PROVIDERS, PROVIDER_INFO } from '../ai/types.js';
import type { KeysResp, ProvidersResp, StateResp } from '../api/schemas.js';
import {
  CheckReqSchema,
  CreateTopicReqSchema,
  OpenExternalReqSchema,
  SaveKeyReqSchema,
  UpdateSettingsReqSchema,
  UpdateTopicReqSchema,
} from '../api/schemas.js';
import { cachedImagePath, isValidHash, liveImageHashes, pruneImageCache, sniffImageType } from '../images/index.js';
import { isKeychainAvailable, keychainLabel } from '../keychain.js';
import type { AppEnv } from '../types.js';

async function parseBody<T extends z.ZodType>(c: { req: { json(): Promise<unknown> } }, schema: T): Promise<z.infer<T> | null> {
  try {
    const body: unknown = await c.req.json();
    const result = schema.safeParse(body);
    return result.success ? (result.data) : null;
  } catch {
    return null;
  }
}

export function registerApi(app: Hono<AppEnv>): void {
  app.get('/api/state', (c) => {
    const store = c.get('store');
    const runner = c.get('runner');
    const settings = store.getSettings();
    const state: StateResp = {
      topics: store.listTopics(),
      items: store.listItems(),
      settings,
      runs: store.listRuns(20),
      checking: runner.checking(),
    };
    return c.json(state);
  });

  // Providers + availability, for the settings picker. Probing is cheap today
  // (key presence), but kept out of the 4s /api/state poll on purpose.
  app.get('/api/providers', async (c) => {
    const { model, endpoint } = c.get('store').getSettings();
    const probed = await probeProviders({ model, endpoint });
    const resp: ProvidersResp = {
      providers: [
        { name: 'auto', label: 'Auto', endpointConfigurable: false, available: null },
        ...probed.map((p) => ({ ...p, available: p.available })),
      ],
    };
    return c.json(resp);
  });

  app.post('/api/topics', async (c) => {
    const body = await parseBody(c, CreateTopicReqSchema);
    if (!body) return c.json({ error: 'invalid request: expected { name }' }, 400);
    try {
      const topic = c.get('store').addTopic(body.name);
      return c.json(topic, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  app.patch('/api/topics/:id', async (c) => {
    const body = await parseBody(c, UpdateTopicReqSchema);
    if (!body) return c.json({ error: 'invalid request: expected { paused }' }, 400);
    try {
      const topic = c.get('store').setTopicPaused(c.req.param('id'), body.paused);
      return c.json(topic);
    } catch {
      return c.json({ error: 'no such topic' }, 404);
    }
  });

  app.delete('/api/topics/:id', (c) => {
    const store = c.get('store');
    try {
      store.deleteTopic(c.req.param('id'));
    } catch {
      return c.json({ error: 'no such topic' }, 404);
    }
    // The topic's stories are gone; drop any image now referenced by nothing
    // (a shared image survives via liveImageHashes). Best-effort — a failed
    // prune must not fail the delete.
    pruneImageCache(c.get('dataDir'), liveImageHashes(store.listItems()));
    return c.json({ ok: true });
  });

  app.patch('/api/settings', async (c) => {
    const body = await parseBody(c, UpdateSettingsReqSchema);
    if (!body) return c.json({ error: 'invalid request: expected { checkIntervalMs >= 5 minutes }' }, 400);
    return c.json(c.get('store').updateSettings(body));
  });

  app.post('/api/check', async (c) => {
    const body = await parseBody(c, CheckReqSchema);
    if (!body) return c.json({ error: 'invalid request' }, 400);
    const store = c.get('store');
    const runner = c.get('runner');
    if (body.topicId !== undefined) {
      if (!store.getTopic(body.topicId)) return c.json({ error: 'no such topic' }, 404);
      void runner.checkTopic(body.topicId, { manual: true }).catch((err: unknown) => {
        console.error('news: check failed:', err);
      });
      return c.json({ started: [body.topicId] });
    }
    const started = store
      .listTopics()
      .filter((t) => !t.paused)
      .map((t) => t.id);
    void runner.checkAll().catch((err: unknown) => {
      console.error('news: check-all failed:', err);
    });
    return c.json({ started });
  });

  /**
   * Serve a cached article image.
   *
   * Reads from the cache only — it never fetches a URL on request. That's the
   * whole point: an endpoint that fetched whatever it was pointed at would be
   * an open proxy sitting on the user's machine. Images enter the cache during
   * a check, from URLs vetted in `src/images/safety.ts`.
   */
  app.get('/api/image/:hash', (c) => {
    const hash = c.req.param('hash');
    // Validating the shape is also what makes the path join safe — a hash can
    // never contain a separator or a `..`.
    if (!isValidHash(hash)) return c.json({ error: 'bad image id' }, 400);

    const file = cachedImagePath(c.get('dataDir'), hash);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      return c.json({ error: 'no such image' }, 404);
    }
    // `new Uint8Array(...)` rather than the Buffer itself: Hono's body() types
    // reject Buffer's ArrayBufferLike union (it may be a SharedArrayBuffer).
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': sniffImageType(bytes),
      // Content-addressed, so it can never go stale.
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });

  // Foreground heartbeat. The client posts this only while the app is visible
  // AND focused; scheduled checks on a subscription-backed provider won't run
  // without a recent one (see src/attendance.ts).
  //
  // Deliberately its own endpoint rather than a flag inferred from the 4 s
  // /api/state poll: that poll is just an HTTP request, so a stray curl would
  // otherwise read as "a person is watching".
  app.post('/api/foreground', (c) => {
    c.get('attendance').record();
    return c.json({ ok: true });
  });

  // API keys. Values are write-only: they go in on PUT and are never returned
  // by any route here, so a key can't leak back through the polling client.
  app.get('/api/keys', async (c) => {
    const [available, keys] = await Promise.all([
      isKeychainAvailable(),
      Promise.all(
        KEYED_PROVIDERS.map(async (provider) => {
          const { source } = await resolveApiKey(provider);
          return {
            provider,
            label: PROVIDER_INFO[provider].label,
            configured: source !== null,
            source,
            envVar: KEY_ENV_VARS[provider],
          };
        }),
      ),
    ]);
    const resp: KeysResp = { keys, keychainAvailable: available, keychainLabel: keychainLabel() };
    return c.json(resp);
  });

  app.put('/api/keys/:provider', async (c) => {
    const provider = c.req.param('provider');
    if (!isKeyedProvider(provider)) return c.json({ error: 'no such provider' }, 404);
    if (!(await isKeychainAvailable())) {
      return c.json(
        { error: `No ${keychainLabel()} is available on this machine — set ${KEY_ENV_VARS[provider]} instead.` },
        503,
      );
    }
    const body = await parseBody(c, SaveKeyReqSchema);
    if (!body) return c.json({ error: 'invalid request: expected { key }' }, 400);
    const key = body.key.trim();
    if (key === '') return c.json({ error: 'invalid request: expected { key }' }, 400);
    try {
      await saveApiKey(provider, key);
    } catch (err: unknown) {
      // The keychain tool's own message, which names the real problem (locked
      // keyring, denied prompt). It describes the failure, never the value.
      return c.json({ error: `Could not save the key: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
    return c.json({ ok: true });
  });

  app.delete('/api/keys/:provider', async (c) => {
    const provider = c.req.param('provider');
    if (!isKeyedProvider(provider)) return c.json({ error: 'no such provider' }, 404);
    await deleteApiKey(provider);
    return c.json({ ok: true });
  });

  // Opens a URL in the system browser — used by the Tauri webview, where
  // target="_blank" links have nowhere to go.
  app.post('/api/open-external', async (c) => {
    const body = await parseBody(c, OpenExternalReqSchema);
    if (!body) return c.json({ error: 'invalid request: expected { url }' }, 400);
    let parsed: URL;
    try {
      parsed = new URL(body.url);
    } catch {
      return c.json({ error: 'invalid url' }, 400);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return c.json({ error: 'only http(s) urls can be opened' }, 400);
    }
    openInBrowser(parsed.toString());
    return c.json({ ok: true });
  });

  app.get('/healthz', (c) => c.json({ ok: true }));
}

export function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}
