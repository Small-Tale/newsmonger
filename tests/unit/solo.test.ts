import { describe, expect, it } from 'vitest';

import { isAllSoloed, toggleSolo } from '../../src/client/solo.js';

// Solo-set arithmetic (NEWS-29, NEWS-95). Two gestures reach this — the
// right-click menu and a double-click on a topic row — so the behaviour is
// pinned here rather than reasoned about twice.

describe('toggleSolo', () => {
  it('solos a topic when nothing is soloed', () => {
    expect(toggleSolo([], ['a'])).toEqual(['a']);
  });

  it('unsolos a topic that is already soloed', () => {
    expect(toggleSolo(['a'], ['a'])).toEqual([]);
  });

  it('is additive: soloing a second topic widens the filter', () => {
    expect(toggleSolo(['a'], ['b'])).toEqual(['a', 'b']);
  });

  it('unsolos only the target, leaving the rest of the filter alone', () => {
    expect(toggleSolo(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });

  it('unsolos a group only when every target is already soloed', () => {
    expect(toggleSolo(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('resolves a mixed group toward soloing all of it', () => {
    // 'a' is soloed, 'b' isn't. Toggling each independently would *unsolo* 'a'
    // and leave a set the user never asked for; the group resolves to "add".
    expect(toggleSolo(['a'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('is a no-op for an empty target list', () => {
    expect(toggleSolo(['a'], [])).toEqual(['a']);
  });

  it('ignores duplicates in the current set and in the targets', () => {
    expect(toggleSolo(['a', 'a'], ['b', 'b'])).toEqual(['a', 'b']);
  });

  it('preserves the existing order and appends new ids in the order given', () => {
    expect(toggleSolo(['c', 'a'], ['b', 'd'])).toEqual(['c', 'a', 'b', 'd']);
  });

  it('returns a new array rather than mutating the input', () => {
    const current = ['a'];
    const next = toggleSolo(current, ['b']);
    expect(current).toEqual(['a']);
    expect(next).not.toBe(current);
  });

  // Sequences, not just single operations: solo is a small state machine and
  // the interesting bugs live in the transitions between its states.
  it('round-trips through solo → widen → narrow → clear', () => {
    let solo = toggleSolo([], ['a']);
    expect(solo).toEqual(['a']);
    solo = toggleSolo(solo, ['b']);
    expect(solo).toEqual(['a', 'b']);
    solo = toggleSolo(solo, ['a']);
    expect(solo).toEqual(['b']);
    solo = toggleSolo(solo, ['b']);
    expect(solo).toEqual([]);
    // Empty again, so the next toggle must solo rather than unsolo.
    expect(toggleSolo(solo, ['a'])).toEqual(['a']);
  });

  it('double-toggling the same target returns to the starting set', () => {
    const start = ['a', 'b'];
    expect(toggleSolo(toggleSolo(start, ['c']), ['c'])).toEqual(start);
  });
});

describe('isAllSoloed', () => {
  it('is false when nothing is soloed', () => {
    expect(isAllSoloed([], ['a'])).toBe(false);
  });

  it('is false for an empty target list, so the menu never offers "Unsolo" for nothing', () => {
    expect(isAllSoloed(['a'], [])).toBe(false);
  });

  it('is true only when every target is soloed', () => {
    expect(isAllSoloed(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(isAllSoloed(['a'], ['a', 'b'])).toBe(false);
  });

  it('agrees with toggleSolo: the label names what the toggle will do', () => {
    const cases: [string[], string[]][] = [
      [[], ['a']],
      [['a'], ['a']],
      [['a'], ['a', 'b']],
      [['a', 'b'], ['a', 'b']],
    ];
    for (const [current, ids] of cases) {
      const removes = toggleSolo(current, ids).length < current.length;
      expect(isAllSoloed(current, ids)).toBe(removes);
    }
  });
});
