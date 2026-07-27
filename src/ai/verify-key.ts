import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

import type { KeyedProvider } from './types.js';

/**
 * The outcome of checking a key against its vendor (NEWS-78).
 *
 * `unknown` is a distinct answer from `invalid` and matters more than it looks:
 * a machine that is offline, behind a proxy, or looking at a vendor outage must
 * not be told its key is wrong. Only an authentication failure is `invalid`.
 */
export type KeyVerdict =
  | { status: 'valid' }
  | { status: 'invalid'; message: string }
  | { status: 'unknown'; message: string };

/** Checks a key against the vendor. Injected so tests never touch the network. */
export type KeyVerifier = (provider: KeyedProvider, key: string) => Promise<KeyVerdict>;

/** HTTP statuses that mean "this key is wrong", as opposed to "we couldn't tell". */
function verdictForStatus(status: number | undefined, vendor: string): KeyVerdict {
  if (status === 401 || status === 403) {
    return { status: 'invalid', message: `${vendor} rejected that key. Check it and try again.` };
  }
  return {
    status: 'unknown',
    message: `Couldn’t reach ${vendor} to check the key${status === undefined ? '' : ` (HTTP ${String(status)})`}.`,
  };
}

/**
 * Verify a key by listing models — the cheapest authenticated call each vendor
 * offers.
 *
 * Deliberately **not** a completion: a probe that spends tokens (or plan quota)
 * to answer "is this typed correctly?" is a bad trade, and it's the same reason
 * `isAvailable()` only checks for a key's presence rather than calling the API
 * (see `docs/9-subscription-providers.md` FR-9.6).
 */
export const verifyApiKey: KeyVerifier = async (provider, key) => {
  try {
    if (provider === 'anthropic') {
      await new Anthropic({ apiKey: key, maxRetries: 0 }).models.list({ limit: 1 });
    } else {
      await new OpenAI({ apiKey: key, maxRetries: 0 }).models.list();
    }
    return { status: 'valid' };
  } catch (err: unknown) {
    const vendor = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
    const status = typeof err === 'object' && err !== null && 'status' in err ? err.status : undefined;
    return verdictForStatus(typeof status === 'number' ? status : undefined, vendor);
  }
};
