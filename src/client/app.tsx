import type { SafeHtml } from 'kerfjs';
import { delegate, each, mount } from 'kerfjs';

import type { NewsItem, Topic } from '../db/schemas.js';
import { addTopic, deleteTopic, refreshState, setTopicPaused, startCheck, updateInterval } from './api.js';
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

function topicRowJsx(topic: Topic, checking: boolean): SafeHtml {
  return (
    <li class={`topic${topic.paused ? ' paused' : ''}`} data-key={topic.id}>
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
        <button class="btn small" data-check-topic={topic.id} disabled={checking ? true : undefined} title="Check now">
          Check
        </button>
        <button class="btn small" data-toggle-topic={topic.id} title={topic.paused ? 'Resume checks' : 'Pause checks'}>
          {topic.paused ? 'Resume' : 'Pause'}
        </button>
        <button class="btn small danger" data-delete-topic={topic.id} title="Delete topic and its stories">
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

function appJsx(): SafeHtml {
  const s = appStore.state.value;
  const topicNames = new Map(s.topics.map((t) => [t.id, t.name]));
  const sortedItems = [...s.items].sort((a, b) => b.foundAt.localeCompare(a.foundAt));
  const anyChecking = s.checking.length > 0;
  const lastFailure = s.runs.find((r) => r.status === 'failed');

  return (
    <div class="shell">
      <header class="app-header">
        <h1>News</h1>
        <div class="header-controls">
          <label class="interval-label">
            Check
            <select data-action="interval">
              {INTERVAL_OPTIONS.map((opt) => (
                <option value={String(opt.ms)} selected={opt.ms === s.settings.checkIntervalMs ? true : undefined}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <button class="btn" data-action="check-all" disabled={anyChecking ? true : undefined}>
            {anyChecking ? 'Checking…' : 'Check all now'}
          </button>
        </div>
      </header>

      {/* Always-present container: banners coming and going must not shift the
          sections below, or kerf's positional sibling matching scrambles them. */}
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
        <form class="add-topic" data-action="add-topic-form">
          <input
            type="text"
            name="topic-name"
            placeholder="Add a topic to follow, e.g. “fusion energy”"
            autocomplete="off"
            data-morph-skip-children
          />
          <button class="btn primary" type="submit">
            Add topic
          </button>
        </form>
        <ul class="topics">{each(s.topics, (topic) => topicRowJsx(topic, s.checking.includes(topic.id)))}</ul>
        {s.loaded && s.topics.length === 0 ? (
          <p class="empty">No topics yet. Add one above — the app will check for news on your schedule.</p>
        ) : (
          ''
        )}
      </section>

      <section id="feed" class="feed">
        {each(sortedItems, (item) => itemJsx(item, topicNames.get(item.topicId) ?? 'unknown topic'))}
        {s.loaded && sortedItems.length === 0 && s.topics.length > 0 ? (
          <p class="empty">Nothing found yet. Hit “Check all now” or wait for the next scheduled check.</p>
        ) : (
          ''
        )}
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
  startPolling();
}
