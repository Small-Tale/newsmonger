import type { SafeHtml } from 'kerfjs';
import { delegate, each, mount } from 'kerfjs';

import type { ProviderName } from '../ai/types.js';
import { PROVIDER_INFO, PROVIDER_NAMES } from '../ai/types.js';
import type { NewsItem, Topic } from '../db/schemas.js';
import {
  addTopic,
  deleteTopic,
  refreshProviders,
  refreshState,
  setTopicPaused,
  startCheck,
  updateInterval,
  updateProviderSettings,
} from './api.js';
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

function sourceJsx(): SafeHtml {
  const s = appStore.state.value;
  const provider = s.settings.provider;
  const info = PROVIDER_INFO[provider];
  const availability = s.providers.find((p) => p.name === provider)?.available ?? null;
  const lastProvider = s.runs.find((r) => r.provider !== null)?.provider ?? null;

  return (
    <div class="source">
      <h2 class="eyebrow">Source</h2>
      <select data-action="provider" title="Which AI finds and summarizes news">
        {PROVIDER_NAMES.map((name) => (
          <option value={name} selected={name === provider ? true : undefined}>
            {PROVIDER_INFO[name].label}
          </option>
        ))}
      </select>
      {provider !== 'auto' && provider !== 'mock' ? (
        <input
          type="text"
          class="source-field"
          name="model"
          value={s.settings.model}
          placeholder="model (optional)"
          autocomplete="off"
          data-action="model"
          data-morph-skip-children
        />
      ) : (
        ''
      )}
      {info.endpointConfigurable ? (
        <input
          type="text"
          class="source-field"
          name="endpoint"
          value={s.settings.endpoint}
          placeholder="endpoint (optional)"
          autocomplete="off"
          data-action="endpoint"
          data-morph-skip-children
        />
      ) : (
        ''
      )}
      <p class="source-status">
        {availability === false ? '⚠ not available — check the key/endpoint' : ''}
        {availability === true ? '✓ ready' : ''}
        {lastProvider !== null ? `${availability === null ? '' : ' · '}last check via ${lastProvider}` : ''}
      </p>
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
          <label class="interval-label">
            <span class="eyebrow">Check</span>
            <select data-action="interval">
              {INTERVAL_OPTIONS.map((opt) => (
                <option value={String(opt.ms)} selected={opt.ms === s.settings.checkIntervalMs ? true : undefined}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <button class="btn primary" data-action="check-all" disabled={anyChecking ? true : undefined}>
            {anyChecking ? 'Checking…' : 'Check all now'}
          </button>
        </div>
      </header>

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

const root = document.getElementById('app');
if (root) {
  mount(root, () => appJsx());
  wireEvents(root);
  void refreshState();
  void refreshProviders();
  startPolling();
}
