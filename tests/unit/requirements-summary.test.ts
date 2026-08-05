import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * `docs/ai/requirements-summary.md`'s status block matches the FR docs (NEWS-296).
 *
 * **Why this is a test and not a habit.** The summary is what a fresh session
 * reads as its starting context, and it used to restate by hand the status each
 * FR doc already carried. A missed second edit did not break anything — it left
 * the file confidently wrong, which is worse, because the next agent believes it
 * and never opens the source doc. Generating the block removes the second edit;
 * this test removes the possibility of forgetting to regenerate.
 *
 * Sibling of `skill-references.test.ts` (every repo path a skill names exists)
 * and `documented-paths.test.ts`: prose drifting from the tree is invisible to a
 * suite that only exercises code.
 *
 * The parser cases drive the **real script** over fixture docs, the way
 * `rust-changed.test.ts` drives the real shell scripts — the generator is a CLI
 * the gate runs, so the CLI is what is worth asserting on. The case that matters
 * most is the malformed marker: a generator that quietly labels a typo "unknown"
 * is worse than the hand-maintained file it replaced.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/build-requirements-summary.mjs');
const summary = path.join(root, 'docs/ai/requirements-summary.md');

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Run {
  try {
    const stdout = execFileSync('node', [script, ...args], { cwd: root, encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

const sandboxes: string[] = [];

/** A throwaway `docs/` + output file. Fixture docs only — never the real ones. */
function sandbox(docs: Record<string, string>): { docsDir: string; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-reqsum-'));
  sandboxes.push(dir);
  const docsDir = path.join(dir, 'docs');
  fs.mkdirSync(docsDir);
  for (const [name, text] of Object.entries(docs)) fs.writeFileSync(path.join(docsDir, name), text);
  return { docsDir, out: path.join(dir, 'summary.md') };
}

function generate(docs: Record<string, string>): Run & { text: () => string; out: string } {
  const { docsDir, out } = sandbox(docs);
  const result = run(['--docs', docsDir, '--out', out]);
  return { ...result, out, text: () => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '') };
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the committed summary is not stale', () => {
  it('--check passes against the FR docs as they are', () => {
    const result = run(['--check']);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it('reads enough of the docs that a green result means something', () => {
    // Without this the whole file could pass by parsing nothing at all.
    const text = fs.readFileSync(summary, 'utf8');
    const rows = [...text.matchAll(/^\| \[\d+ — /gm)];
    expect(rows.length).toBeGreaterThanOrEqual(25);
    const total = /^(\d+) requirements across/m.exec(text);
    expect(total).not.toBeNull();
    expect(Number(total?.[1])).toBeGreaterThanOrEqual(400);
  });

  it('keeps the hand-written notes region, which the generator must never own', () => {
    const text = fs.readFileSync(summary, 'utf8');
    expect(text).toContain('<!-- BEGIN NOTES -->');
    expect(text).toContain('<!-- END NOTES -->');
    // A sample of synthesis that exists in no FR doc's status marker. If a future
    // change starts generating this region, this is what it would silently drop.
    expect(text).toContain('real-API path untested');
  });
});

describe('status markers', () => {
  it.each(['Shipped', 'Partial', 'Design only', 'Deferred', 'Rejected', 'Decided', 'Removed'])(
    'reads *(%s)*',
    (status) => {
      const result = generate({
        '1-thing.md': `# 1 — Thing\n\n- **FR-1.1** *(${status})* Does a thing.\n`,
      });
      expect(result.status).toBe(0);
      expect(result.text()).toContain(`| [1 — Thing](../1-thing.md) | ${status} | 1 — 1 ${status} |`);
    },
  );

  it("keeps a marker's detail text, which is where the caveats live", () => {
    const result = generate({
      '5-desktop.md': '# 5 — Desktop\n\n- **FR-5.5** *(Partial — config shipped, credentials outstanding)* Signing.\n',
    });
    expect(result.text()).toContain('**FR-5.5** Partial: config shipped, credentials outstanding');
  });

  it('accepts a bullet-less declaration, which docs/5 uses', () => {
    const result = generate({ '5-desktop.md': '# 5 — Desktop\n\n**FR-5.18** *(Decided, NEWS-205)* One endpoint.\n' });
    expect(result.status).toBe(0);
    expect(result.text()).toContain('**FR-5.18** Decided: NEWS-205');
  });

  it('does not mistake `Shippedish` for Shipped', () => {
    const result = generate({ '1-thing.md': '# 1 — Thing\n\n- **FR-1.1** *(Shippedish)* Does a thing.\n' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unreadable status marker on FR-1.1');
  });
});

describe('an unmarked requirement', () => {
  it('is reported as stating no status, not guessed at', () => {
    const result = generate({
      '1-thing.md': '# 1 — Thing\n\n- **FR-1.1** *(Shipped)* One.\n- **FR-1.2** Two.\n',
    });
    expect(result.status).toBe(0);
    const text = result.text();
    expect(text).toContain('| 2 — 1 Shipped, 1 no marker |');
    expect(text).toContain('- [1 — Thing](../1-thing.md) — FR-1.2 (1)');
  });

  it('reads a ticket-only marker as provenance, not as a broken status', () => {
    const result = generate({ '3-ui.md': '# 3 — Web UI\n\n- **FR-3.2c** *(NEWS-142, NEWS-143)* Names wrap.\n' });
    expect(result.status).toBe(0);
    expect(result.text()).toContain('| 1 — 1 no marker |');
  });

  it('leaves a doc whose requirements all lack markers as Not stated', () => {
    const result = generate({ '29-threads.md': '# 29 — Story Threads\n\n- **FR-29.1** Computed.\n' });
    expect(result.text()).toContain('| [29 — Story Threads](../29-threads.md) | Not stated | 1 — 1 no marker |');
  });

  it('collapses long unmarked runs into ranges, in id order not document order', () => {
    const declarations = [3, 1, 2, 12, 11].map((n) => `- **FR-1.${n}** Thing ${n}.`).join('\n');
    const result = generate({ '1-thing.md': `# 1 — Thing\n\n${declarations}\n` });
    expect(result.text()).toContain('FR-1.1–1.3, FR-1.11–1.12 (5)');
  });
});

describe('a doc with no requirements', () => {
  it('is listed rather than dropped, since a missing row reads as a bug', () => {
    const result = generate({
      '30-notes.md': '# 30 — A Note\n\nProse only. No requirement ids here at all.\n',
      '1-thing.md': '# 1 — Thing\n\n- **FR-1.1** *(Shipped)* One.\n',
    });
    expect(result.status).toBe(0);
    expect(result.text()).toContain('| [30 — A Note](../30-notes.md) | Not stated | none declared |');
  });
});

describe('a malformed marker fails loudly', () => {
  it.each([
    ['unclosed', '- **FR-1.1** *(Shipped* Does a thing.'],
    ['wrong emphasis', '- **FR-1.1** **(Shipped)** Does a thing.'],
    ['no emphasis', '- **FR-1.1** (Shipped) Does a thing.'],
    ['a typo', '- **FR-1.1** *(Shpped)* Does a thing.'],
  ])('%s', (_label, declaration) => {
    const result = generate({ '1-thing.md': `# 1 — Thing\n\n${declaration}\n` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/1-thing.md:3');
    expect(result.stderr).toContain('FR-1.1');
    // The whole point: no silent third state.
    expect(result.stderr.toLowerCase()).not.toContain('unknown status');
    expect(result.text()).toBe('');
  });

  it('names the vocabulary and where to change it', () => {
    const result = generate({ '1-thing.md': '# 1 — Thing\n\n- **FR-1.1** *(Done)* Does a thing.\n' });
    expect(result.stderr).toContain('Design only');
    expect(result.stderr).toContain('scripts/build-requirements-summary.mjs');
  });
});

describe('the rollup can never read better than its requirements', () => {
  it.each([
    ['Partial beats Shipped', ['Shipped', 'Partial'], 'Partial'],
    ['Design only mixed with Shipped is Partial', ['Shipped', 'Design only'], 'Partial'],
    ['Design only alone stays Design only', ['Design only', 'Design only'], 'Design only'],
    ['a Deferred requirement does not unship a doc', ['Shipped', 'Deferred'], 'Shipped'],
    ['a Rejected requirement does not unship a doc', ['Shipped', 'Rejected'], 'Shipped'],
    ['only closed decisions leave no Shipped claim', ['Deferred', 'Deferred'], 'Deferred'],
  ])('%s', (_label, statuses, expected) => {
    const declarations = statuses.map((s, i) => `- **FR-1.${i + 1}** *(${s})* Thing.`).join('\n');
    const result = generate({ '1-thing.md': `# 1 — Thing\n\n${declarations}\n` });
    expect(result.text()).toContain(`| [1 — Thing](../1-thing.md) | ${expected} |`);
  });
});

describe('ids used twice', () => {
  // Promoted from a tabulated note to a hard failure in NEWS-302.
  //
  // The report was right when it was written: six ids were already colliding,
  // and renumbering them means finding every citation across 29 docs, the AI
  // summaries and the test comments — its own change, not something to do inside
  // a docs-automation ticket. But a permanent list of known-broken ids is a list
  // everyone learns to scroll past. With the six fixed, the next collision fails
  // at the moment someone creates it, which is the only time it is cheap.
  it('fail the run instead of being tabulated', () => {
    const result = generate({
      '2-checks.md': '# 2 — Checks\n\n- **FR-2.6** A refusal fails the check.\n- **FR-2.6** *(Shipped)* Citations are verified.\n',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('declared twice');
  });

  it('name the id and the document, not just the fact', () => {
    // "duplicate id" on its own sends the reader to grep 29 files.
    const result = generate({
      '2-checks.md': '# 2 — Checks\n\n- **FR-2.6** One.\n- **FR-2.6** Two.\n',
      '3-ui.md': '# 3 — UI\n\n- **FR-3.1** *(Shipped)* Fine.\n',
    });
    expect(result.stderr).toContain('2-checks.md');
    expect(result.stderr).toContain('FR-2.6');
    expect(result.stderr).not.toContain('3-ui.md');
  });

  it('write nothing when they fail, rather than a half-true file', () => {
    // Every count and cross-reference in the block is ambiguous while an id
    // resolves to two requirements, so there is nothing worth emitting.
    const result = generate({
      '2-checks.md': '# 2 — Checks\n\n- **FR-2.6** One.\n- **FR-2.6** Two.\n',
    });
    expect(result.text()).toBe('');
  });
});

describe('the notes region', () => {
  const withNotes = (notes: string) =>
    `# Requirements Summary (AI summary)\n\n<!-- BEGIN GENERATED STATUS -->\nstale junk\n<!-- END GENERATED STATUS -->\n\n<!-- BEGIN NOTES -->\n${notes}\n<!-- END NOTES -->\n`;

  it('survives a regenerate byte for byte', () => {
    const { docsDir, out } = sandbox({ '1-thing.md': '# 1 — Thing\n\n- **FR-1.1** *(Shipped)* One.\n' });
    const notes = '\n## Why\n\nA decision no marker can carry: *the real-API path is untested*.\n';
    fs.writeFileSync(out, withNotes(notes));
    expect(run(['--docs', docsDir, '--out', out]).status).toBe(0);
    const text = fs.readFileSync(out, 'utf8');
    expect(text).toContain(notes);
    expect(text).not.toContain('stale junk');
  });

  it('is free to edit — a notes-only change is never stale', () => {
    const { docsDir, out } = sandbox({ '1-thing.md': '# 1 — Thing\n\n- **FR-1.1** *(Shipped)* One.\n' });
    run(['--docs', docsDir, '--out', out]);
    fs.writeFileSync(out, fs.readFileSync(out, 'utf8').replace('<!-- END NOTES -->', 'A new decision.\n\n<!-- END NOTES -->'));
    expect(run(['--check', '--docs', docsDir, '--out', out]).status).toBe(0);
  });

  it('goes stale when the generated block is edited by hand', () => {
    const { docsDir, out } = sandbox({ '1-thing.md': '# 1 — Thing\n\n- **FR-1.1** *(Shipped)* One.\n' });
    run(['--docs', docsDir, '--out', out]);
    fs.writeFileSync(out, fs.readFileSync(out, 'utf8').replace('1 Shipped', '1 Deferred'));
    const result = run(['--check', '--docs', docsDir, '--out', out]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm run docs:requirements');
  });

  it('goes stale when a doc changes and nobody regenerated', () => {
    const { docsDir, out } = sandbox({ '1-thing.md': '# 1 — Thing\n\n- **FR-1.1** *(Shipped)* One.\n' });
    run(['--docs', docsDir, '--out', out]);
    fs.writeFileSync(path.join(docsDir, '1-thing.md'), '# 1 — Thing\n\n- **FR-1.1** *(Deferred)* One.\n');
    expect(run(['--check', '--docs', docsDir, '--out', out]).status).toBe(1);
  });

  it('refuses to write at all when its markers have been removed', () => {
    const { docsDir, out } = sandbox({ '1-thing.md': '# 1 — Thing\n\n- **FR-1.1** *(Shipped)* One.\n' });
    fs.writeFileSync(out, '# Requirements Summary\n\nHand-written notes with no markers at all.\n');
    const result = run(['--docs', docsDir, '--out', out]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('notes region');
    // Refusing is the point: writing would have discarded the notes.
    expect(fs.readFileSync(out, 'utf8')).toContain('Hand-written notes with no markers');
  });
});
