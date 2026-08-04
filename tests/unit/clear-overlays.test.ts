import { beforeEach, describe, expect, it } from 'vitest';

import { appStore, FEED_PAGE } from '../../src/client/stores.js';
import type { NewsItem } from '../../src/db/schemas.js';

/**
 * The client-side half of "a clear leaves nothing behind" (NEWS-291/NEWS-273).
 *
 * `refreshState` cannot reach any of this. `recentlyFlaggedItems` holds full
 * copies of stories the *client* flagged this session so they stay visible as
 * collapsed one-liners after the server's normal-view page starts excluding them
 * (NEWS-61) — so emptying `feedItems` from the server leaves the overlay intact,
 * still rendering rows whose database rows have been deleted. A clear that
 * visibly leaves a story on screen is the reported bug one layer up.
 */
function item(id: string): NewsItem {
  return {
    id,
    topicId: 't1',
    title: `Story ${id}`,
    summary: 's',
    sources: [],
    image: null,
    dedupeKey: `k-${id}`,
    // Its own id — a thread of one, which is what an ungrouped story is (NEWS-280).
    threadId: id,
    foundAt: '2026-08-01T00:00:00.000Z',
    saved: false,
    offTopic: false,
  };
}

describe('clearStoryOverlays (NEWS-291)', () => {
  beforeEach(() => {
    appStore.actions.update({ recentlyFlaggedItems: [], reviewTopicIds: [], feedLimit: FEED_PAGE });
  });

  it('drops stories flagged this session, which the server refresh cannot', () => {
    appStore.actions.addRecentlyFlagged(item('i1'));
    appStore.actions.addRecentlyFlagged(item('i2'));
    expect(appStore.state.value.recentlyFlaggedItems).toHaveLength(2);

    appStore.actions.clearStoryOverlays();

    expect(appStore.state.value.recentlyFlaggedItems).toEqual([]);
  });

  it('leaves review mode, rather than stranding the user on an empty feed', () => {
    // Review mode shows *only* flagged stories. After a clear there are none, so
    // staying in it means an empty feed behind a banner explaining why it is
    // filtered — with nothing the filter could ever match.
    appStore.actions.setReviewTopicIds(['t1']);
    expect(appStore.state.value.reviewTopicIds).toEqual(['t1']);

    appStore.actions.clearStoryOverlays();

    expect(appStore.state.value.reviewTopicIds).toEqual([]);
  });

  it('resets the feed page, since the view it was paging through is gone', () => {
    appStore.actions.showMoreFeed();
    expect(appStore.state.value.feedLimit).toBeGreaterThan(FEED_PAGE);

    appStore.actions.clearStoryOverlays();

    expect(appStore.state.value.feedLimit).toBe(FEED_PAGE);
  });

  it('collapses an expanded card, which would otherwise name a deleted story', () => {
    // NEWS-281's expanded card and NEWS-282's thread state. Every other view
    // change in the store nulls `expandedItemId`, and a clear is the most drastic
    // view change there is — the story it names is gone.
    appStore.actions.toggleItemExpanded('i1');
    appStore.actions.showAllThread();
    expect(appStore.state.value.expandedItemId).toBe('i1');
    expect(appStore.state.value.threadShowAll).toBe(true);

    appStore.actions.clearStoryOverlays();

    expect(appStore.state.value.expandedItemId).toBeNull();
    expect(appStore.state.value.threadShowAll).toBe(false);
  });

  it('drops the cached thread panes, which size-based invalidation would never evict', () => {
    // `threadPanes` caches a fetched thread per story id (NEWS-282), and it is
    // invalidated by the thread's *size* changing. A clear does not change a size
    // — it removes the thread — so these entries would sit there forever,
    // describing stories the user deleted.
    appStore.actions.setThreadPane('i1', { status: 'ready', items: [], size: 2 });
    expect(appStore.state.value.threadPanes['i1']).toBeDefined();

    appStore.actions.clearStoryOverlays();

    expect(appStore.state.value.threadPanes).toEqual({});
  });

  it('is safe to call when there is nothing to drop', () => {
    // The ordinary case — a clear with no flagging done this session.
    appStore.actions.clearStoryOverlays();
    expect(appStore.state.value.recentlyFlaggedItems).toEqual([]);
    expect(appStore.state.value.reviewTopicIds).toEqual([]);
  });

  it('does not disturb the topics or settings it sits beside', () => {
    // The narrowing that defines the whole feature (FR-27.11): a clear touches
    // stories and nothing else. Easy to break here, since this action replaces
    // the whole state object.
    const before = appStore.state.value;
    appStore.actions.clearStoryOverlays();
    const after = appStore.state.value;
    expect(after.topics).toBe(before.topics);
    expect(after.settings).toBe(before.settings);
    expect(after.selectedTopicIds).toBe(before.selectedTopicIds);
  });
});
