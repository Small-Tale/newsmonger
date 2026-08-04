import { beforeEach, describe, expect, it } from 'vitest';

import type { ItemsResp } from '../../src/api/schemas.js';
import { appStore } from '../../src/client/stores.js';

// The expandable story card's state (NEWS-281). The card is an *accordion*: one
// pane at a time, so most of what is worth testing is what happens on the
// second, third and out-of-order operation rather than on the first one.

type NewsItem = ItemsResp['items'][number];

function item(id: string): NewsItem {
  return {
    id,
    topicId: 't1',
    title: `Story ${id}`,
    summary: 'A summary.',
    saved: false,
    offTopic: false,
    sources: [],
    image: null,
    dedupeKey: `k-${id}`,
    // A thread of one — the default every story starts as (NEWS-280). Expansion
    // is indifferent to threading; this is here because the field is required.
    threadId: id,
    foundAt: new Date('2026-08-04T00:00:00.000Z').toISOString(),
  };
}

describe('story card expansion (NEWS-281)', () => {
  beforeEach(() => {
    appStore.actions.update({
      expandedItemId: null,
      recentlyFlaggedItems: [],
      soloTopicIds: [],
      savedFilter: false,
      searchQuery: '',
      reviewTopicIds: [],
      categoryFilter: null,
    });
  });

  it('toggles one story open and closed', () => {
    appStore.actions.toggleItemExpanded('a');
    expect(appStore.state.value.expandedItemId).toBe('a');
    appStore.actions.toggleItemExpanded('a');
    expect(appStore.state.value.expandedItemId).toBeNull();
  });

  it('opening a second story closes the first (accordion, not a set)', () => {
    appStore.actions.toggleItemExpanded('a');
    appStore.actions.toggleItemExpanded('b');
    expect(appStore.state.value.expandedItemId).toBe('b');
    // And the first one is genuinely closed, not merely second in a list.
    appStore.actions.toggleItemExpanded('b');
    expect(appStore.state.value.expandedItemId).toBeNull();
  });

  it('collapsing a story that is not the expanded one is a no-op', () => {
    appStore.actions.toggleItemExpanded('a');
    const before = appStore.state.value;
    appStore.actions.collapseItem('b');
    // Identity, not just value: an early return means no re-render at all.
    expect(appStore.state.value).toBe(before);
    expect(appStore.state.value.expandedItemId).toBe('a');
  });

  it('collapsing with nothing expanded is a no-op', () => {
    const before = appStore.state.value;
    appStore.actions.collapseItem('a');
    expect(appStore.state.value).toBe(before);
    appStore.actions.collapseExpandedItem();
    expect(appStore.state.value).toBe(before);
  });

  it('collapseItem closes the story it names', () => {
    appStore.actions.toggleItemExpanded('a');
    appStore.actions.collapseItem('a');
    expect(appStore.state.value.expandedItemId).toBeNull();
  });

  it('collapseExpandedItem closes whichever story is open', () => {
    appStore.actions.toggleItemExpanded('a');
    appStore.actions.toggleItemExpanded('b');
    appStore.actions.collapseExpandedItem();
    expect(appStore.state.value.expandedItemId).toBeNull();
  });

  // A flagged story renders as a dimmed one-liner with no pane and no expander,
  // so flagging the story you are reading has to close it — otherwise the pane
  // is open on a card that no longer has a control to close it with.
  it('flagging the expanded story collapses it', () => {
    appStore.actions.toggleItemExpanded('a');
    appStore.actions.addRecentlyFlagged(item('a'));
    expect(appStore.state.value.expandedItemId).toBeNull();
    expect(appStore.state.value.recentlyFlaggedItems.map((i) => i.id)).toEqual(['a']);
  });

  it('flagging a different story leaves the expanded one alone', () => {
    appStore.actions.toggleItemExpanded('a');
    appStore.actions.addRecentlyFlagged(item('b'));
    expect(appStore.state.value.expandedItemId).toBe('a');
  });

  it('flagging the same story twice still collapses it', () => {
    // The second call takes the already-flagged early return, which must not be
    // the path that forgets to close the pane.
    appStore.actions.addRecentlyFlagged(item('a'));
    appStore.actions.toggleItemExpanded('a');
    appStore.actions.addRecentlyFlagged(item('a'));
    expect(appStore.state.value.expandedItemId).toBeNull();
    expect(appStore.state.value.recentlyFlaggedItems).toHaveLength(1);
  });

  // Every action that replaces the list collapses the pane: it belongs to the
  // story being read, and one left open behind a filter change is state with
  // nothing on screen to close it. Same rule as the feed-page reset (NEWS-62).
  it('any change of view collapses the expanded story', () => {
    const expectCollapse = (change: () => void): void => {
      appStore.actions.toggleItemExpanded('a');
      expect(appStore.state.value.expandedItemId).toBe('a');
      change();
      expect(appStore.state.value.expandedItemId).toBeNull();
    };
    expectCollapse(() => {
      appStore.actions.setSolo(['t1']);
    });
    expectCollapse(() => {
      appStore.actions.setSavedFilter(true);
    });
    expectCollapse(() => {
      appStore.actions.setSearchQuery('q');
    });
    expectCollapse(() => {
      appStore.actions.setCategoryFilter({ category: 'tech', subcategory: null });
    });
    expectCollapse(() => {
      appStore.actions.setReviewTopicIds(['t1']);
    });
  });

  it('survives an interleaved sequence of opens, collapses and view changes', () => {
    appStore.actions.toggleItemExpanded('a');
    appStore.actions.collapseItem('b'); // wrong id — leaves 'a' open
    appStore.actions.toggleItemExpanded('b'); // hand-off
    appStore.actions.collapseItem('a'); // stale collapse of the one already closed
    expect(appStore.state.value.expandedItemId).toBe('b');
    appStore.actions.setSearchQuery('x'); // view change closes it
    appStore.actions.toggleItemExpanded('b'); // reopening the same story works
    expect(appStore.state.value.expandedItemId).toBe('b');
    appStore.actions.collapseExpandedItem();
    appStore.actions.collapseExpandedItem(); // repeat is inert
    expect(appStore.state.value.expandedItemId).toBeNull();
  });
});
