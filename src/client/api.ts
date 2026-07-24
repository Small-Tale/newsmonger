import type { ProviderName } from '../ai/types.js';
import { KeysRespSchema, ProvidersRespSchema, StateRespSchema } from '../api/schemas.js';
import { noteState } from './notifications.js';
import { appStore } from './stores.js';

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `request failed (${res.status})`;
    throw new Error(message);
  }
  return body;
}

export async function refreshState(): Promise<void> {
  try {
    const body = await request('/api/state');
    const state = StateRespSchema.parse(body);
    appStore.actions.setState(state);
    // Fire an OS notification if new stories arrived while unfocused (NEWS-38).
    noteState(state);
  } catch (err) {
    appStore.actions.setError(err instanceof Error ? err.message : String(err));
  }
}

/** Run an action, surface its error in the banner, then refresh app state. */
export async function withRefresh(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    appStore.actions.setError(null);
  } catch (err) {
    appStore.actions.setError(err instanceof Error ? err.message : String(err));
  }
  await refreshState();
}

export function addTopic(name: string): Promise<void> {
  return withRefresh(() => request('/api/topics', { method: 'POST', body: JSON.stringify({ name }) }));
}

export function deleteTopic(id: string): Promise<void> {
  return withRefresh(() => request(`/api/topics/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export function setTopicPaused(id: string, paused: boolean): Promise<void> {
  return withRefresh(() =>
    request(`/api/topics/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ paused }) }),
  );
}

export function setNotifyOnNewItems(notifyOnNewItems: boolean): Promise<void> {
  return withRefresh(() =>
    request('/api/settings', { method: 'PATCH', body: JSON.stringify({ notifyOnNewItems }) }),
  );
}

export function updateInterval(checkIntervalMs: number): Promise<void> {
  return withRefresh(() =>
    request('/api/settings', { method: 'PATCH', body: JSON.stringify({ checkIntervalMs }) }),
  );
}

/** Fetch the provider list + availability (probes providers; call on demand). */
export async function refreshProviders(): Promise<void> {
  try {
    const body = await request('/api/providers');
    appStore.actions.setProviders(ProvidersRespSchema.parse(body).providers);
  } catch {
    // non-fatal — the picker just shows no availability info
  }
}

export async function updateProviderSettings(patch: {
  provider?: ProviderName;
  model?: string;
  endpoint?: string;
}): Promise<void> {
  await withRefresh(() => request('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }));
  await refreshProviders();
}

/** Fetch per-provider key status. Carries no key values — see `KeyStatusSchema`. */
export async function refreshKeys(): Promise<void> {
  try {
    const body = await request('/api/keys');
    appStore.actions.setKeys(KeysRespSchema.parse(body));
  } catch {
    // non-fatal — the dialog shows the providers as unconfigured
  }
}

/**
 * Save a provider's key, then re-read status and availability.
 *
 * The value is passed straight through to the request and deliberately never
 * stored in the app state: the only copy in the page is the input the user
 * typed, which is cleared on success.
 */
export async function saveKey(provider: string, key: string): Promise<boolean> {
  try {
    await request(`/api/keys/${encodeURIComponent(provider)}`, { method: 'PUT', body: JSON.stringify({ key }) });
    appStore.actions.setKeyError(null);
  } catch (err) {
    appStore.actions.setKeyError(err instanceof Error ? err.message : String(err));
    return false;
  }
  await Promise.all([refreshKeys(), refreshProviders()]);
  return true;
}

export async function deleteKey(provider: string): Promise<void> {
  try {
    await request(`/api/keys/${encodeURIComponent(provider)}`, { method: 'DELETE' });
    appStore.actions.setKeyError(null);
  } catch (err) {
    appStore.actions.setKeyError(err instanceof Error ? err.message : String(err));
  }
  await Promise.all([refreshKeys(), refreshProviders()]);
}

export function startCheck(topicId?: string): Promise<void> {
  return withRefresh(() =>
    request('/api/check', { method: 'POST', body: JSON.stringify(topicId !== undefined ? { topicId } : {}) }),
  );
}

/**
 * Tell the server the app is in front of the user right now.
 *
 * Only sent when the page is both visible and focused — a visible but
 * unfocused window on a second monitor isn't someone using the app, and this
 * signal is what permits scheduled checks to spend subscription quota.
 */
export function reportForeground(): Promise<unknown> {
  return request('/api/foreground', { method: 'POST' }).catch(() => null);
}

export function openExternal(url: string): Promise<unknown> {
  return request('/api/open-external', { method: 'POST', body: JSON.stringify({ url }) });
}
