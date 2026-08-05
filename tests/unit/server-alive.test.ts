import { describe, expect, it } from 'vitest';

import { serverAlive, voidRunMessage } from '../helpers/server-alive.js';

/**
 * The "this run is void" verdict (NEWS-298).
 *
 * The harness is awkward to test through itself — proving this end to end means
 * killing a real server mid-run — so the decision and the wording are a pure
 * module, and this is where they are pinned. The end-to-end half is a manual
 * check in `docs/manual-test-plan.md`.
 *
 * **The wording is the deliverable.** The bug this addresses cost hours during
 * NEWS-280/281, and it cost them because the message a reader saw pointed at the
 * wrong feature. A future edit that softens the banner back into "request
 * failed" would regress the entire ticket while every functional test stayed
 * green, so the phrases a reader needs are asserted literally.
 */

const up = { probe: () => Promise.resolve({ ok: true, status: 200 }) };
const unhealthy = { probe: () => Promise.resolve({ ok: false, status: 503 }) };
const down = {
  probe: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:4931')),
};

describe('serverAlive', () => {
  it('says nothing when the server answers', async () => {
    // Silence is the common case by a wide margin — nearly every failure is a
    // real one, and a banner on all of them would be noise that teaches people
    // to skip the banner.
    expect(await serverAlive('http://127.0.0.1:4931', up)).toEqual({ alive: true, message: '' });
  });

  it('probes /healthz, and tolerates a trailing slash on the base URL', async () => {
    const seen: string[] = [];
    await serverAlive('http://127.0.0.1:4931/', {
      probe: (url) => {
        seen.push(url);
        return Promise.resolve({ ok: true, status: 200 });
      },
    });
    expect(seen).toEqual(['http://127.0.0.1:4931/healthz']);
  });

  it('treats an unhealthy answer as alive, and still says so', async () => {
    // Up and talking means whatever failed is a real finding. Calling that void
    // would be the opposite error: telling someone to ignore a true failure.
    const v = await serverAlive('http://127.0.0.1:4931', unhealthy);
    expect(v.alive).toBe(true);
    expect(v.message).toContain('503');
    expect(v.message).not.toContain('VOID');
  });

  it('reports a dead server as a void run', async () => {
    const v = await serverAlive('http://127.0.0.1:4931', down);
    expect(v.alive).toBe(false);
    expect(v.message).toContain('THIS RUN IS VOID');
  });

  it('never throws, whatever the probe does', async () => {
    // It runs on a path where a test has *already* failed. A diagnostic that
    // throws turns one confusing failure into two.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point is a non-Error rejection
    const weird = { probe: () => Promise.reject('not an Error') };
    await expect(serverAlive('http://127.0.0.1:4931', weird)).resolves.toMatchObject({ alive: false });
  });
});

describe('the void-run banner', () => {
  const text = voidRunMessage('http://127.0.0.1:4931/healthz', 'connect ECONNREFUSED');

  it('says the run is void, in those words', () => {
    expect(text).toContain('THE E2E SERVER WENT AWAY — THIS RUN IS VOID.');
  });

  it('tells the reader not to debug the later failures', () => {
    // The single most valuable sentence: it is what stops someone spending an
    // afternoon on a dirty-select assertion for a feature nobody touched.
    expect(text).toContain('consequence, not a cause');
    expect(text).toContain('Do not debug them');
  });

  it('names the url and the underlying error', () => {
    expect(text).toContain('http://127.0.0.1:4931/healthz');
    expect(text).toContain('connect ECONNREFUSED');
  });

  it('points at the likely causes, including the one that actually happened', () => {
    // NEWS-287's derived port exists because a sibling checkout's teardown killed
    // this suite's server. That is the first place to look, so it is named.
    expect(text).toContain('another checkout');
    expect(text).toContain('NEWS-287');
  });

  it('is visually unmissable in a wall of Playwright output', () => {
    const lines = text.split('\n');
    expect(lines.filter((l) => l.startsWith('====')).length, 'ruled top and bottom').toBe(2);
    expect(lines.length).toBeGreaterThan(8);
  });
});

describe('the banner stays readable (NEWS-298)', () => {
  it('keeps only the first line of a multi-line probe error', async () => {
    // Playwright's request errors carry a call log — headers, redirects, a
    // user-agent string. Verified against a real killed-server run: pasted whole,
    // it pushed "consequence, not a cause" and "Do not debug them" off the bottom
    // of the terminal, which are the two sentences the banner exists to deliver.
    const chatty = {
      probe: () =>
        Promise.reject(
          new Error(
            'apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:4558\nCall log:\n  - → GET /healthz\n  - user-agent: Mozilla/5.0 …',
          ),
        ),
    };
    const v = await serverAlive('http://127.0.0.1:4558', chatty);
    expect(v.message).toContain('connect ECONNREFUSED 127.0.0.1:4558');
    expect(v.message).not.toContain('Call log');
    expect(v.message).not.toContain('user-agent');
    // And the payload sentences are still there, after the detail line.
    expect(v.message).toContain('Do not debug them');
  });
});
