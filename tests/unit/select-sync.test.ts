import { describe, expect, it } from 'vitest';

import { selectValueToApply } from '../../src/client/select-sync.js';

/**
 * The rule behind NEWS-238's longest-running symptom.
 *
 * A `<select>` the user has touched stops following the `selected` **attribute**
 * a morph writes — that is the HTML dirtiness flag, and kerf bypasses it by also
 * setting the property whenever the attribute *changes*. The gap is when it
 * doesn't change: the render agrees with the DOM, nothing is written, and a
 * value the user moved stays moved for good.
 *
 * Captured from CI on a single element — the attribute on 1 hour, the control
 * showing 3:
 *
 *     "action": "hp-interval", "value": "10800000", "attrOn": "3600000"
 */
describe('selectValueToApply (NEWS-238)', () => {
  it('corrects a value that has drifted from the rendered choice', () => {
    // The captured failure, exactly.
    expect(selectValueToApply({ value: '10800000', attrValue: '3600000' })).toBe('3600000');
  });

  it('does nothing when they already agree', () => {
    // Which is almost always — this must be inert in the normal case, or it
    // would be writing to a control on every render for no reason.
    expect(selectValueToApply({ value: '3600000', attrValue: '3600000' })).toBeNull();
  });

  it('leaves a select alone when the render expressed no choice', () => {
    // No option carries the attribute. Writing a value here would invent a
    // choice the app never made — and would fight any control that legitimately
    // renders nothing selected.
    expect(selectValueToApply({ value: 'anything', attrValue: null })).toBeNull();
    expect(selectValueToApply({ value: '', attrValue: null })).toBeNull();
  });

  it('treats an empty rendered value as a real choice', () => {
    // `''` is a meaningful option in this app — "Provider default" on the
    // effort control. Confusing it with "no opinion" would make that the one
    // setting the fix cannot repair.
    expect(selectValueToApply({ value: 'high', attrValue: '' })).toBe('');
    expect(selectValueToApply({ value: '', attrValue: '' })).toBeNull();
  });
});
