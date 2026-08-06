import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CHECKOUT_ROOT,
  E2E_MAX_WORKERS,
  E2E_REAL_SERVER,
  E2E_SERVER,
  e2ePort,
  e2ePortFor,
  e2eWorkerRole,
  PORT_RANGE_START,
  PORT_SLOTS,
  PORTS_PER_CHECKOUT,
} from '../helpers/e2e-port.js';

/**
 * The E2E ports are derived per checkout (NEWS-287).
 *
 * A wrong answer here is not a wrong number — it is three failed gate runs and a
 * red assertion in an unrelated spec. Two worktrees sharing a port produced
 * exactly that during the NEWS-280/281 work: one run died on "already used", a
 * sibling died on `ECONNREFUSED` when the other's teardown killed the server
 * mid-file, and a NEWS-238 assertion went red for a reason that had nothing to
 * do with NEWS-238.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

/**
 * `read`, with whole-line comments removed.
 *
 * Both files explain at length *which* constants used to be there, so a bare
 * `not.toContain('4189')` reads the explanation as the configuration and fails a
 * correct file. Same trick, and the same reason, as `release-scripts.test.ts`.
 */
const code = (rel: string): string =>
  read(rel)
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

describe('the E2E port is derived from the checkout path (NEWS-287)', () => {
  it('gives two checkouts different ports', () => {
    // The whole point: a worktree under `.claude/worktrees/` and the main
    // checkout must not fight over one port.
    const main = e2ePortFor('/Users/dev/Documents/news');
    const worktree = e2ePortFor('/Users/dev/Documents/news/.claude/worktrees/agent-a69f08a56b5f9565e');
    expect(worktree).not.toBe(main);
  });

  it('is stable across calls for one path', () => {
    // Stability is load-bearing, not cosmetic. `scripts/e2e-preflight.mjs`
    // concludes "a holder on this port belongs to this checkout" — which is only
    // true if the port does not wander between runs.
    const first = e2ePortFor('/Users/dev/Documents/news');
    for (let i = 0; i < 5; i++) expect(e2ePortFor('/Users/dev/Documents/news')).toBe(first);
  });

  it('treats paths that name the same directory as the same checkout', () => {
    // A trailing separator or a `.` segment is the same checkout, and a run
    // invoked with either spelling must land on the same port — otherwise the
    // pre-flight's stale-server logic looks at the wrong port.
    const canonical = e2ePortFor('/Users/dev/Documents/news');
    expect(e2ePortFor('/Users/dev/Documents/news/')).toBe(canonical);
    expect(e2ePortFor('/Users/dev/Documents/news/./')).toBe(canonical);
    expect(e2ePortFor('/Users/dev/Documents/tmp/../news')).toBe(canonical);
  });

  it('separates the checkouts this repo actually has', () => {
    // The real ones, not invented ones: the main checkout and the two agent
    // worktrees `git worktree list` reports. Those are the paths that were
    // fighting over 4189.
    const paths = [
      '/Users/westphal/Documents/news',
      '/Users/westphal/Documents/news/.claude/worktrees/agent-a69f08a56b5f9565e',
      '/Users/westphal/Documents/news/.claude/worktrees/agent-adc9484102d817300',
    ];
    const ports = paths.map((p) => e2ePortFor(p));
    expect(new Set(ports).size, `collision among ${ports.join(', ')}`).toBe(paths.length);
  });

  it('distributes across the window instead of clustering', () => {
    // The honest version of "no collisions": a hash over `PORT_SLOTS` cannot be
    // injective, so what matters is that it spreads. 1000 paths over the slots
    // should fill nearly all of them; a derivation that clustered — a weak mix,
    // or a length-sensitive one — would fill far fewer, which is what would make
    // two sibling worktree paths collide in practice.
    //
    // Stated as a fraction of `PORT_SLOTS` rather than as a number (NEWS-321):
    // it was `> 340`, written when there were 400 slots, and sharding cut them
    // to 160 to pay for a port per worker. A literal threshold turns a
    // deliberate constant change into a puzzling test failure.
    const ports = new Set(Array.from({ length: 1000 }, (_, i) => e2ePortFor(`/Users/dev/checkout-${i}`)));
    expect(ports.size).toBeGreaterThan(PORT_SLOTS * 0.85);
  });

  it('keeps every port inside the documented window, clear of the app default', () => {
    // 4187 is the app's own default (FR-4.x). A derived port that landed on it
    // would have E2E fighting the developer's own running app.
    for (let i = 0; i < 400; i++) {
      const port = e2ePortFor(`/Users/dev/checkout-${i}`);
      expect(port).toBeGreaterThanOrEqual(PORT_RANGE_START);
      expect(port).toBeLessThan(PORT_RANGE_START + PORT_SLOTS * PORTS_PER_CHECKOUT);
      expect(port, 'must never collide with the app default').not.toBe(4187);
    }
  });

  it('reserves a window per checkout, so one checkout cannot land on another', () => {
    // The bug the window prevents: with one port each and `+1` for the second
    // server, checkout A's real-provider port is checkout B's shared port
    // whenever their slots are adjacent — a collision created by the scheme meant
    // to remove them. Roles therefore live inside a stride, and the shared port is
    // always the even end of it.
    for (let i = 0; i < 200; i++) {
      const p = `/Users/dev/checkout-${i}`;
      expect(e2ePortFor(p, E2E_REAL_SERVER)).toBe(e2ePortFor(p, E2E_SERVER) + 1);
      expect((e2ePortFor(p, E2E_SERVER) - PORT_RANGE_START) % PORTS_PER_CHECKOUT).toBe(0);
    }
  });

  it('gives every worker its own port, and never the real-provider one (NEWS-321)', () => {
    // The failure this prevents is the worst kind available here: two workers
    // sharing a server would each reset and seed state the other was asserting
    // on, and the result is not a clean error but *intermittently wrong tests* —
    // sometimes green, sometimes a failure blamed on whichever spec noticed.
    for (let i = 0; i < 200; i++) {
      const checkout = `/Users/dev/checkout-${String(i)}`;
      const roles = Array.from({ length: E2E_MAX_WORKERS }, (_, w) => e2eWorkerRole(w));
      const ports = roles.map((r) => e2ePortFor(checkout, r));

      expect(new Set(ports).size, 'two workers must never share a port').toBe(E2E_MAX_WORKERS);
      expect(ports, 'no worker may take the real-provider server′s port').not.toContain(
        e2ePortFor(checkout, E2E_REAL_SERVER),
      );
      // Still inside this checkout's own stride, so a worker cannot reach into
      // the next checkout's window — the property the stride exists for.
      for (const port of ports) {
        const offset = (port - PORT_RANGE_START) % PORTS_PER_CHECKOUT;
        expect(offset, 'a worker port must stay within its checkout stride').toBeLessThan(PORTS_PER_CHECKOUT);
        expect(port).not.toBe(4187);
      }
      expect(ports[0], 'worker 0 keeps the port a serial run has always used').toBe(e2ePortFor(checkout, E2E_SERVER));
    }
  });

  it('refuses a worker index outside the window rather than wrapping (NEWS-321)', () => {
    // `workerIndex` grows without bound when Playwright replaces a crashed
    // worker; only `parallelIndex` is the 0..workers-1 slot. Passing the wrong
    // one must be an error here, not a port quietly borrowed from the next
    // checkout — which is exactly the silent corruption above.
    expect(() => e2eWorkerRole(E2E_MAX_WORKERS)).toThrow(/outside/);
    expect(() => e2eWorkerRole(-1)).toThrow(/outside/);
  });

  it('the whole window still fits the documented range (NEWS-321)', () => {
    // 4200–4999: near the app's own port so a stray listener is recognisably
    // ours, below 5000 (macOS AirPlay Receiver) and clear of 5432/5900/6379.
    // Widening the stride to one port per worker had to be paid for in slots,
    // and this is the assertion that says the bill was paid.
    expect(PORT_RANGE_START + PORT_SLOTS * PORTS_PER_CHECKOUT).toBeLessThanOrEqual(5000);
  });

  it('defaults to this checkout, resolved from the module and not from cwd', () => {
    // `npx playwright test` can be run from a subdirectory; the port must not
    // change when it is.
    expect(CHECKOUT_ROOT).toBe(root);
    expect(e2ePort()).toBe(e2ePortFor(root, E2E_SERVER));
    expect(e2ePort(E2E_REAL_SERVER)).toBe(e2ePortFor(root, E2E_REAL_SERVER));
  });
});

describe('the harness actually uses the derived port (NEWS-287)', () => {
  it('playwright.config.ts derives its port instead of naming one', () => {
    // A derivation nothing calls is not a fix. The old constant is named
    // explicitly so a revert cannot pass.
    const config = code('playwright.config.ts');
    expect(config).toContain('e2ePort(E2E_SERVER)');
    expect(config, 'the hardcoded 4189 must stay gone').not.toContain('4189');
  });

  it('the real-subscription spec derives its own port too', () => {
    // It boots its own server (NEWS-276), so it needs the *second* port in this
    // checkout's window — 4191 collided across checkouts exactly as 4189 did.
    const spec = code('tests/e2e/real-providers.spec.ts');
    expect(spec).toContain('e2ePort(E2E_REAL_SERVER)');
    expect(spec).not.toContain('4191');
  });

  it('pre-flights the port before Playwright can complain about it', () => {
    // The message is the deliverable. Playwright's own error ("is already used,
    // make sure that nothing is running on the port") cannot say what is running
    // or whether it is safe to kill.
    const config = code('playwright.config.ts');
    expect(config).toContain('scripts/e2e-preflight.mjs');
    // Guarded to the main process: workers re-import this config, and by then our
    // own server is listening. An unguarded pre-flight would abort the run it
    // exists to protect.
    expect(config).toContain("process.env['TEST_WORKER_INDEX'] === undefined");
  });

  it('the pre-flight distinguishes an orphan from a live sibling', () => {
    // Killing whatever holds the port would eventually kill a colleague's
    // in-progress run. Only a server whose Playwright parent is gone — adopted by
    // init — is a leftover, and only that one is reclaimed.
    const script = code('scripts/e2e-preflight.mjs');
    expect(script, 'the decision must rest on the parent pid').toContain('ppid === 1');
    expect(script).toContain('another checkout is running E2E');
    expect(script).toContain('orphaned newsmonger server');
    // `lsof` for the parent, not `ps`: inside a command sandbox `ps` is denied
    // and `lsof` is not, and the sandbox is where the agent that leaks a server
    // runs. Reverting to `ps` alone would silently disable the reclaim path
    // exactly where it is needed.
    expect(script).toContain('-FpR');
  });
});
