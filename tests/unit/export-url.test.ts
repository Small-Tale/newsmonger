import { describe, expect, it } from 'vitest';

import { exportHref } from '../../src/client/export-url.js';

describe('exportHref (NEWS-158, NEWS-160)', () => {
  it('covers every scope × format combination', () => {
    // The whole point of the dialog: three buttons offered three of these, and
    // "saved as JSON" had no way to be asked for at all.
    expect(exportHref({ scope: 'all', topicId: null, format: 'md' })).toBe('/api/export.md?scope=all');
    expect(exportHref({ scope: 'all', topicId: null, format: 'json' })).toBe('/api/export.json?scope=all');
    expect(exportHref({ scope: 'saved', topicId: null, format: 'md' })).toBe('/api/export.md?scope=saved');
    expect(exportHref({ scope: 'saved', topicId: null, format: 'json' })).toBe('/api/export.json?scope=saved');
    expect(exportHref({ scope: 'topic', topicId: 't1', format: 'md' })).toBe('/api/export.md?scope=topic&topic=t1');
    expect(exportHref({ scope: 'topic', topicId: 't1', format: 'json' })).toBe(
      '/api/export.json?scope=topic&topic=t1',
    );
  });

  it('refuses "one topic" with no topic, rather than exporting everything', () => {
    // Falling back to `scope=all` would hand over the whole archive when the
    // user asked for one subject — the quietest possible way to get this wrong.
    expect(exportHref({ scope: 'topic', topicId: null, format: 'md' })).toBeNull();
    expect(exportHref({ scope: 'topic', topicId: '', format: 'json' })).toBeNull();
  });

  it('ignores a stale topic id on a scope that does not use one', () => {
    // The store clears `topicId` when the scope moves away from `topic`, but the
    // URL must not depend on it having done so.
    expect(exportHref({ scope: 'all', topicId: 't1', format: 'md' })).toBe('/api/export.md?scope=all');
    expect(exportHref({ scope: 'saved', topicId: 't1', format: 'md' })).toBe('/api/export.md?scope=saved');
  });

  it('encodes a topic id that would otherwise break the query string', () => {
    // Ids are generated locally today, and nothing in the type promises that
    // stays true — an unencoded `&` would silently truncate the parameter.
    expect(exportHref({ scope: 'topic', topicId: 'a&b=c', format: 'md' })).toBe(
      '/api/export.md?scope=topic&topic=a%26b%3Dc',
    );
  });
});
