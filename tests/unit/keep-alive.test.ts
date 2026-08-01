import http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createMockProvider } from '../../src/ai/providers/mock.js';
import { CheckRunner } from '../../src/checks.js';
import { POLL_INTERVAL_MS } from '../../src/client/poll.js';
import { Store } from '../../src/db/store.js';
import { createApp, startServer } from '../../src/server.js';
import { asResolver } from '../helpers/provider.js';
import { tmpDataDir } from '../helpers/tmp.js';

/**
 * The socket-churn bug (NEWS-246).
 *
 * Node holds an idle connection for **5 seconds** by default, and the client
 * asks again every **4** (`POLL_INTERVAL_MS`). One second between "we will keep
 * this socket" and "we will ask again" is not headroom: any jitter and the
 * server has already closed it, so the next poll opens a fresh TCP connection
 * and leaves the old one in `TIME_WAIT`.
 *
 * Measured on the E2E suite before this: **457 sockets in `TIME_WAIT`** at peak
 * against 14 established. macOS releases them after 30 s; Windows takes **120**,
 * four times the backlog from the same rate — which is how a Windows CI runner
 * reaches `ERR_NO_BUFFER_SPACE` on a `page.goto` while every other platform is
 * fine and the app looks blameless.
 */

const servers: { close(): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function start() {
  const store = new Store(tmpDataDir());
  const runner = new CheckRunner(store, asResolver(createMockProvider()));
  // Port 0 — the OS picks a free one, so these never collide with a dev server
  // or with each other.
  const server = await startServer(createApp({ store, runner }), { port: 0, strictPort: true });
  servers.push(server);
  return server;
}

describe('server keep-alive (NEWS-246)', () => {
  it('holds an idle connection far longer than the client waits between polls', async () => {
    const server = await start();
    // The relationship is the point, not the number: whatever the poll interval
    // becomes, the keep-alive window has to clear it by a margin jitter cannot
    // close. Asserting `=== 30_000` would pass while someone quietly moved the
    // poll to 25 s and put the bug straight back.
    expect(server.keepAliveTimeoutMs).toBeGreaterThan(POLL_INTERVAL_MS * 4);
  });

  it('actually reuses one connection across several requests', async () => {
    // The property that matters, exercised end to end rather than inferred from
    // a setting: an agent with `keepAlive` should serve three requests over one
    // socket. If the server hung up between them this would open three.
    const server = await start();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const sockets = new Set<string>();
    const get = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: server.port, path: '/healthz', agent }, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        req.on('socket', (s) => {
          s.on('connect', () => sockets.add(`${String(s.localAddress)}:${String(s.localPort)}`));
        });
        req.on('error', reject);
      });
    await get();
    await get();
    await get();
    agent.destroy();
    expect(sockets.size, 'three requests should share one connection').toBe(1);
  });
});
