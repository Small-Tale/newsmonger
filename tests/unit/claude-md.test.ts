import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `CLAUDE.md`'s Hot Sheet markers have to pair up (NEWS-310).
 *
 * The file is part managed and part ours. Sections wrapped in
 * `hotsheet:begin section=…` are shared template text a sync rewrites; the
 * `specifics=…` blocks nested inside them are ours and survive. The boundary is
 * invisible while reading, and both failures it permits are silent:
 *
 * - **Project-specific guidance written into a managed section** is reverted by
 *   the next sync. NEWS-296 lost its "the status block is generated, don't
 *   hand-edit it" rule that way, and the restored template wording then told
 *   readers to do the opposite. Not mechanically checkable — a human has to
 *   notice — which is why the rule is now written in the file itself.
 * - **A marker that does not pair up.** This one *is* checkable, and it had
 *   already happened: `Ticket-Driven Work` appeared twice, the first copy
 *   carrying an `end` with no `begin`. Every session loaded the section twice,
 *   and the stray `end` sat directly beneath Conventions and Git — hand-written
 *   sections a parser resolving that orphan could have taken for template text.
 *
 * Nothing reads this file at runtime, so no other test would ever touch it. It
 * is read into every session's context instead, which makes a defect here quiet
 * and expensive rather than loud and cheap.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const md = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');

interface Marker {
  kind: 'begin' | 'end';
  scope: 'section' | 'specifics';
  name: string;
  line: number;
}

/**
 * Only real HTML-comment markers count.
 *
 * The file *discusses* these markers in prose ("anything between a
 * `hotsheet:begin section=` marker and its `hotsheet:end`…"), so a looser match
 * would parse the documentation of the rule as a violation of it.
 */
function markers(): Marker[] {
  const found: Marker[] = [];
  md.split('\n').forEach((text, i) => {
    const m = /<!--\s*hotsheet:(begin|end)\s+(section|specifics)=([\w-]+)/.exec(text);
    if (m === null) return;
    found.push({
      kind: m[1] as Marker['kind'],
      scope: m[2] as Marker['scope'],
      name: m[3],
      line: i + 1,
    });
  });
  return found;
}

describe('CLAUDE.md Hot Sheet markers (NEWS-310)', () => {
  const all = markers();

  it('finds the markers at all', () => {
    // A guard on the guard: a regex that stopped matching would make every
    // assertion below vacuously true.
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(all.some((m) => m.scope === 'specifics')).toBe(true);
  });

  it('opens and closes every block, correctly nested', () => {
    const stack: Marker[] = [];
    for (const m of all) {
      if (m.kind === 'begin') {
        stack.push(m);
        continue;
      }
      const open = stack.pop();
      expect(open, `line ${String(m.line)}: end ${m.scope}=${m.name} with no begin`).toBeDefined();
      expect(
        `${open?.scope ?? ''}=${open?.name ?? ''}`,
        `line ${String(m.line)}: closes the wrong block`,
      ).toBe(`${m.scope}=${m.name}`);
    }
    expect(stack.map((m) => `${m.scope}=${m.name} (line ${String(m.line)})`), 'never closed').toEqual([]);
  });

  it('declares each section once', () => {
    const names = all.filter((m) => m.kind === 'begin' && m.scope === 'section').map((m) => m.name);
    expect(names).toEqual([...new Set(names)]);
  });

  it('nests every specifics block inside its own section', () => {
    let section: string | null = null;
    for (const m of all) {
      if (m.scope === 'section') section = m.kind === 'begin' ? m.name : null;
      else if (m.kind === 'begin') {
        expect(section, `line ${String(m.line)}: specifics=${m.name} is not inside a section`).toBe(m.name);
      }
    }
  });

  it('has no duplicated top-level heading', () => {
    // The symptom the orphaned marker actually produced. Pairing markers is the
    // cause; this is what a reader would have seen, and it is worth asserting
    // separately because a duplicate could arrive by hand too.
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    expect(headings).toEqual([...new Set(headings)]);
  });
});
