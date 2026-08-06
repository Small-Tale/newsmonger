import type { Effort,ProviderName} from '../ai/types.js';
import type { BackupPreview, DiscoverReq, DiscoverResp, ImportStoriesResp, ImportTopicsResp, TopicSuggestion } from '../api/schemas.js';
import {
  BackupLocationsRespSchema,
  BackupPreviewRespSchema,
  BackupRespSchema,
  ClearItemsRespSchema,
  ClearTopicsRespSchema,
  DiscoverRespSchema,
  ImportStoriesRespSchema,
  ImportTopicsRespSchema,
  ItemsRespSchema,
  KeysRespSchema,
  ModelsRespSchema,
  ProvidersRespSchema,
  RestoreRespSchema,
  StateRespSchema,
  ThreadRespSchema,
} from '../api/schemas.js';
import type { BackupLocation } from '../backup-locations.js';
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

/**
 * Thread ids with a request out (NEWS-293).
 *
 * Not derivable from the store: a *refresh* of an open pane deliberately leaves
 * the pane's status `ready` so the old rows stay on screen, so "is one in
 * flight" and "is the pane showing a spinner" stopped being the same question
 * the moment the poll started calling `loadThread`.
 */
const threadsInFlight = new Set<string>();

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
/**
 * Acknowledge the "database was set aside" notice (NEWS-340).
 *
 * Fire-and-forget: the banner is already gone from the client's state, and a
 * failed dismissal simply means it reappears on the next poll — which is the
 * right way for this one to fail. Nothing is deleted by dismissing.
 */
export async function dismissQuarantine(): Promise<void> {
  try {
    await request('/api/quarantine/dismiss', { method: 'POST' });
  } catch {
    // Reappearing is a better failure than a banner saying the dismissal failed.
  }
}

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
    appStore.actions.setFeed({ items: resp.items, total: resp.total, threads: resp.threads });
    // An open pane follows its thread (NEWS-293). The badge shape in `threads`
    // has just been refreshed, so this is the one moment the client can know a
    // thread grew — and `loadThread` compares the new size against what the
    // pane holds and returns without a request when they agree, so the poll
    // costs nothing on the overwhelmingly common unchanged tick. No new
    // reactive edge: the existing guard *is* the mechanism.
    const expanded = appStore.state.value.expandedItemId;
    if (expanded !== null) void loadThread(expanded);
  } catch (err) {
    if (seq < feedApplied) return;
    feedApplied = seq;
    appStore.actions.setError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Load one story's thread for the detail pane (NEWS-282).
 *
 * **On expand, never on render.** The feed already carries each story's thread
 * *shape* (`threads`, one small record per multi-story thread), so this is only
 * ever called for a card someone actually opened — a fetch per card in a
 * hundred-story feed for a pane nobody looked at is the thing this avoids.
 *
 * Three early returns, each a decision rather than a guard:
 *
 * - **No summary means a thread of one** (FR-29.6), the ordinary case. There is
 *   nothing to fetch and the pane says so in a line; asking anyway would spend a
 *   request per expansion to be told what the feed already said.
 * - **A cached thread of the same size is reused**, so collapse/re-expand is
 *   free. Keyed on size rather than on time: the 4-second poll refreshes the
 *   badge, so a thread that has grown announces itself and is refetched.
 * - **An in-flight request is not duplicated.** The button and the card body are
 *   one handler, but a double-click still arrives as two clicks.
 *
 * A failure lands in the pane, not in the page banner: a background read for one
 * card is not something to raise a red banner across the app over, and the pane
 * is where the reader is looking. It offers a retry rather than clearing itself,
 * and is never cached — re-opening the card tries again.
 *
 * **A pane that already has rows is refreshed in place** (NEWS-293), which is
 * the whole difference between this being a fix and being a flicker. `refreshFeed`
 * calls this for the open card on every 4-second poll, so the first-load path —
 * `status: 'loading'`, which the pane renders as "Looking up the story so far…"
 * — would replace a correct timeline with a placeholder each time the thread
 * grew. The old rows stay on screen until the new ones land: they are still
 * true, just one instalment short for a moment.
 *
 * For the same reason a **failed refresh keeps what is on screen** rather than
 * swapping a good timeline for an error with a retry button. The reader did not
 * ask for anything; a background refresh that fails should be silent, and the
 * next poll tries again anyway.
 */
export async function loadThread(id: string): Promise<void> {
  const state = appStore.state.value;
  const summary = state.threads[id];
  if (summary === undefined || summary.size < 2) return;
  const cached = state.threadPanes[id];
  if (cached !== undefined) {
    if (cached.status === 'loading') return;
    if (cached.status === 'ready' && cached.size === summary.size) return;
  }
  // Tracked here rather than inferred from `status: 'loading'`, because a
  // refresh deliberately does not set that status — without this, every poll
  // during a slow request would start another one.
  if (threadsInFlight.has(id)) return;
  const refreshing = cached?.status === 'ready';
  if (!refreshing) appStore.actions.setThreadPane(id, { status: 'loading' });
  threadsInFlight.add(id);
  try {
    const resp = ThreadRespSchema.parse(await request(`/api/items/${encodeURIComponent(id)}/thread`));
    appStore.actions.setThreadPane(id, { status: 'ready', items: resp.items, size: resp.items.length });
  } catch (err) {
    if (refreshing) return;
    appStore.actions.setThreadPane(id, {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    threadsInFlight.delete(id);
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

/**
 * Create a topic from a discovery suggestion (NEWS-126).
 *
 * The guidance and classification travel with the create rather than in a
 * follow-up PATCH: creating a topic fires its first check immediately (FR-1.12),
 * so a second request would land after that check had already run unsteered —
 * exactly what the suggestion's guidance exists to prevent (FR-24.12).
 *
 * Errors are thrown rather than swallowed into the global banner: the caller
 * shows them on the card, next to the button that failed.
 */
export async function addSuggestedTopic(suggestion: TopicSuggestion): Promise<void> {
  await request('/api/topics', {
    method: 'POST',
    body: JSON.stringify({
      name: suggestion.name,
      ...(suggestion.guidance === '' ? {} : { guidance: suggestion.guidance }),
      ...(suggestion.classification === null
        ? {}
        : {
            category: suggestion.classification.category,
            ...(suggestion.classification.subcategory === null
              ? {}
              : { subcategory: suggestion.classification.subcategory }),
          }),
    }),
  });
  await refreshState();
}


/** Ask for topic suggestions (FR-24.1). */
export async function discoverTopics(
  scope: DiscoverReq['scope'],
  limit?: number,
  seen?: string[],
): Promise<DiscoverResp> {
  const body = await request('/api/discover', {
    method: 'POST',
    body: JSON.stringify({
      scope,
      ...(limit === undefined ? {} : { limit }),
      // Only sent for "More" (NEWS-136) — an empty list would needlessly change
      // the cache key and turn a free repeat request into a billed one.
      ...(seen === undefined || seen.length === 0 ? {} : { seen }),
    }),
  });
  return DiscoverRespSchema.parse(body);
}

export function deleteTopic(id: string): Promise<void> {
  return withRefresh(() => request(`/api/topics/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

/**
 * How many stories a topic has (NEWS-139).
 *
 * Reuses the feed endpoint's `total` rather than adding one of its own — asking
 * for a single item gives the count without the rows. Deliberately not on
 * `/api/state`: that is polled every four seconds by every client, and this is a
 * `GROUP BY` over every story needed once, when a dialog opens.
 */
export async function countItemsForTopic(id: string): Promise<number> {
  const body = await request(`/api/items?topics=${encodeURIComponent(id)}&limit=1`);
  return ItemsRespSchema.parse(body).total;
}

/**
 * Rename a topic, optionally discarding its existing stories (NEWS-139).
 *
 * Errors are thrown rather than folded into the global banner: a duplicate name
 * is something the user fixes in the dialog they are already looking at.
 */
export async function renameTopic(id: string, name: string, clearItems: boolean): Promise<void> {
  await request(`/api/topics/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name, ...(clearItems ? { clearItems: true } : {}) }),
  });
  await refreshState();
  await refreshFeed();
}

/**
 * Put back the stories a clear removed (NEWS-145).
 *
 * The window is server-side and short, so this can legitimately fail with a 410
 * after the user has already seen the Undo — `request` turns that into a thrown
 * Error carrying the server's message, which the caller shows as a plain notice
 * rather than a red banner. Expiring is not an error condition.
 */
export async function restoreClearedItems(id: string): Promise<void> {
  await request(`/api/topics/${encodeURIComponent(id)}/restore-cleared`, { method: 'POST' });
  await refreshState();
  await refreshFeed();
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

/** Light, dark, or follow the system (FR-3.74, NEWS-334). */
export function updateTheme(theme: 'auto' | 'light' | 'dark'): Promise<void> {
  return withRefresh(() => request('/api/settings', { method: 'PATCH', body: JSON.stringify({ theme }) }));
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

/**
 * Point backups at a folder; '' turns them off (NEWS-192).
 *
 * A typed path, not a picked one: the browser build cannot produce a filesystem
 * path a Node server can open (the File System Access API hands back a
 * sandboxed handle), and the desktop shell has no dialog plugin yet — see
 * `docs/27-data-location.md`.
 */
export function updateBackupDir(backupDir: string): Promise<void> {
  return withRefresh(() => request('/api/settings', { method: 'PATCH', body: JSON.stringify({ backupDir }) }));
}

/** Sync folders the server can see (NEWS-230, FR-27.5). Empty is a valid answer. */
export async function fetchBackupLocations(): Promise<BackupLocation[]> {
  const body = await request('/api/backup/locations');
  return BackupLocationsRespSchema.parse(body).locations;
}

/**
 * Record a dismissal of the backup offer (NEWS-230, FR-27.4).
 *
 * Server-side rather than `localStorage`: "stop asking me" has to survive a
 * browser reinstall and hold in the desktop shell too.
 */
export function dismissBackupPrompt(patch: {
  backupPromptNever?: boolean;
  backupPromptSnoozedUntil?: string;
}): Promise<void> {
  return withRefresh(() => request('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }));
}

/** Write a backup right now, ignoring the interval throttle (NEWS-192). */
export async function backupNow(): Promise<string> {
  const body = await request('/api/backup', { method: 'POST' });
  return BackupRespSchema.parse(body).path;
}

/**
 * What is in the backup folder, or null when there is nothing to restore
 * (NEWS-252).
 *
 * Null rather than throwing for the ordinary cases — no folder chosen, no
 * backup in it — because "you have no backup here" is the answer to a question,
 * not a failure. A folder that holds a file this version cannot read *does*
 * throw, since that one is worth saying out loud.
 */
export async function fetchBackupPreview(): Promise<BackupPreview | null> {
  const res = await fetch('/api/backup/preview', { headers: { 'Content-Type': 'application/json' } });
  if (res.status === 400 || res.status === 404) return null;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `request failed (${String(res.status)})`;
    throw new Error(message);
  }
  return BackupPreviewRespSchema.parse(body).preview;
}

/**
 * Delete every story, keeping topics and settings (NEWS-255).
 *
 * Refreshes afterwards because the feed and every sidebar count are now wrong —
 * the 4-second poll would fix it eventually, and "eventually" after a
 * destructive action reads as the action not having worked.
 */
export async function clearAllStories(): Promise<{ cleared: number; cancelledChecks: number }> {
  const body = await request('/api/items/clear', { method: 'POST' });
  const { cleared, cancelledChecks } = ClearItemsRespSchema.parse(body);
  await refreshState();
  return { cleared, cancelledChecks };
}

/**
 * Delete every topic, and with it every story and run (FR-31.1, NEWS-328).
 *
 * Refreshes afterwards for the same reason `clearAllStories` does: the rail, the
 * feed and every count are now wrong, and waiting for the 4-second poll after a
 * destructive action reads as the action not having worked.
 */
export async function deleteAllTopics(): Promise<{ deleted: number; cancelledChecks: number }> {
  const body = await request('/api/topics/clear', { method: 'POST' });
  const { deleted, cancelledChecks } = ClearTopicsRespSchema.parse(body);
  await refreshState();
  return { deleted, cancelledChecks };
}

/** Load the preview into the store; a failure leaves the control hidden. */
export async function refreshBackupPreview(): Promise<void> {
  try {
    appStore.actions.setBackupPreview(await fetchBackupPreview());
  } catch {
    // An unreadable file is reported when someone actually tries to restore;
    // failing here would put an error on screen for merely opening a tab.
    appStore.actions.setBackupPreview(null);
  }
}

/** Replace everything with the backup in the configured folder (NEWS-252). */
export async function restoreBackup(): Promise<{ preview: BackupPreview; safetyCopy: string }> {
  const body = await request('/api/backup/restore', { method: 'POST' });
  const parsed = RestoreRespSchema.parse(body);
  // Everything on screen is now the *old* data — topics, stories, settings.
  await refreshState();
  return { preview: parsed.preview, safetyCopy: parsed.safetyCopy };
}

/**
 * Read a shared topic list back in (FR-30.5–30.9, NEWS-318).
 *
 * The file's text is posted as-is rather than parsed here: the server validates
 * it against the same schema either way, and doing it in one place means the
 * client cannot accept something the server would refuse. A parse error and a
 * schema error then arrive by the same road, with the server's wording.
 *
 * `refreshState()` afterwards because the topics rail is now wrong — nothing
 * else fires, since an import runs no check (FR-30.8).
 */
export async function importTopics(fileText: string): Promise<ImportTopicsResp> {
  const body = await request('/api/import-topics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: fileText,
  });
  const parsed = ImportTopicsRespSchema.parse(body);
  await refreshState();
  return parsed;
}

/**
 * Read an exported story archive back in (FR-30.10–30.14, NEWS-319).
 *
 * Same shape as `importTopics`: the file's text goes up as-is so one schema on
 * the server decides what is acceptable, and the client cannot accept something
 * the server would refuse.
 */
export async function importStories(fileText: string): Promise<ImportStoriesResp> {
  const body = await request('/api/import-stories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: fileText,
  });
  const parsed = ImportStoriesRespSchema.parse(body);
  // Topics *and* the feed may both have changed — an import can create topics.
  await refreshState();
  return parsed;
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

/**
 * Ask the server which models the configured provider offers (NEWS-248).
 *
 * On demand — when the Source tab opens or the provider changes — rather than
 * on the 4-second poll: it costs a vendor round trip and answers a question
 * only someone looking at the picker is asking.
 */
export async function refreshModels(): Promise<void> {
  try {
    const body = await request('/api/models');
    const parsed = ModelsRespSchema.parse(body);
    appStore.actions.setLiveModels(parsed.models, parsed.effortLevels);
  } catch {
    // Non-fatal by design — the picker falls back to the static suggestions.
    appStore.actions.setLiveModels([], null);
  }
}

/**
 * Who a suggestion or a check would be asked of (NEWS-258).
 *
 * The same three fields the server signs an in-flight check with, because they
 * are the ones that change *what comes back*. `endpoint` is left out: it moves
 * which host answers, not which model does, and the catalogue refresh below
 * already covers it.
 */
function providerSignature(s: { provider: string; model: string; effort: string }): string {
  return `${s.provider}|${s.model}|${s.effort}`;
}

export async function updateProviderSettings(patch: {
  provider?: ProviderName;
  model?: string;
  endpoint?: string;
  effort?: Effort;
}): Promise<void> {
  const before = providerSignature(appStore.state.value.settings);
  await withRefresh(() => request('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }));
  await refreshProviders();
  // The catalogue is per provider and per key, so a provider or endpoint change
  // invalidates it.
  await refreshModels();
  // And so do the suggestions on screen (NEWS-258). Settings opens *over* the
  // discovery pane — it sits above it on the Escape ladder — so changing
  // provider here and closing leaves the previous provider's ideas on display,
  // with a tuner whose kept/skipped rounds (FR-24.6) were counted against a
  // list nothing will produce again.
  //
  // Cleared rather than relabelled: a suggestion list is one cheap call to
  // regenerate, and there is no honest label for "these came from somewhere you
  // are no longer asking". The pane stays open on its browse grid, which is
  // where a fresh query starts anyway.
  if (
    appStore.state.value.discover !== null &&
    providerSignature(appStore.state.value.settings) !== before
  ) {
    appStore.actions.openDiscover();
  }
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
