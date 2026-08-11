/**
 * The feed: story cards, the flagged one-liner, and the thread timeline
 * (NEWS-297).
 *
 * The first seam out of `app.tsx`, which had grown to 5,065 lines holding every
 * view in the app — so every UI ticket touched one file and no two could be
 * worked concurrently. Extracted **by view rather than by kind**, so a ticket
 * about the feed lands here and nowhere else.
 *
 * **Rendering only.** Every gesture on a card is still handled by one
 * `delegate()` in `app.tsx`, matching the `data-*` attributes written here.
 * Splitting views must not become splitting handlers: two handlers matching one
 * click both run, and the first to re-render moves the DOM under the second
 * (NEWS-126).
 *
 * The always-present `.item-media` and `.item-pane` containers came across with
 * the comments explaining why they cannot be made conditional — `.item-pane` is
 * the target of the expander's `aria-controls`, and both keep kerf's morph from
 * reshaping a card. Those comments are the only record of the bugs they prevent,
 * so they travel with the code.
 */

import type { SafeHtml } from 'kerfjs';

import type { ThreadSummary } from '../api/schemas.js';
import type { NewsItem } from '../db/schemas.js';
import { outletFor, publishedLabel } from './attribution.js';
import { dayKeyOf, dayLabel, relativeTime } from './dates.js';
import { icon } from './icons.js';
import { menuStyle } from './menu-position.js';
import type { AppState, ThreadPane } from './stores.js';
import {
  showAllLabel,
  threadBadge,
  threadBadgeLabel,
  threadExpanderLabel,
  threadFetchNeeded,
  threadRowDate,
  visibleThreadRows,
} from './thread-view.js';

/** The "off topic" pill. As a button it prompts to unflag (hover reveals an ×
 *  and reddens); as a plain label (review mode) it just marks the card. */
function offTopicPill(itemId: string, interactive: boolean): SafeHtml {
  if (interactive) {
    return (
      <button class="off-topic-pill" type="button" data-unflag-prompt={itemId} title="Off topic — click to unflag">
        {icon('clear', 12)}
        {icon('flag', 12)}
        <span>off topic</span>
      </button>
    );
  }
  return (
    <span class="off-topic-pill label">
      {icon('flag', 12)}
      <span>off topic</span>
    </span>
  );
}

/** A flagged story in the normal feed: a dimmed one-liner the user can undo.
 *  Its `data-key` is deliberately distinct from the full card's (`flag-` prefix)
 *  so kerf morph *swaps* the two structures rather than trying to reshape one
 *  into the other in place — which it botches, given how different they are. */
function flaggedRowJsx(item: NewsItem, topicName: string): SafeHtml {
  return (
    <article class="item flagged-row" data-key={`flag-${item.id}`} data-item-id={item.id}>
      {/* Topic + badge on one line, the title below — a long topic name next to
          the title read as cramped and confusing (NEWS-71). */}
      <div class="flagged-head">
        <span class="item-topic">{topicName}</span>
        {offTopicPill(item.id, true)}
      </div>
      <span class="flagged-title">{item.title}</span>
    </article>
  );
}

/**
 * Everything the feed's leaves need to know about threads (NEWS-282), passed
 * down rather than read from the store in the leaf — the same reason
 * `expandedItemId` is: the tracked reads all happen in `appJsx`.
 */
export interface FeedThreads {
  /** Thread shape per story id, for the stories on this page. */
  summaries: Record<string, ThreadSummary | undefined>;
  /** Fetched timelines, per story id. Only the expanded card's is ever drawn. */
  panes: Record<string, ThreadPane | undefined>;
  /** Whether the open pane has had its row cap lifted. */
  showAll: boolean;
}

const NO_THREADS: FeedThreads = { summaries: {}, panes: {}, showAll: false };

/**
 * One row of the "story so far" (NEWS-282): when it landed, its headline, who
 * carried it.
 *
 * **The headline is a link to the story's own source**, and nothing else in the
 * row is interactive. That is the one destination this row can promise: a
 * control that scrolled the feed to that story's card would silently do nothing
 * for the common case, since a thread reaches back 30 days and the feed holds
 * one page — and a row that looks pressable and isn't is worse than a plain row.
 * A story with no usable source renders as plain text, so what looks like a link
 * always is one.
 *
 * The row for the story being read is **not** a link: it is marked as the one you
 * are on, which is what gives the timeline a "you are here" without a second
 * mechanism, and it is why the current story is in the list at all rather than
 * being filtered out of its own history.
 */
function threadRowJsx(entry: NewsItem, current: boolean): SafeHtml {
  const source = entry.sources.at(0) ?? null;
  const outlet = source === null ? '' : outletFor(source);
  return (
    <li
      class={`thread-row${current ? ' current' : ''}`}
      data-key={`thread-${entry.id}`}
      aria-current={current ? 'true' : 'false'}
    >
      <span class="thread-when">{threadRowDate(entry.foundAt)}</span>
      <span class="thread-what">
        {current || source === null ? (
          <span class="thread-title">{entry.title}</span>
        ) : (
          <a class="thread-title" href={source.url} target="_blank" rel="noopener noreferrer" data-external="1">
            {entry.title}
          </a>
        )}
        <span class="thread-meta">
          {outlet === '' ? '' : <span class="thread-outlet">{outlet}</span>}
          {current ? <span class="thread-here">this story</span> : ''}
        </span>
      </span>
    </li>
  );
}

/**
 * The expanded card's pane: how this story's subject developed (NEWS-282).
 *
 * Four states, and the first is the common one. **A thread of one is the ordinary
 * case** (FR-29.6) — most stories are the only thing we have on their subject,
 * especially before history accumulates — so it gets one honest line and *no
 * heading*: a "The story so far" with nothing under it reads as a bug rather
 * than as an answer. The heading only appears where there is a timeline to head.
 *
 * A failure shows in the pane with a retry, not in the page's error banner: one
 * card's background read failing is not worth a red bar across the app, and the
 * pane is where the person who asked is looking.
 */
function threadPaneJsx(item: NewsItem, threads: FeedThreads): SafeHtml {
  const summary = threads.summaries[item.id];
  if (!threadFetchNeeded(summary)) {
    return <p class="item-pane-note">Nothing else on this subject yet — later stories about it will collect here.</p>;
  }
  const pane = threads.panes[item.id];
  if (pane === undefined || pane.status === 'loading') {
    return <p class="item-pane-note">Looking up the story so far…</p>;
  }
  if (pane.status === 'error') {
    return (
      <p class="item-pane-note error">
        <span>Couldn't load the story so far: {pane.message}</span>
        <button class="btn link" type="button" data-retry-thread={item.id}>
          Try again
        </button>
      </p>
    );
  }
  const { rows, hidden } = visibleThreadRows(pane.items, threads.showAll);
  return (
    <div class="thread">
      <h4 class="thread-heading eyebrow">The story so far</h4>
      <ol class="thread-rows">
        {/* `.map()`, not `each()`: one pane is open at a time and its rows are
            fixed for as long as it is, so memoizing them buys nothing — and it
            keeps the number of `each()` calls in a render stable (kerf Hard
            Rule 14 / docs/3-ui.md). */}
        {rows.map((entry) => threadRowJsx(entry, entry.id === item.id))}
      </ol>
      {/* Always-present slot: the button appearing or leaving must not restructure
          the pane around it (docs/3-ui.md). */}
      <div class="thread-more">
        {hidden > 0 ? (
          <button class="btn link" type="button" data-action="show-all-thread">
            {showAllLabel(pane.items.length)}
          </button>
        ) : (
          ''
        )}
      </div>
    </div>
  );
}

/**
 * One story card.
 *
 * `expandedItemId` is threaded in rather than read from the store here: the leaf
 * stays a function of its arguments, and the tracked read happens in `appJsx`
 * where every other piece of state is read.
 *
 * **Only a normal, unflagged card expands** (NEWS-281). A flagged one-liner is
 * on its way out of the feed, and review mode is triage — "is this story about
 * my topic?", answered by the title — so neither gets the expander, and the
 * click handler keys off the button's *presence* rather than re-deriving the
 * variant from the DOM. See `docs/3-ui.md` FR-3.63.
 */
function itemJsx(
  item: NewsItem,
  topicName: string,
  variant: 'normal' | 'review' = 'normal',
  expandedItemId: string | null = null,
  threads: FeedThreads = NO_THREADS,
): SafeHtml {
  // A just-flagged story collapses to a dimmed one-liner in the normal feed.
  if (variant === 'normal' && item.offTopic) return flaggedRowJsx(item, topicName);
  const review = variant === 'review';
  const paneId = `item-pane-${item.id}`;
  const expanded = !review && expandedItemId === item.id;
  // Null for a thread of one, which is most stories — a badge on every card
  // would be noise and would say nothing (NEWS-283).
  const threadSummary = threads.summaries[item.id];
  const badge = threadBadge(threadSummary);
  return (
    <article
      class={`item${item.saved ? ' saved' : ''}${expanded ? ' expanded' : ''}`}
      data-key={item.id}
      data-item-id={item.id}
    >
      <header>
        <span class="item-topic">{topicName}</span>
        <span class="item-time">{relativeTime(item.foundAt)}</span>
        {review ? (
          offTopicPill(item.id, false)
        ) : (
          <span class="item-actions">
            <button
              class={`item-action bookmark${item.saved ? ' on' : ''}`}
              type="button"
              data-save-item={item.id}
              data-saved={item.saved ? 'true' : 'false'}
              aria-pressed={item.saved ? 'true' : 'false'}
              aria-label={item.saved ? 'Remove bookmark' : 'Save story'}
              title={item.saved ? 'Saved — click to remove' : 'Save story'}
            >
              {icon('bookmark', 15)}
            </button>
            <button
              class="item-action share"
              type="button"
              data-share-item={item.id}
              aria-label="Share story"
              title="Share story"
            >
              {icon('share', 15)}
            </button>
            {/* The expander (NEWS-281). A real focusable control, because the
                card body's click is a convenience gesture and an <article> with
                a click handler is reachable by neither keyboard nor screen
                reader. `aria-controls` mirrors the sidebar toggle → #topics-panel,
                which is exactly why the pane below is always in the DOM.

                On a story in a thread it grows a **label** — "4th update"
                (NEWS-283) — rather than gaining a badge beside it. One control,
                so the accessible name says what pressing it does *and* what it
                would reveal; a separate badge would either be inert chrome or a
                second control in a header that has no room for one
                (docs/3-ui.md FR-3.67, NEWS-71). The text comes from the feed
                page's thread summary, so no card fetches anything to draw it. */}
            <button
              class={`item-action expand${badge === null ? '' : ' threaded'}`}
              type="button"
              data-expand-item={item.id}
              aria-expanded={expanded ? 'true' : 'false'}
              aria-controls={paneId}
              aria-label={threadExpanderLabel(threadSummary, expanded)}
              title={badge === null ? (expanded ? 'Hide detail' : 'Show detail') : threadBadgeLabel(threadSummary)}
            >
              {/* The **count only** on the card — "4th update". The card header
                  is a flex row and the widest a feed column gets is ~430px in the
                  two-column layout, where "· since Jun 12" pushed the topic pill
                  from one line onto three: exactly the crowding NEWS-71 recorded.
                  The date is not lost — it is in this button's tooltip and
                  accessible name, and the pane it opens dates every row. */}
              {badge === null ? '' : <span class="thread-badge">{badge.count}</span>}
              {icon('chevron', 15)}
            </button>
          </span>
        )}
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
              {/* The outlet's own mark where we have it, the arrow glyph where
                  we don't (NEWS-169). Roughly a third of stories have no lead
                  image but almost every site has a favicon, so this is the
                  more reliable signal — and it says *who* rather than merely
                  "this is a link". Decorative beside a link that already names
                  the outlet, hence the empty alt. */}
              {source.favicon !== null ? (
                <img class="favicon" src={`/api/image/${source.favicon.hash}`} alt="" width="14" height="14" />
              ) : (
                // 14, matching the favicon box exactly — at 13 the fallback
                // rows started their text one pixel left of the rest, and a
                // feed mixes the two constantly.
                icon('arrow', 14)
              )}
              {/* Headline and attribution in one column beside the mark
                  (NEWS-279). The attribution used to be a sibling of the link
                  with `margin-left: 8px`, which put it under the *middle of the
                  favicon* — a hand-tuned number that could only ever be right
                  for one icon width, and was not right for that one. A column
                  aligns it with the headline structurally, so it stays aligned
                  if the mark is ever resized.

                  It is also *inside* the anchor now: the outlet names the same
                  destination the headline does, so having only half of it be a
                  link was an arbitrary split of one target. */}
              <span class="source-text">
                <span class="source-title">{source.title !== '' ? source.title : source.url}</span>
                <span class="source-meta">
                  <span class="source-outlet">{outletFor(source)}</span>
                  {source.publishedAt !== null ? (
                    <span class="source-date" title={`Published ${source.publishedAt}`}>
                      {publishedLabel(source.publishedAt, item.foundAt)}
                    </span>
                  ) : (
                    ''
                  )}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      {/* Always-present detail pane (NEWS-281), filled and emptied rather than
          rendered conditionally — the same rule as `.item-media` above, and for
          a second reason on top of it: this is the target of the expander's
          `aria-controls`, and an `aria-controls` pointing at nothing is an axe
          violation (docs/3-ui.md, NEWS-99). `:empty` hides it when collapsed.
          and it holds the thread timeline (NEWS-282). */}
      <div class="item-pane" id={paneId}>
        {expanded ? threadPaneJsx(item, threads) : ''}
      </div>
    </article>
  );
}

export function feedJsx(
  items: NewsItem[],
  topicNames: Map<string, string>,
  variant: 'normal' | 'review' = 'normal',
  expandedItemId: string | null = null,
  threads: FeedThreads = NO_THREADS,
): SafeHtml[] {
  // Group by local calendar day, newest first. Groups are dynamic, so plain
  // `.map()` (no memoization); items keep data-key for keyed morphing.
  const groups = new Map<string, NewsItem[]>();
  for (const item of items) {
    const key = dayKeyOf(new Date(item.foundAt));
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].map(([dateKey, dayItems]) => (
    <section class="day" data-key={`day-${dateKey}`}>
      <h2 class="eyebrow">{dayLabel(dateKey)}</h2>
      {dayItems.map((item) =>
        itemJsx(item, topicNames.get(item.topicId) ?? 'unknown topic', variant, expandedItemId, threads),
      )}
    </section>
  ));
}

/**
 * A story's context menu (NEWS-297).
 *
 * Here rather than in `topics-view.tsx` with the *topic* menu, though the two
 * are siblings in shape and were neighbours in `app.tsx`. This one's items are
 * the actions of a card — bookmark, share, flag — so it belongs to the view that
 * draws the card. Grouping the two menus together would have been grouping by
 * *kind*, which is the thing this split is not doing.
 */
/** Right-click menu for a story card: bookmark, share, and the off-topic flag. */
export function itemMenuJsx(menu: NonNullable<AppState['itemMenu']>, items: NewsItem[]): SafeHtml {
  const item = items.find((i) => i.id === menu.itemId);
  if (item === undefined) return <div id="item-menu-empty" />;
  // A flagged story only offers Unflag — bookmarking or sharing something you've
  // marked as noise makes no sense (NEWS-70).
  return (
    <div class="menu-backdrop" data-action="close-item-menu">
      <div class="menu" role="menu" style={menuStyle(menu.x, menu.y, window.innerWidth, window.innerHeight)}>
        {item.offTopic ? (
          ''
        ) : (
          <button class="menu-item" role="menuitem" type="button" data-item-menu-action="bookmark">
            {icon('bookmark')}
            <span>{item.saved ? 'Remove bookmark' : 'Bookmark'}</span>
          </button>
        )}
        {item.offTopic ? (
          ''
        ) : (
          <button class="menu-item" role="menuitem" type="button" data-item-menu-action="share">
            {icon('share')}
            <span>Share</span>
          </button>
        )}
        {item.offTopic ? '' : <div class="menu-sep" role="separator" />}
        <button class="menu-item" role="menuitem" type="button" data-item-menu-action="flag">
          {icon('flag')}
          <span>{item.offTopic ? 'Unflag off topic' : 'Flag: Off topic'}</span>
        </button>
      </div>
    </div>
  );
}
