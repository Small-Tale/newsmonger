import { describe, expect, it } from 'vitest';

import { AUTO_ORDER, type ProviderName } from '../../src/ai/types.js';
import type { ProviderInfo } from '../../src/api/schemas.js';
import { sourceStatus } from '../../src/client/source-status.js';

/**
 * The Source tab's status line (NEWS-308).
 *
 * It rendered nothing on the default settings, which the design review saw as
 * two separate findings — "90px of unexplained empty space" and "the provider
 * status line is not visible" — because a blank row and a missing row look the
 * same. Every case here therefore asserts that *something* is said, and what.
 *
 * `unknown` is the reason this is a module rather than a branch inside the JSX:
 * it is a race — the settings dialog can open before `GET /api/providers`
 * answers — and there is no reliable way to hold a rendered assertion in that
 * window.
 */

function info(name: ProviderName, available: boolean | null): ProviderInfo {
  return { name, label: name, endpointConfigurable: false, available };
}

/** Every concrete provider probed, with the named ones available. */
function probed(...usable: ProviderName[]): ProviderInfo[] {
  return [
    info('auto', null),
    ...AUTO_ORDER.map((n) => info(n, usable.includes(n))),
    info('mock', usable.includes('mock')),
  ];
}

describe('sourceStatus', () => {
  it('says nothing is known before the probe answers', () => {
    expect(sourceStatus([], 'auto')).toEqual({ kind: 'unknown' });
    expect(sourceStatus([], 'anthropic')).toEqual({ kind: 'unknown' });
  });

  it('reports a named provider directly', () => {
    expect(sourceStatus(probed('anthropic'), 'anthropic')).toEqual({ kind: 'ready', via: null });
    expect(sourceStatus(probed('anthropic'), 'openai')).toEqual({ kind: 'unavailable' });
  });

  it('resolves auto to the first available provider in AUTO_ORDER', () => {
    // The whole bug in one assertion: `auto` is the default, the server reports
    // it as `available: null`, and the old lookup turned that into a blank line.
    expect(sourceStatus(probed('openai'), 'auto')).toEqual({ kind: 'ready', via: 'openai' });
    expect(sourceStatus(probed('claude-cli', 'openai'), 'auto')).toEqual({ kind: 'ready', via: 'claude-cli' });
  });

  it('follows AUTO_ORDER rather than the order the server listed', () => {
    // `resolveProvider` walks AUTO_ORDER, so naming whichever available provider
    // came first in the response would print a provider the next check does not
    // use — a wrong answer being strictly worse than the blank it replaces.
    const reversed = [...probed('codex-cli', 'anthropic')].reverse();
    const first = AUTO_ORDER.find((n) => n === 'codex-cli' || n === 'anthropic');
    expect(sourceStatus(reversed, 'auto')).toEqual({ kind: 'ready', via: first });
  });

  it('distinguishes "nothing usable" from "not probed yet"', () => {
    // Both render, and they must not render the same thing: one is an urgent
    // "no check can run", the other is "ask again in a moment".
    expect(sourceStatus(probed(), 'auto')).toEqual({ kind: 'none-usable' });
    // A partial response — some entries missing — is not yet an answer.
    const partial = [info('auto', null), info(AUTO_ORDER[0], false)];
    expect(sourceStatus(partial, 'auto')).toEqual({ kind: 'unknown' });
  });

  it('treats a provider the server did not list as unknown, not unavailable', () => {
    // A retired or unrecognised provider name is a gap in our knowledge. Saying
    // "no API key" about it would send someone to add a key that changes nothing.
    expect(sourceStatus([info('auto', null)], 'anthropic')).toEqual({ kind: 'unknown' });
  });

  it('never returns a state the JSX has no branch for', () => {
    const cases: [ProviderInfo[], ProviderName][] = [
      [[], 'auto'],
      [probed(), 'auto'],
      [probed('claude-cli'), 'auto'],
      [probed('mock'), 'mock'],
      [probed(), 'openai'],
    ];
    for (const [providers, selected] of cases) {
      expect(['unknown', 'ready', 'unavailable', 'none-usable']).toContain(sourceStatus(providers, selected).kind);
    }
  });
});
