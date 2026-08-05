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
function item(id: string, topicId = 't1'): NewsItem {
  return {
    id,
    topicId,
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

/**
 * The same rule narrowed to one topic (NEWS-303).
 *
 * The per-topic clear — rename-with-clear — had no cleanup at all, so the bug
 * NEWS-273 fixed app-wide survived here at one topic's scale.
 *
 * These tests are mostly about what the action must **not** touch. Reusing
 * `clearStoryOverlays()` would have passed every "the flagged row is gone"
 * assertion while throwing away state the clear did not invalidate — another
 * topic's flagged story, a review of a topic that still has flagged stories, an
 * expanded card belonging somewhere else. Wiping state an action did not
 * invalidate is the same class of untruth as leaving state it did, so the
 * negative assertions are the point rather than the padding.
 */
describe('clearStoryOverlaysForTopic (NEWS-303)', () => {
  beforeEach(() => {
    appStore.actions.update({
      recentlyFlaggedItems: [],
      reviewTopicIds: [],
      feedLimit: FEED_PAGE,
      feedItems: [],
      expandedItemId: null,
      threadShowAll: false,
      threadPanes: {},
    });
  });

  it('drops the cleared topic’s flagged rows and keeps every other topic’s', () => {
    appStore.actions.addRecentlyFlagged(item('i1', 't1'));
    appStore.actions.addRecentlyFlagged(item('i2', 't2'));

    appStore.actions.clearStoryOverlaysForTopic('t1');

    expect(appStore.state.value.recentlyFlaggedItems.map((i) => i.id)).toEqual(['i2']);
  });

  it('leaves review mode only when the cleared topic was the last one under review', () => {
    appStore.actions.setReviewTopicIds(['t1', 't2']);
    appStore.actions.clearStoryOverlaysForTopic('t1');
    expect(appStore.state.value.reviewTopicIds).toEqual(['t2']);

    appStore.actions.clearStoryOverlaysForTopic('t2');
    expect(appStore.state.value.reviewTopicIds).toEqual([]);
  });

  it('collapses an expanded card only when the card belonged to the cleared topic', () => {
    // Membership is read from `feedItems` and the overlay, which both carry
    // `topicId`. An expanded card the client cannot place is left alone — the
    // action's job is to stop describing stories it knows are gone, not to guess.
    appStore.actions.update({ feedItems: [item('i1', 't1'), item('i2', 't2')] });

    appStore.actions.toggleItemExpanded('i2');
    appStore.actions.showAllThread();
    appStore.actions.clearStoryOverlaysForTopic('t1');
    expect(appStore.state.value.expandedItemId, 'other topic’s card stays open').toBe('i2');
    expect(appStore.state.value.threadShowAll).toBe(true);

    appStore.actions.clearStoryOverlaysForTopic('t2');
    expect(appStore.state.value.expandedItemId).toBeNull();
    expect(appStore.state.value.threadShowAll).toBe(false);
  });

  it('evicts thread panes for the cleared topic’s stories only', () => {
    appStore.actions.update({ feedItems: [item('i1', 't1'), item('i2', 't2')] });
    appStore.actions.setThreadPane('i1', { status: 'ready', items: [], size: 2 });
    appStore.actions.setThreadPane('i2', { status: 'ready', items: [], size: 2 });

    appStore.actions.clearStoryOverlaysForTopic('t1');

    expect(Object.keys(appStore.state.value.threadPanes)).toEqual(['i2']);
  });

  it('keeps the feed page the user paged to', () => {
    // Unlike the app-wide clear. "Show more" spans every topic, so one topic's
    // clear is no reason to collapse a view the user opened across all of them.
    appStore.actions.showMoreFeed();
    const paged = appStore.state.value.feedLimit;
    expect(paged).toBeGreaterThan(FEED_PAGE);

    appStore.actions.clearStoryOverlaysForTopic('t1');

    expect(appStore.state.value.feedLimit).toBe(paged);
  });

  it('is safe on a topic with nothing on screen, and repeatable', () => {
    appStore.actions.addRecentlyFlagged(item('i1', 't1'));

    appStore.actions.clearStoryOverlaysForTopic('t9');
    expect(appStore.state.value.recentlyFlaggedItems).toHaveLength(1);

    appStore.actions.clearStoryOverlaysForTopic('t1');
    appStore.actions.clearStoryOverlaysForTopic('t1');
    expect(appStore.state.value.recentlyFlaggedItems).toEqual([]);
  });

  it('survives flag → clear → flag again on the same topic', () => {
    // The sequence a wholesale-wipe implementation gets right and a stale-set
    // one does not: the second flag must land in an overlay the first clear
    // emptied, not be swallowed by a remembered id.
    appStore.actions.addRecentlyFlagged(item('i1', 't1'));
    appStore.actions.clearStoryOverlaysForTopic('t1');
    appStore.actions.addRecentlyFlagged(item('i3', 't1'));

    expect(appStore.state.value.recentlyFlaggedItems.map((i) => i.id)).toEqual(['i3']);
  });

  it('does not disturb the topics or settings it sits beside', () => {
    const before = appStore.state.value;
    appStore.actions.clearStoryOverlaysForTopic('t1');
    const after = appStore.state.value;
    expect(after.topics).toBe(before.topics);
    expect(after.settings).toBe(before.settings);
    expect(after.selectedTopicIds).toBe(before.selectedTopicIds);
  });
});
