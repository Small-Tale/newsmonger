import type { SafeHtml } from 'kerfjs';
import { delegate, each, mount } from 'kerfjs';

import type { ProviderName } from '../ai/types.js';
import { PROVIDER_INFO, PROVIDER_NAMES } from '../ai/types.js';
import type { NewsItem, Topic } from '../db/schemas.js';
import {
  addTopic,
  deleteKey,
  deleteTopic,
  refreshKeys,
  refreshProviders,
  refreshState,
  reportForeground,
  saveKey,
  setTopicPaused,
  startCheck,
  updateInterval,
  updateProviderSettings,
} from './api.js';
import type { AppState } from './stores.js';
import { appStore } from './stores.js';
import { openExternalUrl } from './tauri.js';

const INTERVAL_OPTIONS: { label: string; ms: number }[] = [
  { label: 'Every hour', ms: 60 * 60 * 1000 },
  { label: 'Every 3 hours', ms: 3 * 60 * 60 * 1000 },
  { label: 'Every 6 hours', ms: 6 * 60 * 60 * 1000 },
  { label: 'Every 12 hours', ms: 12 * 60 * 60 * 1000 },
  { label: 'Every day', ms: 24 * 60 * 60 * 1000 },
  { label: 'Every 2 days', ms: 48 * 60 * 60 * 1000 },
  { label: 'Every week', ms: 7 * 24 * 60 * 60 * 1000 },
];

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Label for a feed day group: Today, Yesterday, or "Jul 20". */
function dayLabel(dateKey: string): string {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const keyOf = (d: Date): string => d.toLocaleDateString('en-CA'); // YYYY-MM-DD, local tz
  if (dateKey === keyOf(today)) return 'Today';
  if (dateKey === keyOf(yesterday)) return 'Yesterday';
  const d = new Date(`${dateKey}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const DIAL_R = 8;
const DIAL_C = 2 * Math.PI * DIAL_R;

/**
 * The watch dial: a ring that fills as the next scheduled check approaches.
 * Spins while checking; dashed while paused; empty when never checked.
 */
function dialJsx(topic: Topic, checking: boolean, intervalMs: number): SafeHtml {
  let fraction = 0;
  if (topic.lastCheckedAt !== null && !topic.paused) {
    fraction = Math.min(1, Math.max(0, (Date.now() - Date.parse(topic.lastCheckedAt)) / intervalMs));
  }
  const filled = (fraction * DIAL_C).toFixed(1);
  const state = checking ? 'checking' : topic.paused ? 'paused' : 'watching';
  const title = checking
    ? 'Checking now'
    : topic.paused
      ? 'Paused'
      : topic.lastCheckedAt === null
        ? 'Waiting for first check'
        : `${Math.round(fraction * 100)}% of the way to the next check`;
  return (
    <span class={`dial ${state}`} title={title} aria-hidden="true">
      <svg viewBox="0 0 20 20" width="20" height="20">
        <circle class="dial-track" cx="10" cy="10" r={String(DIAL_R)} />
        <circle
          class="dial-fill"
          cx="10"
          cy="10"
          r={String(DIAL_R)}
          stroke-dasharray={checking ? `${(DIAL_C * 0.3).toFixed(1)} ${DIAL_C.toFixed(1)}` : `${filled} ${DIAL_C.toFixed(1)}`}
        />
      </svg>
    </span>
  );
}

function topicRowJsx(topic: Topic, checking: boolean, intervalMs: number): SafeHtml {
  return (
    <li class={`topic${topic.paused ? ' paused' : ''}`} data-key={topic.id}>
      {dialJsx(topic, checking, intervalMs)}
      <div class="topic-main">
        <span class="topic-name">{topic.name}</span>
        <span class="topic-meta">
          {checking
            ? 'checking…'
            : topic.paused
              ? 'paused'
              : topic.lastCheckedAt !== null
                ? `checked ${relativeTime(topic.lastCheckedAt)}`
                : 'not checked yet'}
        </span>
      </div>
      <div class="topic-actions">
        <button class="chip" data-check-topic={topic.id} disabled={checking ? true : undefined} title="Check this topic now">
          Check
        </button>
        <button class="chip" data-toggle-topic={topic.id} title={topic.paused ? 'Resume checks' : 'Pause checks'}>
          {topic.paused ? 'Resume' : 'Pause'}
        </button>
        <button class="chip danger" data-delete-topic={topic.id} title="Delete this topic and its stories">
          Delete
        </button>
      </div>
    </li>
  );
}

function itemJsx(item: NewsItem, topicName: string): SafeHtml {
  return (
    <article class="item" data-key={item.id}>
      <header>
        <span class="item-topic">{topicName}</span>
        <span class="item-time">{relativeTime(item.foundAt)}</span>
      </header>
      <h3>{item.title}</h3>
      <p>{item.summary}</p>
      <ul class="sources">
        {/* `.map()`, not `each()`: sources are static per item (kerf Hard Rule 14),
            and keeping `each()` calls to a fixed set keeps list ids stable. */}
        {item.sources.map((source, i) => (
          <li data-key={`${item.id}-${i}`}>
            <a href={source.url} target="_blank" rel="noopener noreferrer" data-external="1">
              {source.title !== '' ? source.title : source.url}
            </a>
          </li>
        ))}
      </ul>
    </article>
  );
}

function feedJsx(items: NewsItem[], topicNames: Map<string, string>): SafeHtml[] {
  // Group by local calendar day, newest first. Groups are dynamic, so plain
  // `.map()` (no memoization); items keep data-key for keyed morphing.
  const groups = new Map<string, NewsItem[]>();
  for (const item of items) {
    const key = new Date(item.foundAt).toLocaleDateString('en-CA');
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].map(([dateKey, dayItems]) => (
    <section class="day" data-key={`day-${dateKey}`}>
      <h2 class="eyebrow">{dayLabel(dateKey)}</h2>
      {dayItems.map((item) => itemJsx(item, topicNames.get(item.topicId) ?? 'unknown topic'))}
    </section>
  ));
}

/** Compact "is the current source usable" line, shown in the topics panel. */
function sourceJsx(): SafeHtml {
  const s = appStore.state.value;
  const provider = s.settings.provider;
  const availability = s.providers.find((p) => p.name === provider)?.available ?? null;
  const lastProvider = s.runs.find((r) => r.provider !== null)?.provider ?? null;

  return (
    <div class="source">
      <h2 class="eyebrow">Source</h2>
      <p class="source-status">
        <span class="source-name">{PROVIDER_INFO[provider].label}</span>
        {availability === false ? ' · ⚠ no API key — open Settings' : ''}
        {availability === true ? ' · ✓ ready' : ''}
        {lastProvider !== null ? ` · last check via ${lastProvider}` : ''}
      </p>
    </div>
  );
}

/**
 * One provider's key row.
 *
 * Three states, because they call for different controls: supplied by the
 * environment (nothing to do here — the app can't unset a variable it didn't
 * set), stored in the keychain (offer removal), or absent (offer an input).
 * The stored key is never rendered; when one exists there is no field at all,
 * so there's nothing for a screenshot or a password manager to pick up.
 */
function keyRowJsx(key: AppState['keys'][number], keychainLabel: string, keychainAvailable: boolean): SafeHtml {
  const inputId = `key-input-${key.provider}`;

  if (key.source === 'env') {
    return (
      <div class="key-row" data-key={`key-${key.provider}`}>
        <span class="key-provider">{key.label}</span>
        <span class="key-state ok">✓ from {key.envVar}</span>
        <span class="key-hint">Set in the environment — unset the variable to change it.</span>
      </div>
    );
  }

  if (key.source === 'keychain') {
    return (
      <div class="key-row" data-key={`key-${key.provider}`}>
        <span class="key-provider">{key.label}</span>
        <span class="key-state ok">✓ stored in {keychainLabel}</span>
        <button class="btn subtle" type="button" data-remove-key={key.provider}>
          Remove
        </button>
      </div>
    );
  }

  return (
    <div class="key-row" data-key={`key-${key.provider}`}>
      <span class="key-provider">{key.label}</span>
      <form class="key-form" data-save-key={key.provider}>
        <input
          type="password"
          id={inputId}
          name="api-key"
          class="key-input"
          placeholder={keychainAvailable ? 'Paste API key' : `Set ${key.envVar} instead`}
          autocomplete="off"
          spellcheck={false}
          disabled={keychainAvailable ? undefined : true}
          data-morph-skip-children
        />
        <button class="btn" type="submit" disabled={keychainAvailable ? undefined : true}>
          Save
        </button>
      </form>
    </div>
  );
}

function settingsDialogJsx(): SafeHtml {
  const s = appStore.state.value;
  const provider = s.settings.provider;
  const info = PROVIDER_INFO[provider];

  return (
    <div class="dialog-backdrop" data-action="settings-backdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div class="dialog-head">
          <h2 id="settings-title">Settings</h2>
          <button class="btn icon" type="button" data-action="close-settings" aria-label="Close settings">
            ✕
          </button>
        </div>

        <label class="field">
          <span class="field-label">Check every</span>
          <select data-action="interval">
            {INTERVAL_OPTIONS.map((opt) => (
              <option value={String(opt.ms)} selected={opt.ms === s.settings.checkIntervalMs ? true : undefined}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <h3 class="eyebrow">Source</h3>
        <label class="field">
          <span class="field-label">Provider</span>
          <select data-action="provider" title="Which AI finds and summarizes news">
            {PROVIDER_NAMES.map((name) => (
              <option value={name} selected={name === provider ? true : undefined}>
                {PROVIDER_INFO[name].label}
              </option>
            ))}
          </select>
        </label>

        {/* Always-present container: conditional fields must not appear and
            disappear as siblings (kerf KF-377 — see docs/3-ui.md). */}
        <div class="source-fields">
          {provider !== 'auto' && provider !== 'mock' ? (
            <label class="field">
              <span class="field-label">Model</span>
              <input
                type="text"
                class="source-field"
                name="model"
                value={s.settings.model}
                placeholder="default"
                autocomplete="off"
                data-action="model"
                data-morph-skip-children
              />
            </label>
          ) : (
            ''
          )}
          {info.endpointConfigurable ? (
            <label class="field">
              <span class="field-label">Endpoint</span>
              <input
                type="text"
                class="source-field"
                name="endpoint"
                value={s.settings.endpoint}
                placeholder="default"
                autocomplete="off"
                data-action="endpoint"
                data-morph-skip-children
              />
            </label>
          ) : (
            ''
          )}
        </div>

        <h3 class="eyebrow">API keys</h3>
        <div class="keys">{s.keys.map((k) => keyRowJsx(k, s.keychainLabel, s.keychainAvailable))}</div>

        <div class="key-notes">
          {s.keyError !== null ? <p class="banner error">{s.keyError}</p> : ''}
          {!s.keychainAvailable ? (
            <p class="note warn">
              No {s.keychainLabel} is available here, so keys can't be saved from the app. Set the environment
              variables above instead.
            </p>
          ) : (
            ''
          )}
        </div>
        <p class="note">
          Keys are stored in your {s.keychainLabel} — never in ~/.news/data.json, and never sent anywhere but the
          provider you chose.
        </p>
      </div>
    </div>
  );
}

function appJsx(): SafeHtml {
  const s = appStore.state.value;
  const topicNames = new Map(s.topics.map((t) => [t.id, t.name]));
  const sortedItems = [...s.items].sort((a, b) => b.foundAt.localeCompare(a.foundAt));
  const anyChecking = s.checking.length > 0;
  const lastFailure = s.runs.find((r) => r.status === 'failed');

  return (
    <div class="shell">
      <header class="app-header">
        <h1 class="wordmark">
          News<span class="mark-dot">.</span>
        </h1>
        <div class="header-controls">
          <button class="btn icon" data-action="open-settings" aria-label="Settings" title="Settings">
            ⚙
          </button>
          <button class="btn primary" data-action="check-all" disabled={anyChecking ? true : undefined}>
            {anyChecking ? 'Checking…' : 'Check all now'}
          </button>
        </div>
      </header>

      {/* Always-present container — the dialog appearing must not restructure
          its siblings (kerf KF-377 — see docs/3-ui.md). */}
      <div id="settings-slot">{s.settingsOpen ? settingsDialogJsx() : ''}</div>

      {/* Always-present container: banners coming and going must not shift the
          sections below (kerf KF-377 — see docs/3-ui.md). */}
      <div id="banners">
        {s.error !== null ? <div class="banner error">{s.error}</div> : ''}
        {lastFailure !== undefined && s.error === null ? (
          <div class="banner warn">
            Last check for “{topicNames.get(lastFailure.topicId) ?? 'deleted topic'}” failed: {lastFailure.error ?? 'unknown error'}
          </div>
        ) : (
          ''
        )}
      </div>

      <section id="topics-panel" class="topics-panel">
        {sourceJsx()}
        <h2 class="eyebrow">Watching</h2>
        <ul class="topics">
          {each(s.topics, (topic) => topicRowJsx(topic, s.checking.includes(topic.id), s.settings.checkIntervalMs))}
        </ul>
        <div class="empty-slot">
          {s.loaded && s.topics.length === 0 ? (
            <p class="empty">Nothing is being watched yet. Add a topic below — News checks it on your schedule and reports only what's new.</p>
          ) : (
            ''
          )}
        </div>
        <form class="add-topic" data-action="add-topic-form">
          <input
            type="text"
            name="topic-name"
            placeholder="Watch a topic — “solid-state batteries”"
            autocomplete="off"
            data-morph-skip-children
          />
          <button class="btn" type="submit">
            Add
          </button>
        </form>
      </section>

      <section id="feed" class="feed">
        {feedJsx(sortedItems, topicNames)}
        <div class="empty-slot">
          {s.loaded && sortedItems.length === 0 && s.topics.length > 0 ? (
            <p class="empty">No stories yet. Check now, or let the next scheduled check run — only genuinely new news lands here.</p>
          ) : (
            ''
          )}
        </div>
      </section>
    </div>
  );
}

function wireEvents(root: HTMLElement): void {
  void delegate(root, 'submit', '[data-action=add-topic-form]', (e, form) => {
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>('input[name=topic-name]');
    if (!input) return;
    const name = input.value.trim();
    if (name === '') return;
    input.value = '';
    void addTopic(name);
  });

  void delegate(root, 'change', '[data-action=interval]', (_e, el) => {
    const ms = Number.parseInt((el as HTMLSelectElement).value, 10);
    if (!Number.isNaN(ms)) void updateInterval(ms);
  });

  void delegate(root, 'change', '[data-action=provider]', (_e, el) => {
    void updateProviderSettings({ provider: (el as HTMLSelectElement).value as ProviderName });
  });

  // Persist model / endpoint on change (blur or Enter), not every keystroke.
  void delegate(root, 'change', '[data-action=model]', (_e, el) => {
    void updateProviderSettings({ model: (el as HTMLInputElement).value.trim() });
  });
  void delegate(root, 'change', '[data-action=endpoint]', (_e, el) => {
    void updateProviderSettings({ endpoint: (el as HTMLInputElement).value.trim() });
  });

  void delegate(root, 'click', '[data-action=check-all]', () => {
    void startCheck();
  });

  void delegate(root, 'click', '[data-action=open-settings]', () => {
    appStore.actions.setSettingsOpen(true);
    // Status can go stale while the dialog is closed — a key added in another
    // window, or an environment variable set since load.
    void refreshKeys();
    void refreshProviders();
  });

  void delegate(root, 'click', '[data-action=close-settings]', () => {
    appStore.actions.setSettingsOpen(false);
  });

  // Backdrop click-away. This deliberately does NOT share the close action:
  // delegation matches against the target's ancestors, and the backdrop wraps
  // the whole dialog — so every click inside it, including Save, would match a
  // `[data-action=close-settings]` backdrop and dismiss the dialog mid-submit.
  // Only a click that landed on the backdrop itself should close.
  void delegate(root, 'click', '[data-action=settings-backdrop]', (e, el) => {
    if (e.target === el) appStore.actions.setSettingsOpen(false);
  });

  void delegate(root, 'submit', '[data-save-key]', (e, form) => {
    e.preventDefault();
    const provider = form.getAttribute('data-save-key');
    const input = form.querySelector<HTMLInputElement>('input[name=api-key]');
    if (provider === null || !input) return;
    const key = input.value.trim();
    if (key === '') return;
    void saveKey(provider, key).then((ok) => {
      // Clear the field either way: on success it's stored, and on failure
      // leaving a key sitting in the DOM serves no purpose.
      input.value = '';
      return ok;
    });
  });

  void delegate(root, 'click', '[data-remove-key]', (_e, el) => {
    const provider = el.getAttribute('data-remove-key');
    if (provider === null) return;
    const label = appStore.state.value.keys.find((k) => k.provider === provider)?.label ?? provider;
    if (window.confirm(`Remove the stored ${label} API key?`)) void deleteKey(provider);
  });

  void delegate(root, 'click', '[data-check-topic]', (_e, el) => {
    const id = el.getAttribute('data-check-topic');
    if (id !== null) void startCheck(id);
  });

  void delegate(root, 'click', '[data-toggle-topic]', (_e, el) => {
    const id = el.getAttribute('data-toggle-topic');
    if (id === null) return;
    const topic = appStore.state.value.topics.find((t) => t.id === id);
    if (topic) void setTopicPaused(id, !topic.paused);
  });

  void delegate(root, 'click', '[data-delete-topic]', (_e, el) => {
    const id = el.getAttribute('data-delete-topic');
    if (id === null) return;
    const topic = appStore.state.value.topics.find((t) => t.id === id);
    if (topic && window.confirm(`Delete “${topic.name}” and all of its stories?`)) {
      void deleteTopic(id);
    }
  });

  void delegate(root, 'click', 'a[data-external]', (e, el) => {
    const url = el.getAttribute('href');
    if (url !== null && openExternalUrl(url)) e.preventDefault();
  });
}

function startPolling(): void {
  setInterval(() => {
    if (document.visibilityState === 'visible') void refreshState();
  }, 4000);
}

/** Is the app actually in front of the user right now? */
function isForegrounded(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * Heartbeat that permits scheduled checks on subscription-backed providers.
 *
 * Sent on an interval comfortably shorter than the server's window, plus
 * immediately on the events that can make the app foregrounded, so returning
 * to it takes effect at once instead of after the next tick.
 */
function startForegroundHeartbeat(): void {
  const beat = (): void => {
    if (isForegrounded()) void reportForeground();
  };
  beat();
  setInterval(beat, 60_000);
  window.addEventListener('focus', beat);
  document.addEventListener('visibilitychange', beat);
}

const root = document.getElementById('app');
if (root) {
  mount(root, () => appJsx());
  wireEvents(root);
  void refreshState();
  void refreshProviders();
  startPolling();
  startForegroundHeartbeat();
}
