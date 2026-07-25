import { beforeEach, describe, expect, it } from 'vitest';

import { appStore, FEED_PAGE } from '../../src/client/stores.js';

describe('feed pagination (NEWS-62)', () => {
  beforeEach(() => {
    appStore.actions.update({
      feedLimit: FEED_PAGE,
      soloTopicIds: [],
      savedFilter: false,
      searchQuery: '',
      reviewTopicIds: [],
    });
  });

  it('showMoreFeed grows the limit by one page each click', () => {
    appStore.actions.showMoreFeed();
    expect(appStore.state.value.feedLimit).toBe(2 * FEED_PAGE);
    appStore.actions.showMoreFeed();
    expect(appStore.state.value.feedLimit).toBe(3 * FEED_PAGE);
  });

  it('resets to one page whenever the view changes', () => {
    const expectReset = (change: () => void): void => {
      appStore.actions.showMoreFeed(); // grow past one page
      expect(appStore.state.value.feedLimit).toBeGreaterThan(FEED_PAGE);
      change();
      expect(appStore.state.value.feedLimit).toBe(FEED_PAGE);
    };
    expectReset(() => {
      appStore.actions.setSavedFilter(true);
    });
    expectReset(() => {
      appStore.actions.setSolo(['x']);
    });
    expectReset(() => {
      appStore.actions.setSearchQuery('q');
    });
    expectReset(() => {
      appStore.actions.setReviewTopicIds(['t']);
    });
  });
});
