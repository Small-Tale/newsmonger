import type { ProviderName } from '../ai/types.js';
import { ItemsRespSchema, KeysRespSchema, ProvidersRespSchema, StateRespSchema } from '../api/schemas.js';
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

/**
 * Monotonic guards so a slower, older response can't overwrite a newer one
 * (NEWS-104).
 *
 * Refreshes run concurrently by design: a 4-second poll, plus one after every
 * mutation (`withRefresh`). Without a guard the store simply takes whichever
 * response *resolves* last, which is not the same as the one issued last. The
 * visible symptom is a setting appearing to revert — change an interval, and a
 * poll that was already in flight answers with the pre-PATCH value and rewrites
 * the `<select>` until the next tick, up to 4 seconds later.
 *
 * A sequence number rather than an `AbortController`: the older request's
 * *answer* is what's unwanted, not the request itself, and cancelling a poll
 * that a mutation happened to overlap would throw away a legitimate refresh.
 *
 * Counters are module-scoped because there is exactly one store and one poll
 * per page. `refreshFeed` needs its own — the two endpoints are independent, and
 * a shared counter would let a feed response suppress a state one.
 */
let stateSeq = 0;
let stateApplied = 0;
let feedSeq = 0;
let feedApplied = 0;

export async function refreshState(): Promise<void> {
  const seq = ++stateSeq;
  try {
    const body = await request('/api/state');
    const state = StateRespSchema.parse(body);
    // Errors are gated by the same check: a stale failure must not raise a
    // banner over state that a newer, successful response already applied.
    if (seq < stateApplied) return;
    stateApplied = seq;
    appStore.actions.setState(state);
    // Fire an OS notification if new stories arrived while unfocused (NEWS-38).
    // Inside the guard deliberately — it diffs against the last state it saw, so
    // feeding it a stale one would mis-report what's new.
    noteState(state);
  } catch (err) {
    if (seq < stateApplied) return;
    stateApplied = seq;
    appStore.actions.setError(err instanceof Error ? err.message : String(err));
  } finally {
    // The feed lives on its own endpoint now (NEWS-76); refresh it in step.
    // In `finally` so a stale response returning early still refreshes it —
    // `refreshFeed` has its own guard, and skipping it here would drop the feed
    // refresh that `withRefresh` is relying on.
    await refreshFeed();
  }
}

/**
 * Fetch the feed page for the current view from `/api/items` (NEWS-76).
 *
 * Builds the query from the active view — review mode, else Solo + Saved +
 * Search — plus the current `feedLimit`. Called on the poll, on a view change,
 * and on "Show more"; each call fetches the newest `feedLimit` matches, so a
 * poll naturally folds in new stories at the top.
 */
export async function refreshFeed(): Promise<void> {
  const s = appStore.state.value;
  const params = new URLSearchParams({ limit: String(s.feedLimit) });
  if (s.reviewTopicIds.length > 0) {
    params.set('mode', 'review');
    params.set('topics', s.reviewTopicIds.join(','));
  } else {
    if (s.soloTopicIds.length > 0) params.set('topics', s.soloTopicIds.join(','));
    if (s.savedFilter) params.set('saved', '1');
    const q = s.searchQuery.trim();
    if (q !== '') params.set('q', q);
    // Resolved server-side (NEWS-97): the client holds one page, so filtering
    // here would miss matches deeper in history — the NEWS-74 bug.
    if (s.categoryFilter !== null) {
      params.set('category', s.categoryFilter.category);
      if (s.categoryFilter.subcategory !== null) params.set('subcategory', s.categoryFilter.subcategory);
    }
  }
  const seq = ++feedSeq;
  try {
    const resp = ItemsRespSchema.parse(await request(`/api/items?${params.toString()}`));
    // Same ordering guard as `refreshState`, and it matters more here: the query
    // is built from the *current* view, so a response for the previous search
    // term or Solo set landing late would repopulate the feed with rows the
    // filters have already excluded.
    if (seq < feedApplied) return;
    feedApplied = seq;
    appStore.actions.setFeed({ items: resp.items, total: resp.total });
  } catch (err) {
    if (seq < feedApplied) return;
    feedApplied = seq;
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

export function setTopicHighPriority(id: string, highPriority: boolean): Promise<void> {
  return withRefresh(() =>
    request(`/api/topics/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ highPriority }) }),
  );
}

/** Set (or clear, with '') a topic's free-text guidance (NEWS-80). */
export function setTopicGuidance(id: string, guidance: string): Promise<void> {
  return withRefresh(() =>
    request(`/api/topics/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ guidance }) }),
  );
}

export function setNotifyOnNewItems(notifyOnNewItems: boolean): Promise<void> {
  return withRefresh(() =>
    request('/api/settings', { method: 'PATCH', body: JSON.stringify({ notifyOnNewItems }) }),
  );
}

/** Set the story-retention window in days; 0 keeps everything (NEWS-87). */
export function updateRetention(itemRetentionDays: number): Promise<void> {
  return withRefresh(() =>
    request('/api/settings', { method: 'PATCH', body: JSON.stringify({ itemRetentionDays }) }),
  );
}

/** Switch between interval and time-of-day scheduling (NEWS-84). */
export function updateScheduleMode(scheduleMode: 'interval' | 'daily'): Promise<void> {
  return withRefresh(() =>
    request('/api/settings', { method: 'PATCH', body: JSON.stringify({ scheduleMode }) }),
  );
}

/** Set the local times of day checks run at, in `HH:MM` form (NEWS-84). */
export function updateDailyTimes(dailyTimes: string[]): Promise<void> {
  return withRefresh(() =>
    request('/api/settings', { method: 'PATCH', body: JSON.stringify({ dailyTimes }) }),
  );
}

/** How many topics a sweep checks at once (NEWS-81). */
export function updateConcurrency(checkConcurrency: number): Promise<void> {
  return withRefresh(() =>
    request('/api/settings', { method: 'PATCH', body: JSON.stringify({ checkConcurrency }) }),
  );
}

/** Point price updates at a published manifest; '' turns it off (NEWS-93). */
export function updateInterval(checkIntervalMs: number): Promise<void> {
  return withRefresh(() =>
    request('/api/settings', { method: 'PATCH', body: JSON.stringify({ checkIntervalMs }) }),
  );
}

export function updateHighPriorityInterval(highPriorityIntervalMs: number): Promise<void> {
  return withRefresh(() =>
    request('/api/settings', { method: 'PATCH', body: JSON.stringify({ highPriorityIntervalMs }) }),
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

export function setItemSaved(id: string, saved: boolean): Promise<void> {
  return withRefresh(() =>
    request(`/api/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ saved }) }),
  );
}

export function setItemOffTopic(id: string, offTopic: boolean): Promise<void> {
  return withRefresh(() =>
    request(`/api/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ offTopic }) }),
  );
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
