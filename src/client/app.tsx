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
import { icon } from './icons.js';
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

/**
 * A topic row. Actions live in the right-click menu rather than inline
 * buttons — those were hidden until hover but still reserved their width, so
 * every topic name was truncated to pay for controls nobody could see.
 */
function topicRowJsx(
  topic: Topic,
  checking: boolean,
  intervalMs: number,
  selected: boolean,
  soloed: boolean,
  dimmed: boolean,
): SafeHtml {
  const classes = [
    'topic',
    topic.paused ? 'paused' : '',
    selected ? 'selected' : '',
    soloed ? 'soloed' : '',
    dimmed ? 'solo-dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <li class={classes} data-key={topic.id} data-topic-row={topic.id} aria-selected={selected ? 'true' : 'false'}>
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
      {/* Always-present slot so the badge appearing can't restructure the row. */}
      <span class="topic-flags" title={soloed ? 'Solo — only this topic\u2019s stories are shown' : ''}>
        {soloed ? icon('solo', 13) : ''}
      </span>
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
      {/* Always-present slot: the picture coming and going must not restructure
          the card (kerf KF-377 — see docs/3-ui.md). Roughly a third of articles
          publish no og:image, so "no picture" is the normal case, not an edge. */}
      <div class="item-media">
        {item.image !== null ? (
          <img
            src={`/api/image/${item.image.hash}`}
            alt=""
            loading="lazy"
            decoding="async"
            data-morph-skip-children
          />
        ) : (
          ''
        )}
      </div>
      <h3>{item.title}</h3>
      <p>{item.summary}</p>
      <ul class="sources">
        {/* `.map()`, not `each()`: sources are static per item (kerf Hard Rule 14),
            and keeping `each()` calls to a fixed set keeps list ids stable. */}
        {item.sources.map((source, i) => (
          <li data-key={`${item.id}-${i}`}>
            <a href={source.url} target="_blank" rel="noopener noreferrer" data-external="1">
              {icon('arrow', 13)}
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

/**
 * "Is the current source usable" line.
 *
 * Lives in the settings dialog beside the provider picker rather than in the
 * sidebar: the provider is chosen here, so this is where knowing whether it
 * actually works is useful. A provider that can't run still surfaces on the
 * page through the failed-check warning banner, so nothing is lost by not
 * repeating it in the sidebar.
 */
function sourceStatusJsx(): SafeHtml {
  const s = appStore.state.value;
  // The provider's name is not repeated here — the picker directly above says
  // it. This line carries only what the picker can't: whether it works.
  const availability = s.providers.find((p) => p.name === s.settings.provider)?.available ?? null;
  const lastProvider = s.runs.find((r) => r.provider !== null)?.provider ?? null;

  return (
    <p class="source-status">
      <span class="source-state">
        {availability === false ? <span class="state warn">{icon('warn', 12)} no API key</span> : ''}
        {availability === true ? <span class="state ok">{icon('ok', 12)} ready</span> : ''}
      </span>
      <span class="source-last">{lastProvider !== null ? `last check via ${lastProvider}` : ''}</span>
    </p>
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
        <span class="key-state ok">
          {icon('ok', 13)} from {key.envVar}
        </span>
        <span class="key-hint">Set in the environment — unset the variable to change it.</span>
      </div>
    );
  }

  if (key.source === 'keychain') {
    return (
      <div class="key-row" data-key={`key-${key.provider}`}>
        <span class="key-provider">{key.label}</span>
        <span class="key-state ok">
          {icon('ok', 13)} stored in {keychainLabel}
        </span>
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

/**
 * Whether a provider spends a personal subscription rather than a metered key.
 *
 * Kept as a small client-side list rather than plumbed through `/api/providers`:
 * it's static metadata, and the dialog only needs it to decide what to explain.
 */
function providerIsAttended(provider: ProviderName): boolean {
  return provider === 'claude-cli';
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
            {icon('clear', 17)}
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

        {sourceStatusJsx()}

        {/* Always-present slot: the note appears only for subscription-backed
            providers (kerf KF-377 — see docs/3-ui.md). */}
        <div class="source-note">
          {providerIsAttended(s.settings.provider) ? (
            <p class="note">
              Signed in through Claude Code — checks use your subscription, not an API key. Scheduled checks run only
              while News is open; “Check now” always works.
            </p>
          ) : (
            ''
          )}
        </div>

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
          {s.keysLoaded && !s.keychainAvailable ? (
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

/**
 * Right-click menu for the topic rows.
 *
 * Acts on `topicIds`, which is the whole selection when the click landed on a
 * selected row and just that row otherwise — the behaviour every OS file
 * manager has, and the reason bulk actions need no separate affordance.
 */
function contextMenuJsx(menu: NonNullable<AppState['contextMenu']>, topics: Topic[]): SafeHtml {
  const targets = topics.filter((t) => menu.topicIds.includes(t.id));
  const count = targets.length;
  const suffix = count > 1 ? ` ${String(count)} topics` : '';
  // With a mixed selection, offer the action that changes the most rows.
  const anyActive = targets.some((t) => !t.paused);
  const solo = new Set(appStore.state.value.soloTopicIds);
  const allSoloed = count > 0 && targets.every((t) => solo.has(t.id));

  return (
    <div class="menu-backdrop" data-action="close-menu">
      <div class="menu" role="menu" style={`left:${String(menu.x)}px;top:${String(menu.y)}px`}>
        <button class="menu-item" role="menuitem" type="button" data-menu-action="check">
          {icon('check')}
          <span>Check now{suffix}</span>
        </button>
        <button class="menu-item" role="menuitem" type="button" data-menu-action="pause">
          {icon(anyActive ? 'pause' : 'play')}
          <span>
            {anyActive ? 'Pause' : 'Resume'}
            {suffix}
          </span>
        </button>
        <div class="menu-sep" role="separator" />
        <button class="menu-item" role="menuitem" type="button" data-menu-action="solo">
          {icon('solo')}
          <span>{allSoloed ? 'Unsolo' : 'Solo'}{suffix}</span>
        </button>
        <div class="menu-sep" role="separator" />
        <button class="menu-item danger" role="menuitem" type="button" data-menu-action="delete">
          {icon('delete')}
          <span>Delete{suffix}</span>
        </button>
      </div>
    </div>
  );
}

function appJsx(): SafeHtml {
  const s = appStore.state.value;
  const topicNames = new Map(s.topics.map((t) => [t.id, t.name]));
  const solo = new Set(s.soloTopicIds);
  const selected = new Set(s.selectedTopicIds);
  const allItems = [...s.items].sort((a, b) => b.foundAt.localeCompare(a.foundAt));
  // Solo is a view filter: it hides stories, never deletes or unsubscribes.
  const sortedItems = solo.size > 0 ? allItems.filter((i) => solo.has(i.topicId)) : allItems;
  const anyChecking = s.checking.length > 0;
  const lastFailure = s.runs.find((r) => r.status === 'failed');

  return (
    <div class={`shell${s.sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <header class="app-header">
        <div class="header-left">
          <button
            class="btn icon"
            data-action="toggle-sidebar"
            aria-expanded={s.sidebarCollapsed ? 'false' : 'true'}
            aria-controls="topics-panel"
            aria-label={s.sidebarCollapsed ? 'Show topics' : 'Hide topics'}
            title={s.sidebarCollapsed ? 'Show topics' : 'Hide topics'}
          >
            {icon('panel', 17)}
          </button>
          <h1 class="wordmark">
            News<span class="mark-dot">.</span>
          </h1>
        </div>
        <div class="header-controls">
          <button class="btn icon" data-action="open-settings" aria-label="Settings" title="Settings">
            {icon('settings', 17)}
          </button>
          <button class="btn primary" data-action="check-all" disabled={anyChecking ? true : undefined}>
            {anyChecking ? 'Checking…' : 'Check all now'}
          </button>
        </div>
      </header>

      {/* Always-present container — the dialog appearing must not restructure
          its siblings (kerf KF-377 — see docs/3-ui.md). */}
      <div id="settings-slot">{s.settingsOpen ? settingsDialogJsx() : ''}</div>
      <div id="menu-slot">{s.contextMenu !== null ? contextMenuJsx(s.contextMenu, s.topics) : ''}</div>

      {/* Always-present container: banners coming and going must not shift the
          sections below (kerf KF-377 — see docs/3-ui.md). */}
      <div id="banners">
        {solo.size > 0 ? (
          <div class="banner solo">
            {icon('solo', 14)}
            <span>
              Showing {String(solo.size)} of {String(s.topics.length)} topics
            </span>
            <button class="btn subtle" type="button" data-action="clear-solo">
              Show all
            </button>
          </div>
        ) : (
          ''
        )}
        {s.error !== null ? <div class="banner error">{s.error}</div> : ''}
        {lastFailure !== undefined && s.error === null ? (
          <div class="banner warn">
            Last check for “{topicNames.get(lastFailure.topicId) ?? 'deleted topic'}” failed: {lastFailure.error ?? 'unknown error'}
          </div>
        ) : (
          ''
        )}
      </div>

      {/* Always rendered, hidden via CSS when collapsed: unmounting a sibling
          ahead of the keyed topics list is the kerf KF-377 hazard (docs/3-ui.md). */}
      <section id="topics-panel" class="topics-panel" aria-hidden={s.sidebarCollapsed ? 'true' : undefined}>
        <h2 class="eyebrow">Watching</h2>
        <ul class="topics">
          {each(
            s.topics,
            (topic) =>
              topicRowJsx(
                topic,
                s.checking.includes(topic.id),
                s.settings.checkIntervalMs,
                selected.has(topic.id),
                solo.has(topic.id),
                solo.size > 0 && !solo.has(topic.id),
              ),
            // `each()` memoizes per row on object identity, and selection/solo
            // live outside the topic object — so without this comparator a row
            // keeps its cached HTML and selecting it appears to do nothing until
            // the next poll happens to replace `topics` with fresh objects.
            (topic) =>
              `${String(selected.has(topic.id))}|${String(solo.has(topic.id))}|${String(solo.size)}|${String(
                s.checking.includes(topic.id),
              )}`,
          )}
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


/** Anchor for shift-range selection — the last row clicked without shift. */
let anchorId: string | null = null;

function selectTopic(id: string, mods: { toggle: boolean; range: boolean }): void {
  const { topics, selectedTopicIds } = appStore.state.value;
  if (mods.range && anchorId !== null) {
    const ids = topics.map((t) => t.id);
    const from = ids.indexOf(anchorId);
    const to = ids.indexOf(id);
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      appStore.actions.setSelection(ids.slice(lo, hi + 1));
      return;
    }
  }
  if (mods.toggle) {
    const next = selectedTopicIds.includes(id)
      ? selectedTopicIds.filter((x) => x !== id)
      : [...selectedTopicIds, id];
    appStore.actions.setSelection(next);
    anchorId = id;
    return;
  }
  appStore.actions.setSelection([id]);
  anchorId = id;
}

/** Prompt for and delete `ids`, naming what's about to go. */
function confirmDelete(ids: string[]): void {
  const { topics } = appStore.state.value;
  const names = topics.filter((t) => ids.includes(t.id)).map((t) => t.name);
  if (names.length === 0) return;
  const what =
    names.length === 1 ? `\u201c${names[0] ?? ''}\u201d` : `${String(names.length)} topics`;
  if (!window.confirm(`Delete ${what} and all of their stories?`)) return;
  appStore.actions.setSelection([]);
  void (async () => {
    for (const id of ids) await deleteTopic(id);
  })();
}

/** Apply a context-menu action to every targeted topic. */
function runTopicAction(action: string, ids: string[]): void {
  const { topics, soloTopicIds } = appStore.state.value;
  const targets = topics.filter((t) => ids.includes(t.id));
  switch (action) {
    case 'check':
      for (const t of targets) void startCheck(t.id);
      break;
    case 'pause': {
      // Mixed selections resolve toward the action that changes the most rows,
      // matching the label the menu showed.
      const pause = targets.some((t) => !t.paused);
      for (const t of targets) {
        if (t.paused === pause) continue;
        void setTopicPaused(t.id, pause);
      }
      break;
    }
    case 'solo': {
      const solo = new Set(soloTopicIds);
      const allSoloed = targets.length > 0 && targets.every((t) => solo.has(t.id));
      for (const t of targets) {
        if (allSoloed) solo.delete(t.id);
        else solo.add(t.id);
      }
      appStore.actions.setSolo([...solo]);
      break;
    }
    case 'delete':
      confirmDelete(ids);
      break;
    default:
      break;
  }
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

  void delegate(root, 'click', '[data-action=toggle-sidebar]', () => {
    appStore.actions.setSidebarCollapsed(!appStore.state.value.sidebarCollapsed);
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

  // --- topic selection -----------------------------------------------------

  void delegate(root, 'click', '[data-topic-row]', (e, el) => {
    const id = el.getAttribute('data-topic-row');
    if (id === null || !(e instanceof MouseEvent)) return;
    // Cmd on macOS, Ctrl elsewhere — reading both is simpler and more forgiving
    // than sniffing the platform, and no OS uses them for conflicting meanings.
    selectTopic(id, { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey });
  });

  void delegate(root, 'contextmenu', '[data-topic-row]', (e, el) => {
    const id = el.getAttribute('data-topic-row');
    if (id === null || !(e instanceof MouseEvent)) return;
    e.preventDefault();
    const current = appStore.state.value.selectedTopicIds;
    // Right-clicking inside the selection acts on all of it; right-clicking
    // outside it selects that row first, so the menu never acts on rows the
    // user can't see are targeted.
    const topicIds = current.includes(id) ? current : [id];
    if (!current.includes(id)) {
      appStore.actions.setSelection([id]);
      anchorId = id;
    }
    appStore.actions.openContextMenu({ x: e.clientX, y: e.clientY, topicIds });
  });

  // Only a click that landed on the backdrop itself dismisses. The backdrop
  // wraps the menu, so matching descendants too would close the menu before the
  // item handler below could read `contextMenu` — the same trap the settings
  // dialog hit (see docs/3-ui.md).
  void delegate(root, 'click', '[data-action=close-menu]', (e, el) => {
    if (e.target === el) appStore.actions.closeContextMenu();
  });

  void delegate(root, 'click', '[data-menu-action]', (_e, el) => {
    const action = el.getAttribute('data-menu-action');
    const menu = appStore.state.value.contextMenu;
    if (action === null || menu === null) return;
    appStore.actions.closeContextMenu();
    runTopicAction(action, menu.topicIds);
  });

  void delegate(root, 'click', '[data-action=clear-solo]', () => {
    appStore.actions.setSolo([]);
  });

  void delegate(root, 'click', 'a[data-external]', (e, el) => {
    const url = el.getAttribute('href');
    if (url !== null && openExternalUrl(url)) e.preventDefault();
  });
}

/**
 * Global interactions that aren't scoped to one element: dismissing the
 * selection and menu, and the Delete key.
 */
function wireGlobalKeysAndDismiss(): void {
  document.addEventListener('mousedown', (e) => {
    if (!(e.target instanceof Element)) return;
    // A click on a row, or inside the menu, is handled by its own delegate.
    if (e.target.closest('[data-topic-row]') !== null) return;
    if (e.target.closest('.menu') !== null) return;
    const { selectedTopicIds, contextMenu } = appStore.state.value;
    if (contextMenu !== null) appStore.actions.closeContextMenu();
    if (selectedTopicIds.length > 0) appStore.actions.setSelection([]);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      appStore.actions.closeContextMenu();
      appStore.actions.setSelection([]);
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    // Never steal Backspace from the add-topic field — deleting a character
    // must not delete a topic.
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    const { selectedTopicIds } = appStore.state.value;
    if (selectedTopicIds.length === 0) return;
    e.preventDefault();
    confirmDelete(selectedTopicIds);
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
  wireGlobalKeysAndDismiss();
  void refreshState();
  void refreshProviders();
  startPolling();
  startForegroundHeartbeat();
}
