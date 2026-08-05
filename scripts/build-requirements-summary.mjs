/**
 * Generate the status block of `docs/ai/requirements-summary.md` from the FR docs (NEWS-296).
 *
 * **Why.** Every substantive commit here touches four or five documentation
 * files, and most of that is worth it — the recorded decisions are why recent
 * tickets could be handed to an agent at all. One part was not: this summary
 * restated *status* that the numbered `docs/N-*.md` docs already carry on each
 * requirement. Shipping something meant editing the same fact twice, and
 * forgetting the second edit left the summary quietly lying to the next session,
 * which reads it as its starting context.
 *
 * **What is generated and what is not.** Only the status block, between the
 * `BEGIN GENERATED` / `END GENERATED` markers. Everything between
 * `BEGIN NOTES` / `END NOTES` is hand-written and copied through **byte for
 * byte** — that region is the *why*: decisions taken, traps found, caveats no
 * marker can carry ("real-API path untested", "macOS verified; other platforms
 * unbuilt"). Generating that would have destroyed the document's actual value
 * and left a directory listing behind. `docs/ai/code-summary.md` is hand-written
 * for the same reason and is not touched by this script at all.
 *
 * **The output stays committed.** It is read at the start of a session by
 * something that has not run a build (and on GitHub, by someone who never will),
 * so it has to exist in the tree. It is also literally its own input — the notes
 * region lives in the file — so there is no "generate from nothing" mode to
 * prefer. `tests/unit/requirements-summary.test.ts` keeps it from drifting.
 *
 * **The convention it reads was already there.** All 433 requirements are
 * declared as `- **FR-N.M** …`, and a status marker, where present, is
 * `*(Status)*` or `*(Status, detail)*` immediately after the id. Nothing had to
 * be invented; three drifting markers were normalized (NEWS-296) and that was
 * the whole migration.
 *
 * **A marker it cannot read is a hard error.** No "unknown" fallback: a summary
 * that mislabels a requirement is worse than the hand-maintained file it
 * replaces, because it is trusted. An *absent* marker is fine — it is optional,
 * 97 requirements have none — and those are reported as the gap they are.
 *
 * Usage:
 *   node scripts/build-requirements-summary.mjs            # write the file
 *   node scripts/build-requirements-summary.mjs --check     # exit 1 if stale
 *   node scripts/build-requirements-summary.mjs --docs D --out F   # (tests)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every status word a marker may use. Extend deliberately — see the header. */
export const STATUSES = [
  'Shipped',
  'Partial',
  'Design only',
  'Deferred',
  'Rejected',
  'Decided',
  'Removed',
];

export const BEGIN_GENERATED = '<!-- BEGIN GENERATED STATUS -->';
export const END_GENERATED = '<!-- END GENERATED STATUS -->';
export const BEGIN_NOTES = '<!-- BEGIN NOTES -->';
export const END_NOTES = '<!-- END NOTES -->';

/** A requirement declaration: `- **FR-3.2c** …`, or the same without the bullet. */
const FR_LINE = /^ {0,3}(?:[-*+] +)?\*\*(FR-\d+\.\d+[a-z]?)\*\*(.*)$/;

/** A well-formed marker, which must sit immediately after the id. */
const MARKER = /^ *\*\(([^)]*)\)\*/;

/**
 * An *attempted* marker: the text after the id opens a parenthetical.
 *
 * This is what turns a typo into a failure instead of a silent "no status".
 * `*(Shipped)` (unclosed) and `**(Shipped)**` (wrong emphasis) both land here.
 * No requirement in any doc begins its prose with a parenthesis, so the false
 * positive this risks costs a loud, fixable error rather than a wrong label.
 */
const MARKER_ATTEMPT = /^ *\** *\(/;

/** A marker holding only ticket ids — provenance, not a status. */
const TICKETS_ONLY = /^NEWS-\d+(?: *[,;/] *NEWS-\d+)*$/;

/**
 * Split a marker body into its status word and the rest.
 *
 * The status word may itself contain a space ("Design only"), so the longest
 * match wins rather than splitting on the first comma. What follows must be a
 * separator, or `Shippedish` would read as `Shipped`.
 */
function readStatus(body) {
  for (const status of [...STATUSES].sort((a, b) => b.length - a.length)) {
    if (body.toLowerCase().startsWith(status.toLowerCase())) {
      const rest = body.slice(status.length);
      if (rest === '' || /^[\s,;:—-]/.test(rest)) {
        return { status, detail: rest.replace(/^[\s,;:—-]+/, '').trim() };
      }
    }
  }
  return null;
}

class MarkerError extends Error {}

function markerError(where, id, line) {
  return new MarkerError(
    `${where} — unreadable status marker on ${id}:\n\n    ${line.trim()}\n\n` +
      `A marker is \`*(Status)*\` or \`*(Status, detail)*\` immediately after the requirement id, ` +
      `where Status is one of: ${STATUSES.join(', ')}. A marker holding only ticket ids ` +
      `(\`*(NEWS-142, NEWS-143)*\`) is read as provenance, so it counts as no status.\n\n` +
      `Fix the doc, or add the word to STATUSES in scripts/build-requirements-summary.mjs if it is ` +
      `a state worth having. There is deliberately no "unknown" fallback: a summary that mislabels ` +
      `a requirement is worse than one that admits it does not know.`,
  );
}

/**
 * Parse one requirements doc.
 *
 * @param text - the document's contents
 * @param where - `docs/3-ui.md`, for error messages
 * @returns its title and every requirement it declares, in document order
 */
export function parseRequirementsDoc(text, where) {
  const lines = text.split('\n');
  const heading = lines.find((l) => l.startsWith('# '));
  const title = heading === undefined ? '' : heading.slice(2).replace(/^\d+ +[—-] +/, '').trim();

  const requirements = [];
  lines.forEach((line, i) => {
    const declared = FR_LINE.exec(line);
    if (declared === null) return;
    const [, id, rest] = declared;
    const marked = MARKER.exec(rest);
    if (marked === null) {
      if (MARKER_ATTEMPT.test(rest)) throw markerError(`${where}:${i + 1}`, id, line);
      requirements.push({ id, line: i + 1, status: null, detail: '' });
      return;
    }
    const body = marked[1].trim();
    if (TICKETS_ONLY.test(body)) {
      requirements.push({ id, line: i + 1, status: null, detail: body });
      return;
    }
    const read = readStatus(body);
    if (read === null) throw markerError(`${where}:${i + 1}`, id, line);
    requirements.push({ id, line: i + 1, status: read.status, detail: read.detail });
  });

  return { title, requirements };
}

/**
 * Every `docs/N-topic.md`, in numeric order.
 *
 * Numbering gaps are real and meaningful — 19 was removed with the cost-visibility
 * feature (NEWS-119) — so this lists what exists rather than counting to the highest.
 */
export function collectDocs(docsDir) {
  return fs
    .readdirSync(docsDir)
    .filter((f) => /^\d+-.*\.md$/.test(f))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map((file) => {
      const number = Number.parseInt(file, 10);
      const parsed = parseRequirementsDoc(fs.readFileSync(path.join(docsDir, file), 'utf8'), `docs/${file}`);
      return { number, file, ...parsed };
    });
}

/**
 * A document's status, from its requirements'.
 *
 * Rules, in order — chosen so the rollup can never read better than the
 * requirements under it:
 *   1. nothing marked → `Not stated`
 *   2. any Partial → `Partial`
 *   3. Design only mixed with Shipped → `Partial` (some built, some only drawn)
 *   4. Design only and nothing shipped → `Design only`
 *   5. anything Shipped → `Shipped`
 *   6. otherwise → the closed decision that appears most (Deferred/Rejected/…)
 *
 * Deferred and Rejected deliberately do not lower a rollup: they are decisions
 * taken, not work outstanding, and a doc that shipped ten requirements and
 * deferred one has shipped.
 */
export function rollUp(requirements) {
  const marked = requirements.filter((r) => r.status !== null);
  if (marked.length === 0) return 'Not stated';
  const has = (s) => marked.some((r) => r.status === s);
  if (has('Partial')) return 'Partial';
  if (has('Design only')) return has('Shipped') ? 'Partial' : 'Design only';
  if (has('Shipped')) return 'Shipped';
  const counts = new Map();
  for (const r of marked) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * `FR-1.1, FR-1.2, … FR-1.9` → `FR-1.1–1.9`; lettered ids stand alone.
 *
 * Sorted first: documents declare requirements in the order they are *read*
 * (`FR-1.13` sits with the topic fields, well above `FR-1.6`), and collapsing
 * document order produced ranges that were correct and unreadable.
 */
export function collapseIds(ids) {
  const parts = (id) => {
    const m = /^FR-(\d+)\.(\d+)([a-z]?)$/.exec(id);
    return m === null ? null : { major: Number(m[1]), minor: Number(m[2]), suffix: m[3] };
  };
  const sorted = [...ids].sort((a, b) => {
    const [x, y] = [parts(a), parts(b)];
    if (x === null || y === null) return a.localeCompare(b);
    return x.major - y.major || x.minor - y.minor || x.suffix.localeCompare(y.suffix);
  });

  const out = [];
  let run = [];
  const flush = () => {
    if (run.length === 0) return;
    const last = run[run.length - 1];
    out.push(run.length > 1 ? `${run[0]}–${last.replace(/^FR-/, '')}` : run[0]);
    run = [];
  };
  /** Only plain `N.M` ids take part in a range — a lettered id is an insertion. */
  const minor = (id) => {
    const p = parts(id);
    return p === null || p.suffix !== '' ? null : p.minor;
  };
  for (const id of sorted) {
    const previous = run.length === 0 ? null : run[run.length - 1];
    const consecutive =
      previous !== null &&
      minor(previous) !== null &&
      minor(id) === minor(previous) + 1 &&
      parts(id)?.major === parts(previous)?.major;
    if (consecutive) run.push(id);
    else {
      flush();
      run = [id];
    }
  }
  flush();
  return out;
}

function link(doc) {
  return `[${doc.number} — ${doc.title}](../${doc.file})`;
}

/** Plural-safe "1 requirement" / "3 requirements". */
function count(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The generated block's body (without its markers). */
export function renderStatusBlock(docs) {
  const all = docs.flatMap((d) => d.requirements);
  const tally = new Map();
  for (const r of all) tally.set(r.status ?? 'no marker', (tally.get(r.status ?? 'no marker') ?? 0) + 1);
  const tallyLine = [...STATUSES, 'no marker']
    .filter((s) => tally.has(s))
    .map((s) => `${tally.get(s)} ${s}`)
    .join(' · ');

  // Numbers are never reused, so a gap is a document that was removed with its
  // feature (19, with cost visibility — NEWS-119). Saying so stops the table
  // reading as if a row were missing.
  const numbers = docs.map((d) => d.number);
  const absent = [];
  for (let n = Math.min(...numbers); n <= Math.max(...numbers); n++) {
    if (!numbers.includes(n)) absent.push(n);
  }
  const numbering =
    absent.length === 0
      ? `numbered 1–${Math.max(...numbers)}`
      : `numbered 1–${Math.max(...numbers)}, with ${absent.join(', ')} removed and never reused`;

  const lines = [
    '## Status',
    '',
    'Generated by `scripts/build-requirements-summary.mjs` from the `*(Shipped)*` / `*(Partial)*` / `*(Design only)*` / `*(Deferred)*` markers the numbered FR docs already carry. **Fix a status in its FR doc and run `npm run docs:requirements`** — an edit made here is overwritten, and believed until it is.',
    '',
    `${count(all.length, 'requirement')} across ${count(docs.length, 'document')} (${numbering}): ${tallyLine}.`,
    '',
    '| Doc | Status | Requirements |',
    '| --- | --- | --- |',
  ];

  for (const doc of docs) {
    const per = new Map();
    for (const r of doc.requirements) per.set(r.status ?? 'no marker', (per.get(r.status ?? 'no marker') ?? 0) + 1);
    const breakdown = [...STATUSES, 'no marker']
      .filter((s) => per.has(s))
      .map((s) => `${per.get(s)} ${s}`)
      .join(', ');
    // A doc can legitimately declare no FR-ids at all (a design note in the
    // numbered series), and `0 — ` with nothing after it reads as a bug.
    const summary = doc.requirements.length === 0 ? 'none declared' : `${doc.requirements.length} — ${breakdown}`;
    lines.push(`| ${link(doc)} | ${rollUp(doc.requirements)} | ${summary} |`);
  }

  const notShipped = docs.flatMap((doc) =>
    doc.requirements
      .filter((r) => r.status !== null && r.status !== 'Shipped')
      .map((r) => `- ${link(doc)} — **${r.id}** ${r.status}${r.detail === '' ? '' : `: ${r.detail}`}`),
  );
  lines.push('', '### Not shipped', '');
  lines.push(
    notShipped.length === 0
      ? 'Every requirement carrying a marker is marked Shipped.'
      : 'Every requirement whose marker says anything other than Shipped.',
    ...(notShipped.length === 0 ? [] : ['', ...notShipped]),
  );

  const unmarked = docs
    .map((doc) => ({ doc, ids: doc.requirements.filter((r) => r.status === null).map((r) => r.id) }))
    .filter((e) => e.ids.length > 0);
  const unmarkedTotal = unmarked.reduce((n, e) => n + e.ids.length, 0);
  lines.push('', '### No status marker', '');
  if (unmarkedTotal === 0) {
    lines.push('Every requirement states a status.');
  } else {
    lines.push(
      `${count(unmarkedTotal, 'requirement')} state no status. The marker is optional, so this is not an error — but it is the list of requirements whose state this file cannot report, and it is where a stale status hides instead.`,
      '',
      ...unmarked.map((e) => `- ${link(e.doc)} — ${collapseIds(e.ids).join(', ')} (${e.ids.length})`),
    );
  }

  return lines.join('\n');
}

/**
 * Ids declared more than once in the same document.
 *
 * A **hard failure** since NEWS-302, where it used to be a tabulated note. The
 * report was the right call when it was written — six ids were already colliding
 * and renumbering them is its own change, not something to do inside a
 * docs-automation ticket — but a permanent list of known-broken ids is a list
 * everyone learns to scroll past. Now that the six are fixed, the next collision
 * fails the gate at the moment someone creates it, which is the only time it is
 * cheap to fix.
 *
 * The failure names the id and the doc, because "duplicate id" without them
 * sends the reader to grep 29 files.
 */
function reusedIds(docs) {
  return docs
    .map((doc) => {
      const seen = new Set();
      const twice = new Set();
      for (const r of doc.requirements) {
        if (seen.has(r.id)) twice.add(r.id);
        seen.add(r.id);
      }
      return { doc, ids: [...twice] };
    })
    .filter((e) => e.ids.length > 0);
}

/** Throw if any document declares one id twice (NEWS-302). */
function assertNoReusedIds(docs) {
  const reused = reusedIds(docs);
  if (reused.length === 0) return;
  const where = reused.map((e) => `  ${e.doc.file} — ${e.ids.join(', ')}`).join('\n');
  throw new Error(
    `build-requirements-summary: an id is declared twice for two different requirements.\n\n${where}\n\n` +
      `An id is how everything else cites a requirement, so one that resolves to two things is worse ` +
      `than one that resolves to nothing. Give the later-added requirement the next free number in ` +
      `that document — check which are already taken, they are not always contiguous — and update ` +
      `every reference to it. NEWS-302 did this for six ids and left a pointer in each doc.`,
  );
}

/** Everything above the generated block — constant, so the generator owns it. */
const PREAMBLE = [
  '# Requirements Summary (AI summary)',
  '',
  'Two halves. **Status** is generated from the FR docs and must not be edited here (`npm run docs:requirements`). **Notes** are hand-written and are the point of the file: what was decided and why, which no status marker can carry. Source docs win on conflict.',
  '',
].join('\n');

function region(text, begin, end, what) {
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(
      `build-requirements-summary: could not find the ${what} region (${begin} … ${end}). ` +
        `The generator rewrites the file around those markers, so removing them would silently ` +
        `discard the hand-written notes. Put them back.`,
    );
  }
  return text.slice(from + begin.length, to);
}

/** The whole file: preamble + generated status + the existing notes, verbatim. */
export function renderSummary(existing, docs) {
  // Before anything is rendered: a colliding id makes every count and every
  // cross-reference in the block below ambiguous, so there is nothing worth
  // emitting until it is resolved (NEWS-302).
  assertNoReusedIds(docs);
  const notes =
    existing === null
      ? '\n\n<!-- Hand-written synthesis goes here. -->\n\n'
      : region(existing, BEGIN_NOTES, END_NOTES, 'notes');
  return [
    PREAMBLE,
    BEGIN_GENERATED,
    '',
    renderStatusBlock(docs),
    '',
    END_GENERATED,
    '',
    BEGIN_NOTES + notes + END_NOTES,
    '',
  ].join('\n');
}

function main(argv) {
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  const docsDir = path.resolve(root, flag('--docs', 'docs'));
  const out = path.resolve(root, flag('--out', 'docs/ai/requirements-summary.md'));
  const check = argv.includes('--check');

  let rendered;
  try {
    rendered = renderSummary(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null, collectDocs(docsDir));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  const inside = path.relative(root, out);
  const relative = inside.startsWith('..') ? out : inside;
  if (current === rendered) {
    console.log(`${relative} is up to date`);
    return 0;
  }
  if (check) {
    console.error(
      `${relative} is stale — its status block does not match the FR docs.\n\n` +
        `Run \`npm run docs:requirements\` and commit the result. The hand-written notes region is ` +
        `copied through untouched, so regenerating cannot lose anything.`,
    );
    return 1;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, rendered);
  console.log(`wrote ${relative}`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
