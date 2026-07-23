import type { ProviderName } from '../ai/types.js';
import { ProvidersRespSchema, StateRespSchema } from '../api/schemas.js';
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
    appStore.actions.setState(StateRespSchema.parse(body));
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

export function startCheck(topicId?: string): Promise<void> {
  return withRefresh(() =>
    request('/api/check', { method: 'POST', body: JSON.stringify(topicId !== undefined ? { topicId } : {}) }),
  );
}

export function openExternal(url: string): Promise<unknown> {
  return request('/api/open-external', { method: 'POST', body: JSON.stringify({ url }) });
}
