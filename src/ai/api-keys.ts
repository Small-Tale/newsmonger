/**
 * Where each provider's API key comes from.
 *
 * Two sources, in order: the environment, then the OS keychain. There is
 * deliberately no third — a key is never written to `~/.news/data.json`, so the
 * data file stays safe to copy, sync, or attach to a bug report. When the
 * keychain is unavailable, the environment is the only way to supply a key, and
 * the settings dialog says so rather than silently falling back to disk.
 */

import { keyAccount, keychainDelete, keychainGet, keychainSet } from '../keychain.js';
import type { KeyedProvider } from './types.js';
import { KEY_ENV_VARS } from './types.js';

/** Where a resolved key came from. `null` means no key is configured. */
export type KeySource = 'env' | 'keychain' | null;

export interface ResolvedKey {
  key: string | null;
  source: KeySource;
}

/**
 * Resolve a provider's key: environment first, then the keychain.
 *
 * The environment wins so `ANTHROPIC_API_KEY=… npm run dev` overrides whatever
 * is stored without the user having to clear it first — and so CI and the E2E
 * suite never depend on the developer's own keychain.
 */
export async function resolveApiKey(provider: KeyedProvider): Promise<ResolvedKey> {
  const fromEnv = process.env[KEY_ENV_VARS[provider]];
  if (fromEnv !== undefined && fromEnv !== '') return { key: fromEnv, source: 'env' };

  const stored = await keychainGet(keyAccount(provider));
  if (stored !== null && stored !== '') return { key: stored, source: 'keychain' };

  return { key: null, source: null };
}

/** Store a provider's key in the OS keychain. Throws if the write can't be verified. */
export async function saveApiKey(provider: KeyedProvider, key: string): Promise<void> {
  await keychainSet(keyAccount(provider), key);
}

/** Remove a provider's stored key. An environment-supplied key is untouched —
 *  nothing here can unset it, which is why the UI hides Remove in that case. */
export async function deleteApiKey(provider: KeyedProvider): Promise<void> {
  await keychainDelete(keyAccount(provider));
}
