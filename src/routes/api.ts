import { spawn } from 'node:child_process';
import fs from 'node:fs';

import type { Context, Hono } from 'hono';
import type { z } from 'zod';

import { deleteApiKey, resolveApiKey, saveApiKey } from '../ai/api-keys.js';
import { probeProviders } from '../ai/providers/index.js';
import { isKeyedProvider, KEY_ENV_VARS, KEYED_PROVIDERS, PROVIDER_INFO } from '../ai/types.js';
import type { ItemsResp, KeysResp, ProvidersResp, StateResp } from '../api/schemas.js';
import {
  CheckReqSchema,
  CreateTopicReqSchema,
  DiscoverReqSchema,
  OpenExternalReqSchema,
  SaveItemReqSchema,
  SaveKeyReqSchema,
  UpdateSettingsReqSchema,
  UpdateTopicReqSchema,
} from '../api/schemas.js';
import { normalizeBackupDir, suggestedBackupLocations } from '../backup-locations.js';
import { toAtom, toJson, toMarkdown } from '../export.js';
import { cachedImagePath, isValidHash, liveImageHashes, pruneImageCache, sniffImageType } from '../images/index.js';
import { isKeychainAvailable, keychainLabel } from '../keychain.js';
import type { AppEnv } from '../types.js';
import { appVersion } from '../version.js';

async function parseBody<T extends z.ZodType>(c: { req: { json(): Promise<unknown> } }, schema: T): Promise<z.infer<T> | null> {
  try {
    const body: unknown = await c.req.json();
    const result = schema.safeParse(body);
    return result.success ? (result.data) : null;
  } catch {
    return null;
  }
}

/**
 * Ceiling on one export or feed (NEWS-85). Generous for a document, bounded so
 * an install with a year of retained stories can't build a 40 MB response.
 */
const EXPORT_LIMIT = 2000;

export function registerApi(app: Hono<AppEnv>): void {
  app.get('/api/state', (c) => {
    const store = c.get('store');
    const runner = c.get('runner');
    const settings = store.getSettings();
    const state: StateResp = {
      topics: store.listTopics(),
      latestItemIds: store.latestItemIds(50),
      flaggedByTopic: store.flaggedCountsByTopic(),
      settings,
      runs: store.listRuns(20),
      checking: runner.checking(),
      appVersion: appVersion(),
    };
    return c.json(state);
  });

  // A page of the feed (server-side pagination, NEWS-74). Filters + sorts +
  // cursor-paginates server-side so the payload is bounded and correct for
  // every view. `/api/state` still carries items for now; the client moves to
  // this endpoint in phase 2 (NEWS-75).
  app.get('/api/items', (c) => {
    const limit = Math.min(200, Math.max(1, Number.parseInt(c.req.query('limit') ?? '100', 10) || 100));
    const mode = c.req.query('mode') === 'review' ? 'review' : 'normal';
    const topicIds = (c.req.query('topics') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const beforeAt = c.req.query('beforeAt');
    const beforeId = c.req.query('beforeId');
    const before = beforeAt !== undefined && beforeId !== undefined ? { foundAt: beforeAt, id: beforeId } : null;
    const resp: ItemsResp = c.get('store').queryItems({
      mode,
      topicIds,
      saved: c.req.query('saved') === '1',
      q: c.req.query('q') ?? '',
      category: c.req.query('category'),
      subcategory: c.req.query('subcategory'),
      limit,
      before,
    });
    return c.json(resp);
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
    let topic;
    try {
      topic = c.get('store').addTopic(body.name, {
        guidance: body.guidance,
        category: body.category,
        subcategory: body.subcategory,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
    // Check the new topic right away rather than leaving it for the next
    // scheduler tick (up to a minute out) — the user just added it and is
    // watching for the first results. Treated as a *manual* check: it records
    // attendance and so runs ungated even for a subscription provider (the user
    // is plainly present), matching the Check-now buttons. Fired in the
    // background so the response returns immediately; the client's /api/state
    // poll surfaces the in-flight state and then the items. The in-flight guard
    // means a scheduler tick that also finds this topic due won't double-run it.
    void c.get('runner').checkTopic(topic.id, { manual: true }).catch((err: unknown) => {
      console.error('newsmonger: initial check failed:', err);
    });
    return c.json(topic, 201);
  });

  app.patch('/api/topics/:id', async (c) => {
    const body = await parseBody(c, UpdateTopicReqSchema);
    if (!body) {
      return c.json(
        { error: 'invalid request: expected { name?, clearItems?, paused?, highPriority?, guidance?, category?, subcategory? }' },
        400,
      );
    }
    const store = c.get('store');
    const id = c.req.param('id');
    try {
      let topic;
      // Rename first, so a name collision rejects before anything else is
      // written — a 409 that had already cleared the stories would be the worst
      // possible outcome of this route (NEWS-139).
      if (body.name !== undefined) {
        topic = store.renameTopic(id, body.name);
        // Stash what was removed so the client can offer an undo (NEWS-145).
        // Only on a clear that actually took something: remembering an empty
        // snapshot would put a live "Undo" on a clear that did nothing.
        if (body.clearItems === true) {
          const cleared = store.clearItemsForTopic(id);
          if (cleared.items.length > 0) c.get('undo').remember(id, cleared);
        }
      }
      if (body.paused !== undefined) topic = store.setTopicPaused(id, body.paused);
      if (body.highPriority !== undefined) topic = store.setTopicHighPriority(id, body.highPriority);
      if (body.guidance !== undefined) topic = store.setTopicGuidance(id, body.guidance);
      // Always `manual`: this route only runs because a person chose something,
      // and that is exactly what automatic classification must not overwrite
      // (FR-22.7). Clearing the category resets the source too, so a cleared
      // topic becomes eligible for automatic classification again.
      if (body.category !== undefined) {
        topic = store.setTopicCategory(
          id,
          body.category,
          body.category === null ? null : (body.subcategory ?? null),
          body.category === null ? 'auto' : 'manual',
        );
      }
      return c.json(topic);
    } catch (err) {
      // A duplicate name is a conflict the user can act on, not a missing
      // topic — surfacing it as 404 would send them looking for the wrong thing.
      const message = err instanceof Error ? err.message : '';
      if (message.includes('already exists') || message.includes('must not be empty')) {
        return c.json({ error: message }, 409);
      }
      return c.json({ error: 'no such topic' }, 404);
    }
  });

  /**
   * Put back the stories a clear removed (NEWS-145).
   *
   * A separate route rather than a `PATCH` flag: this is not an edit to the
   * topic, it is the reversal of one, and it must not be reachable by accident
   * from a request that meant to rename something.
   *
   * **410, not 404**, when the window has passed. The topic is right there — the
   * thing that is gone is the offer, and a 404 would say the wrong one expired.
   */
  app.post('/api/topics/:id/restore-cleared', (c) => {
    const id = c.req.param('id');
    const store = c.get('store');
    // Checked explicitly, and before the snapshot is consumed. `items` has no
    // foreign key on `topic_id`, so restoring into a topic that was deleted
    // while the undo was on offer would silently insert rows belonging to
    // nothing — invisible in the feed, and counted by every aggregate.
    if (store.getTopic(id) === undefined) return c.json({ error: 'no such topic' }, 404);
    const cleared = c.get('undo').take(id);
    if (cleared === null) return c.json({ error: 'nothing to restore' }, 410);
    return c.json({ restored: store.restoreClearedItems(id, cleared) });
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

  app.patch('/api/items/:id', async (c) => {
    const body = await parseBody(c, SaveItemReqSchema);
    if (!body) return c.json({ error: 'invalid request: expected { saved?, offTopic? }' }, 400);
    const store = c.get('store');
    const id = c.req.param('id');
    let item = null;
    if (body.saved !== undefined) item = store.setItemSaved(id, body.saved);
    if (body.offTopic !== undefined) item = store.setItemOffTopic(id, body.offTopic);
    if (item === null) return c.json({ error: 'no such item' }, 404);
    return c.json({ ok: true });
  });

  app.patch('/api/settings', async (c) => {
    const body = await parseBody(c, UpdateSettingsReqSchema);
    if (!body) return c.json({ error: 'invalid request: expected { checkIntervalMs >= 5 minutes }' }, 400);
    // Resolve the backup folder here rather than storing what was typed
    // (NEWS-237): `~` and relative paths both otherwise *succeed* into somewhere
    // the user did not ask for. Normalizing at the boundary means Settings reads
    // back the path that will actually be written to.
    if (body.backupDir !== undefined) {
      const resolved = normalizeBackupDir(body.backupDir);
      if (!resolved.ok) return c.json({ error: resolved.error }, 400);
      body.backupDir = resolved.dir;
    }
    return c.json(c.get('store').updateSettings(body));
  });

  /**
   * Sync folders that actually exist on this machine (NEWS-230, FR-27.5).
   *
   * Its own route rather than a field on `/api/state`: this touches the
   * filesystem, and `/api/state` is polled every 4 seconds. Probing a handful of
   * directories fifteen times a minute forever, to answer a question asked once,
   * is the wrong shape. The prompt fetches it when it opens.
   */
  app.get('/api/backup/locations', (c) => c.json({ locations: suggestedBackupLocations() }));

  /**
   * Write a backup snapshot right now (NEWS-192, FR-27.9).
   *
   * Bypasses the interval throttle on purpose: this route only runs because a
   * person clicked "Back up now", and "nothing happened, try again in an hour"
   * is not an acceptable answer to a button press.
   */
  app.post('/api/backup', (c) => {
    const backups = c.get('backups');
    if (!backups) return c.json({ error: 'backups are not configured' }, 503);
    if (c.get('store').getSettings().backupDir === '') {
      return c.json({ error: 'no backup folder chosen' }, 400);
    }
    const at = backups.write();
    if (at === null) return c.json({ error: 'backup failed; see the server log' }, 500);
    return c.json({ ok: true, path: at });
  });

  app.post('/api/check', async (c) => {
    const body = await parseBody(c, CheckReqSchema);
    if (!body) return c.json({ error: 'invalid request' }, 400);
    const store = c.get('store');
    const runner = c.get('runner');
    if (body.topicId !== undefined) {
      if (!store.getTopic(body.topicId)) return c.json({ error: 'no such topic' }, 404);
      void runner.checkTopic(body.topicId, { manual: true }).catch((err: unknown) => {
        console.error('newsmonger: check failed:', err);
      });
      return c.json({ started: [body.topicId] });
    }
    const started = store
      .listTopics()
      .filter((t) => !t.paused)
      .map((t) => t.id);
    void runner.checkAll().catch((err: unknown) => {
      console.error('newsmonger: check-all failed:', err);
    });
    return c.json({ started });
  });

  /**
   * Ask for topic suggestions (NEWS-125, `docs/24-topic-discovery.md`).
   *
   * Every call here costs money or plan quota, and unlike a check nothing
   * upstream bounds how often it can be made — so the guards that keep it
   * affordable all live on this path: the round ceiling is in the schema
   * (FR-24.9), repeat requests are served from the cache (FR-24.15), and the
   * call is recorded either way (FR-24.14).
   */
  app.post('/api/discover', async (c) => {
    const body = await parseBody(c, DiscoverReqSchema);
    if (!body) return c.json({ error: 'invalid request: expected { scope, limit? }' }, 400);
    const discovery = c.get('discovery');
    if (!discovery) return c.json({ error: 'topic discovery is not available' }, 503);
    try {
      const result = await discovery.suggest(body.scope, body.limit, body.seen);
      return c.json(result);
    } catch (err) {
      // The provider failing is an ordinary outcome here (no key, offline, rate
      // limited), not a server fault — the message is what the user needs to see.
      return c.json({ error: err instanceof Error ? err.message : 'topic discovery failed' }, 502);
    }
  });

  /**
   * What discovery has spent this process lifetime (FR-24.14).
   *
   * Its own endpoint rather than a field on `/api/state`, which NEWS-75/76
   * deliberately slimmed — a list that grows with usage does not belong on a
   * payload polled every 4 seconds.
   */
  app.get('/api/discover/usage', (c) => {
    const discovery = c.get('discovery');
    if (!discovery) return c.json({ calls: 0, recent: [] });
    return c.json({ calls: discovery.callCount(), recent: discovery.recentCalls() });
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
    // Check the key with the vendor before storing it (NEWS-78), so a typo
    // surfaces now rather than as a failed check hours later. Only an
    // *authentication* failure blocks the save: an offline machine or a vendor
    // outage must not be reported to the user as a bad key.
    const verifyKey = c.get('verifyKey');
    if (verifyKey !== null) {
      const verdict = await verifyKey(provider, key);
      if (verdict.status === 'invalid') return c.json({ error: verdict.message }, 400);
    }
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

  /**
   * Export the current selection, or serve it as an Atom feed (NEWS-85).
   *
   * `scope=all|saved|topic&topic=<id>` mirrors the feed's own views. The
   * **feed** deliberately has no `Origin`-bearing caller — a desktop RSS reader
   * is not a browser page — so the cross-origin guard's "absent Origin is
   * allowed" rule (FR-4.5a) is exactly what lets a reader subscribe while a web
   * page still can't read it.
   */
  const exportHandler = (kind: 'md' | 'json' | 'atom') => (c: Context<AppEnv>) => {
    const store = c.get('store');
    const scope = c.req.query('scope') ?? 'all';
    const topicId = c.req.query('topic') ?? '';
    const all = store.listItems().filter((i) => !i.offTopic);
    const items = all
      .filter((i) => (scope === 'saved' ? i.saved : true))
      .filter((i) => (scope === 'topic' && topicId !== '' ? i.topicId === topicId : true))
      .sort((a, b) => (a.foundAt < b.foundAt ? 1 : a.foundAt > b.foundAt ? -1 : 0))
      .slice(0, EXPORT_LIMIT);
    const topics = store.listTopics();
    const label =
      scope === 'saved'
        ? 'Saved stories'
        : scope === 'topic'
          ? (topics.find((t) => t.id === topicId)?.name ?? 'Unknown topic')
          : 'All stories';
    const input = {
      items,
      topics,
      title: label,
      baseUrl: new URL(c.req.url).origin,
      now: new Date(),
    };
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (kind === 'atom') {
      return c.body(toAtom(input), 200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
    }
    if (kind === 'json') {
      return c.body(toJson(input), 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="newsmonger-${slug}.json"`,
      });
    }
    return c.body(toMarkdown(input), 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="newsmonger-${slug}.md"`,
    });
  };

  app.get('/api/export.md', exportHandler('md'));
  app.get('/api/export.json', exportHandler('json'));
  app.get('/feed.xml', exportHandler('atom'));

  app.get('/healthz', (c) => c.json({ ok: true }));
}

export function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}
