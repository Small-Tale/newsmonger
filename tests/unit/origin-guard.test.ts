import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/index.js';
import { CheckRunner } from '../../src/checks.js';
import { hostAllowed, isLoopbackHostname, originAllowed } from '../../src/origin-guard.js';
import { createApp } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpStore } from '../helpers/tmp.js';

function makeApp() {
  const store = tmpStore();
  const runner = new CheckRunner(store, asResolver(createMockProvider()));
  return { app: createApp({ store, runner }), store };
}

describe('isLoopbackHostname', () => {
  it('accepts the names that mean this machine', () => {
    for (const h of ['localhost', 'LocalHost', '127.0.0.1', '::1', '[::1]']) {
      expect(isLoopbackHostname(h), h).toBe(true);
    }
  });

  it('accepts .localhost names, which RFC 6761 reserves for loopback', () => {
    // Tauri's webview origin on Windows and Linux.
    expect(isLoopbackHostname('tauri.localhost')).toBe(true);
  });

  it('rejects anything that could resolve elsewhere', () => {
    for (const h of ['evil.com', 'localhost.evil.com', 'notlocalhost', '10.0.0.1', '']) {
      expect(isLoopbackHostname(h), h).toBe(false);
    }
  });
});

describe('hostAllowed', () => {
  it('accepts the app’s own origins, with or without a port', () => {
    expect(hostAllowed('http://127.0.0.1:4187/api/state')).toBe(true);
    expect(hostAllowed('http://localhost/api/state')).toBe(true);
    expect(hostAllowed('http://[::1]:4187/api/state')).toBe(true);
  });

  it('rejects a rebound hostname pointed at loopback', () => {
    // The DNS-rebinding shape: attacker.example resolves to 127.0.0.1, so the
    // connection succeeds and the *browser* treats it as same-origin.
    expect(hostAllowed('http://rebind.evil.com:4187/api/state')).toBe(false);
  });

  it('rejects a host that only looks local', () => {
    expect(hostAllowed('http://localhost@evil.com/api/state')).toBe(false);
    expect(hostAllowed('http://evil.com/127.0.0.1')).toBe(false);
  });

  it('rejects an unparseable url', () => {
    expect(hostAllowed('not a url')).toBe(false);
  });
});

describe('originAllowed', () => {
  it('allows an absent Origin — not a cross-origin browser request', () => {
    expect(originAllowed(undefined)).toBe(true);
  });

  it('allows the app’s own origin', () => {
    expect(originAllowed('http://127.0.0.1:4187')).toBe(true);
    expect(originAllowed('http://localhost:4187')).toBe(true);
  });

  it('allows a Tauri webview origin', () => {
    expect(originAllowed('tauri://localhost')).toBe(true);
    expect(originAllowed('http://tauri.localhost')).toBe(true);
  });

  it('rejects a remote page', () => {
    expect(originAllowed('https://evil.com')).toBe(false);
    expect(originAllowed('http://localhost.evil.com')).toBe(false);
  });

  it('rejects an opaque origin', () => {
    // Sandboxed iframes and data: documents send the literal string "null".
    expect(originAllowed('null')).toBe(false);
  });

  it('rejects a non-web scheme and garbage', () => {
    expect(originAllowed('file://')).toBe(false);
    expect(originAllowed('¯\\_(ツ)_/¯')).toBe(false);
  });
});

describe('the guard, through the app', () => {
  it('serves a normal same-origin request', async () => {
    const { app } = makeApp();
    const res = await app.request('http://127.0.0.1:4187/api/state', {
      headers: { origin: 'http://127.0.0.1:4187' },
    });
    expect(res.status).toBe(200);
  });

  it('serves a request with no Origin (curl, the Tauri shell, tests)', async () => {
    const { app } = makeApp();
    expect((await app.request('/api/state')).status).toBe(200);
  });

  it('rejects a read from a page on another origin', async () => {
    const { app } = makeApp();
    const res = await app.request('http://127.0.0.1:4187/api/state', {
      headers: { origin: 'https://evil.com' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a cross-origin delete rather than acting on it', async () => {
    const { app, store } = makeApp();
    const topic = store.addTopic('kept');
    const res = await app.request(`http://127.0.0.1:4187/api/topics/${topic.id}`, {
      method: 'DELETE',
      headers: { origin: 'https://evil.com' },
    });
    expect(res.status).toBe(403);
    // The point of the guard: a no-CORS request the page can't read still
    // reaches the server, so it has to be refused before it takes effect.
    expect(store.listTopics()).toHaveLength(1);
  });

  it('rejects a cross-origin check, which would spend API credit', async () => {
    const { app, store } = makeApp();
    const topic = store.addTopic('costly');
    const before = store.listRuns(10).length;
    const res = await app.request('http://127.0.0.1:4187/api/check', {
      method: 'POST',
      headers: { origin: 'https://evil.com', 'content-type': 'application/json' },
      body: JSON.stringify({ topicId: topic.id }),
    });
    expect(res.status).toBe(403);
    expect(store.listRuns(10)).toHaveLength(before);
  });

  it('rejects a rebound Host even when no Origin is sent', async () => {
    const { app } = makeApp();
    expect((await app.request('http://rebind.evil.com/api/state')).status).toBe(403);
  });

  it('guards the page and static assets too, not just /api', async () => {
    const { app } = makeApp();
    const res = await app.request('http://rebind.evil.com/');
    expect(res.status).toBe(403);
  });
});
