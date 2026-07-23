import { spawn } from 'node:child_process';

import type { Hono } from 'hono';
import type { z } from 'zod';

import { probeProviders } from '../ai/providers/index.js';
import type { ProvidersResp, StateResp } from '../api/schemas.js';
import {
  CheckReqSchema,
  CreateTopicReqSchema,
  OpenExternalReqSchema,
  UpdateSettingsReqSchema,
  UpdateTopicReqSchema,
} from '../api/schemas.js';
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
    try {
      c.get('store').deleteTopic(c.req.param('id'));
      return c.json({ ok: true });
    } catch {
      return c.json({ error: 'no such topic' }, 404);
    }
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
      void runner.checkTopic(body.topicId).catch((err: unknown) => {
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
