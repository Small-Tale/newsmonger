/**
 * The Watching rail: a topic's dial, its row, and the row's context menu
 * (NEWS-297).
 *
 * Sixth seam out of `app.tsx`. The two blocks were ~700 lines apart in the old
 * file — the rail near the top, its menu down among the other overlays — which
 * is exactly the distance this split exists to close: the menu's items *are* the
 * row's actions, and changing one almost always means reading the other.
 *
 * **`filterBarJsx` is deliberately not here.** It sits between these two in the
 * source and looks like it belongs, but it filters the *feed* by taxonomy
 * section; it happens to be rendered above the rail rather than being part of
 * it. Likewise `itemMenuJsx` — a *story's* menu, which belongs with the feed.
 * Proximity in one file is not a view boundary, and inheriting it would be how
 * the next split starts from a wrong grouping.
 *
 * Rendering only. `data-menu-action`, the row's click/dblclick/contextmenu
 * gestures and the sort `<select>` are all handled by `delegate()` in `app.tsx`
 * (NEWS-126). `#topics-panel` — the target of the sidebar toggle's
 * `aria-controls` — stays in the shell with the element that points at it.
 */

import type { SafeHtml } from 'kerfjs';

import { BUILTIN_CATEGORIES, categoryLabel } from '../categories.js';
import type { Topic } from '../db/schemas.js';
import { relativeTime } from './dates.js';
import { dialCountdownMs, dialRemaining, formatCountdown } from './dial.js';
import { icon } from './icons.js';
import { menuStyle } from './menu-position.js';
import { isAllSoloed } from './solo.js';
import type { AppState } from './stores.js';
import { appStore } from './stores.js';

/** The dial's radius and circumference — only `dialJsx` has ever used them. */
const DIAL_R = 8;
const DIAL_C = 2 * Math.PI * DIAL_R;

/**
 * The watch dial: a ring that drains as the next scheduled check approaches.
 * Spins while checking; dashed while paused; full when there is nothing to count
 * from (never checked, or checked at an unreadable time).
 */
function dialJsx(topic: Topic, checking: boolean, intervalMs: number): SafeHtml {
  // Counts **down** (NEWS-144): full just after a check, empty as the next one
  // comes due. A ring that fills up reads as progress toward something the user
  // is waiting for, which is backwards — what is draining here is the time left
  // before the app acts on its own.
  const remaining = dialRemaining(topic, intervalMs);
  const filled = (remaining * DIAL_C).toFixed(1);
  const state = checking ? 'checking' : topic.paused ? 'paused' : 'watching';
  // A duration, not a percentage (NEWS-202). "3% of the interval left" made the
  // reader do the arithmetic — and they can't, because the tooltip never said what
  // the interval was. The ring already conveys the proportion; the tooltip's job is
  // the thing the ring can't show.
  const countdown = dialCountdownMs(topic, intervalMs);
  // `countdown === null` is the whole test for "nothing to count from" — it
  // already covers a never-checked topic, and asking `lastCheckedAt === null`
  // as well would claim a *cleared* topic was waiting for its first check while
  // the ring beside it visibly counted down to the next one (NEWS-291).
  const title = checking
    ? 'Checking now'
    : topic.paused
      ? 'Paused'
      : countdown === null
        ? 'Waiting for first check'
        : `Next check ${formatCountdown(countdown)}`;
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
export function topicRowJsx(
  topic: Topic,
  checking: boolean,
  intervalMs: number,
  selected: boolean,
  soloed: boolean,
  dimmed: boolean,
  /** This row is the *only* one selected — see the guidance clamp (NEWS-143). */
  soleSelection: boolean,
  /** Stories found today for this topic; 0 renders nothing (NEWS-242). */
  todayCount: number,
  /** Whether this topic holds any stories at all (NEWS-273). */
  hasStories: boolean,
): SafeHtml {
  const classes = [
    'topic',
    topic.paused ? 'paused' : '',
    topic.highPriority ? 'high-priority' : '',
    selected ? 'selected' : '',
    soloed ? 'soloed' : '',
    dimmed ? 'solo-dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <li
      class={classes}
      data-key={topic.id}
      data-topic-row={topic.id}
      role="option"
      // Every row is tabbable rather than a roving tabindex: the list is short
      // (a sidebar of topics), and roving focus would need the arrow-key
      // handling this app doesn't otherwise have.
      tabindex="0"
      aria-selected={selected ? 'true' : 'false'}
    >
      {/* Dial and badges share the left gutter, stacked (NEWS-163). The badges
          were pinned to the row's right edge, so on a two-line title they sat a
          long way from anything they described; under the dial they read as one
          column of status about this topic. */}
      <span class="topic-aside">
        {dialJsx(topic, checking, intervalMs)}
        {/* Always-present slot so the badge appearing can't restructure the row. */}
        <span class="topic-flags">
          {topic.highPriority ? (
            <span class="flag high-priority" title="High priority: checked on the shorter interval">
              {icon('star', 13)}
            </span>
          ) : (
            ''
          )}
          {soloed ? <span class="flag">{icon('solo', 13)}</span> : ''}
          {/* Stories found today (NEWS-242). Hidden at zero rather than shown as
              "0": a column of zeros down a quiet sidebar is noise that trains
              you to stop reading the badge, which costs the one day it matters.
              The count excludes off-topic stories, matching what the feed will
              actually show if you click. */}
          {todayCount > 0 ? (
            <span
              class="flag today-count"
              title={`${String(todayCount)} ${todayCount === 1 ? 'story' : 'stories'} found today`}
            >
              {String(todayCount)}
            </span>
          ) : (
            ''
          )}
        </span>
      </span>
      <div class="topic-main">
        <span class="topic-name">{topic.name}</span>
        <span class="topic-meta">
          {checking
            ? 'checking…'
            : topic.paused
              ? 'paused'
              : topic.lastCheckedAt !== null
                ? // "checked 1d ago" alone implied we were holding what it found,
                  // which reads as a failed clear once the feed is empty
                  // (NEWS-273). The time still matters — it is what the dial
                  // counts down from — so it is qualified rather than replaced.
                  `checked ${relativeTime(topic.lastCheckedAt)}${hasStories ? '' : ' · no stories'}`
                : 'not checked yet'}
        </span>
        {/* Its own line, below the name and status (NEWS-111). Sharing the row
            meant the label and the topic name competed for the same ~320px and
            both lost — "Consumer Tech" truncated to "CONSUMER …" while "Apple
            (the company…)" lost its tail. A full line fits the whole path and
            gives the name back the width the badge was taking. */}
        {topic.category === null ? (
          ''
        ) : (
          <span class="topic-category">
            {categoryLabel(BUILTIN_CATEGORIES, topic.category, topic.subcategory)}
          </span>
        )}
        {/* The guidance itself rather than an icon standing for it (NEWS-143):
            an icon says only *that* a topic is steered, which is the least
            useful half of the fact. Clamped to two lines, and to ten when this
            is the only row selected — a sole selection is the one moment the
            user is asking about this topic in particular. */}
        <div class="topic-guidance-slot">
          {topic.guidance === '' ? (
            ''
          ) : (
            <p class={`topic-guidance${soleSelection ? ' expanded' : ''}`}>{topic.guidance}</p>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Right-click menu for the topic rows.
 *
 * Acts on `topicIds`, which is the whole selection when the click landed on a
 * selected row and just that row otherwise — the behaviour every OS file
 * manager has, and the reason bulk actions need no separate affordance.
 */
export function contextMenuJsx(menu: NonNullable<AppState['contextMenu']>, topics: Topic[]): SafeHtml {
  const targets = topics.filter((t) => menu.topicIds.includes(t.id));
  const count = targets.length;
  const suffix = count > 1 ? ` ${String(count)} topics` : '';
  // With a mixed selection, offer the action that changes the most rows.
  const anyActive = targets.some((t) => !t.paused);
  const anyNormal = targets.some((t) => !t.highPriority);
  const allSoloed = isAllSoloed(appStore.state.value.soloTopicIds, targets.map((t) => t.id));
  // Guidance is a paragraph about *one* topic, so it's offered only when
  // exactly one is targeted — there is nothing sensible to write across a mix.
  const only = count === 1 ? targets[0] : undefined;
  // Flagged-story count across the targeted topics, for "Review Flagged"
  // (NEWS-61) — from the server aggregate now that the feed is paginated (NEWS-76).
  const flaggedByTopic = appStore.state.value.flaggedByTopic;
  const flaggedCount = menu.topicIds.reduce((sum, id) => sum + (flaggedByTopic[id] ?? 0), 0);

  return (
    <div class="menu-backdrop" data-action="close-menu">
      <div class="menu" role="menu" style={menuStyle(menu.x, menu.y, window.innerWidth, window.innerHeight)}>
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
        <button class="menu-item" role="menuitem" type="button" data-menu-action="priority">
          {icon('star')}
          <span>
            {anyNormal ? 'High priority' : 'Normal priority'}
            {suffix}
          </span>
        </button>
        <button
          class="menu-item"
          role="menuitem"
          type="button"
          data-menu-action="rename"
          disabled={only === undefined ? true : undefined}
        >
          {icon('pencil')}
          {/* "Edit topic", not "Rename" (NEWS-162). A rename reads as relabelling
              something, and this is not a label: the name is the question put to
              the model, so changing it changes what gets found. It also pairs
              with "Edit guidance" below, which is the other half of steering a
              topic. */}
          <span>Edit topic…</span>
        </button>
        <button
          class="menu-item"
          role="menuitem"
          type="button"
          data-menu-action="guidance"
          disabled={only === undefined ? true : undefined}
        >
          {icon('guidance')}
          <span>{only !== undefined && only.guidance !== '' ? 'Edit guidance' : 'Add guidance'}</span>
        </button>
        <div class="menu-sep" role="separator" />
        <button class="menu-item" role="menuitem" type="button" data-menu-action="solo">
          {icon('solo')}
          <span>{allSoloed ? 'Unsolo' : 'Solo'}{suffix}</span>
        </button>
        <button
          class="menu-item"
          role="menuitem"
          type="button"
          data-menu-action="review-flagged"
          disabled={flaggedCount === 0 ? true : undefined}
        >
          {icon('flag')}
          <span>Review Flagged News Items</span>
          {flaggedCount > 0 ? <span class="count-badge">{String(flaggedCount)}</span> : ''}
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
