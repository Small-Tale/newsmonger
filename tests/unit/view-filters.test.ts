import { describe, expect, it } from 'vitest';

import { effectiveCategoryFilter } from '../../src/client/view-filters.js';

describe('effectiveCategoryFilter', () => {
  const sports = { category: 'sports', subcategory: 'soccer' };

  it('uses the selected taxonomy when Solo is inactive', () => {
    expect(effectiveCategoryFilter(sports, [])).toEqual(sports);
  });

  it('ignores taxonomy for one or many soloed topics without mutating the selection', () => {
    expect(effectiveCategoryFilter(sports, ['a'])).toBeNull();
    expect(effectiveCategoryFilter(sports, ['a', 'b'])).toBeNull();
    expect(sports).toEqual({ category: 'sports', subcategory: 'soccer' });
  });

  it('restores the same selection after the Solo transition ends', () => {
    expect(effectiveCategoryFilter(sports, ['a'])).toBeNull();
    expect(effectiveCategoryFilter(sports, [])).toEqual(sports);
  });
});
