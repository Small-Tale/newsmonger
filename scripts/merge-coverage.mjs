/**
 * Merge unit + E2E (server & browser) coverage into one report.
 *
 * Inputs (produced by scripts/test-all.sh):
 *   coverage/unit/lcov.info      — vitest v8 coverage
 *   .coverage-tmp/server/        — NODE_V8_COVERAGE output from the E2E web server
 *   .coverage-tmp/browser/       — V8 coverage from Playwright (tests/e2e/fixtures.ts)
 *
 * Outputs:
 *   coverage/e2e-server/lcov.info, coverage/e2e-browser/lcov.info (c8 conversions)
 *   coverage/merged/lcov.info    — all records, paths normalized to repo-relative src/**
 *   stdout                       — per-file line-coverage summary
 *
 * ## The unit run decides what counts as a line (NEWS-357)
 *
 * The two inputs do not agree on how many lines a file *has*, and the
 * disagreement is not small: **c8's `LF` is the file's total line count**,
 * measured across all 53 files it reported — every comment, blank and type
 * declaration counted as an executable line it then records as unexecuted.
 * vitest's v8 provider remaps through source maps and reports only real
 * statements: 62 lines for a 241-line `suggest-prompt.ts`.
 *
 * Unioning line *numbers* therefore took the denominator from whichever source
 * was more permissive, which is always c8. A file with 26 tests and full unit
 * coverage came out at 61%, and fourteen files read =10pp worse than they were
 * — while the headline total read *better* than the truth, because most of
 * those phantom lines do get touched on import. Wrong in both directions at
 * once, and it sent someone (me) to write tests for a file that had 100%.
 *
 * So the unit report is the **basis**: it defines which line numbers exist per
 * file, and the E2E runs may only mark those lines as hit. A line c8 reports
 * that vitest does not is a comment or a blank, and is dropped.
 *
 * A file the basis has never heard of keeps its own lines rather than vanishing
 * — silently dropping coverage would be a worse failure than an odd
 * denominator — and the summary names how many did that, because more than
 * zero means the basis is no longer complete and this comment needs revisiting.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import MCR from 'monocart-coverage-reports';

import { npxSpawn } from './npm-command.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

function c8Report(tempDir, reportDir) {
  if (!fs.existsSync(tempDir) || fs.readdirSync(tempDir).length === 0) {
    console.warn(`merge-coverage: no V8 coverage in ${tempDir} — skipping`);
    return null;
  }
  // `npxSpawn`, not a bare 'npx' (NEWS-356) — this runs in every `test:all`.
  const npx = npxSpawn();
  execFileSync(
    npx.command,
    [
      'c8',
      'report',
      '--temp-directory', tempDir,
      '--report-dir', reportDir,
      '--reporter', 'lcovonly',
      '--exclude-after-remap',
      '--include', 'src/**',
      '--all=false',
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], shell: npx.shell },
  );
  const lcov = path.join(reportDir, 'lcov.info');
  return fs.existsSync(lcov) ? lcov : null;
}

/**
 * Convert the browser's V8 dumps, which c8 cannot read usefully (NEWS-359).
 *
 * The client ships as one source-mapped `--format=iife` bundle, and c8 answers
 * that shape by marking **every line of every source as covered** — 41 files,
 * 11,513 lines, zero unhit, from a single page load. Measured, and not fixable
 * from our side: trimming the enclosing whole-bundle ranges changed nothing,
 * because c8 is not doing range-based remapping here at all, it is attributing
 * whole files. NEWS-357 had to exclude the whole source to stop it reporting
 * every client file as 100%.
 *
 * `monocart-coverage-reports` handles exactly this case — Playwright's V8 output
 * against a source-mapped bundle — and produces real per-file numbers from the
 * same dumps: 89.5% overall, with `tauri.ts` at 57% (desktop-only paths) and
 * `attribution.ts` at 24%. The data was always good; only the converter was
 * losing it.
 *
 * **The bundle source is attached here rather than in the dump.** `fixtures.ts`
 * writes `source: undefined` deliberately — there are 234 dumps per run and the
 * bundle is ~950 KB, so carrying it in each would be a gigabyte of duplicated
 * text. One read at merge time gives the converter what it needs for nothing.
 */
async function browserReport(tempDir, reportDir) {
  if (!fs.existsSync(tempDir) || fs.readdirSync(tempDir).length === 0) {
    console.warn(`merge-coverage: no V8 coverage in ${tempDir} — skipping`);
    return null;
  }
  const bundle = 'dist/client/app.global.js';
  if (!fs.existsSync(bundle)) {
    console.warn(`merge-coverage: ${bundle} is missing — cannot map browser coverage back to source`);
    return null;
  }
  const source = fs.readFileSync(bundle, 'utf8');
  const mcr = MCR({
    name: 'e2e-browser',
    outputDir: reportDir,
    reports: [['lcovonly']],
    logging: 'error',
    // Our own source only. The bundle also carries kerfjs and signals-core,
    // which are dependencies rather than code this project is answerable for.
    sourceFilter: (p) => /(^|\/)src\//.test(p) && !p.includes('node_modules'),
  });
  await mcr.cleanCache();
  for (const name of fs.readdirSync(tempDir)) {
    if (!name.endsWith('.json')) continue;
    const dump = JSON.parse(fs.readFileSync(path.join(tempDir, name), 'utf8'));
    await mcr.add(dump.result.map((entry) => ({ ...entry, source })));
  }
  await mcr.generate();
  const lcov = path.join(reportDir, 'lcov.info');
  return fs.existsSync(lcov) ? lcov : null;
}

/** Parse an lcov file into records; keep only src/** files, repo-relative. */
function parseLcov(file) {
  const records = [];
  let current = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('SF:')) {
      let sf = line.slice(3).trim();
      if (path.isAbsolute(sf)) sf = path.relative(root, sf);
      sf = sf.replaceAll('\\', '/');
      current = { sf, lines: [] };
    } else if (current && line.startsWith('DA:')) {
      const [lineNo, hits] = line.slice(3).split(',');
      current.lines.push([Number(lineNo), Number(hits)]);
    } else if (current && line.startsWith('end_of_record')) {
      if (current.sf.startsWith('src/')) records.push(current);
      current = null;
    }
  }
  return records;
}

/**
 * Does this source distinguish covered lines from uncovered ones? (NEWS-357)
 *
 * A coverage source that reports **every line as hit** is not measuring
 * coverage; it is reporting that a file was loaded. Merging it marks every line
 * of every file it touches as covered, so a file's number stops depending on
 * its tests — which is worse than the source being missing, because it looks
 * like good news.
 *
 * That is not hypothetical either: `e2e-browser` reported 11,510 lines across
 * 41 files with **zero** unhit lines. Playwright's JS coverage over the bundle
 * remaps back to `src/**`, and what survives the remap is closer to "this was
 * loaded" than to "this ran".
 *
 * A real suite always misses something — an error branch, a guard, a fallback.
 * So zero misses over a meaningful sample is a broken source, and the check is
 * a floor on sample size rather than a percentage: a source reporting three
 * fully-covered lines is unremarkable, one reporting eleven thousand is not.
 */
export function looksUnmeasured(records, minLines = 200) {
  let total = 0;
  let unhit = 0;
  for (const rec of records) {
    for (const [, hits] of rec.lines) {
      total++;
      if (hits === 0) unhit++;
    }
  }
  return total >= minLines && unhit === 0;
}

/**
 * Combine per-source records into one `sf -> Map(lineNo, hits)`.
 *
 * `basisName` names the source whose line numbers define each file's shape; see
 * the note at the top of this file. Exported and pure so it can be tested
 * without producing real coverage — the bug this exists to prevent is
 * arithmetic, and arithmetic is exactly what a script nobody tests gets wrong.
 *
 * Returns the merged map plus `orphans`, the files no basis record covered.
 */
export function mergeSources(sources, basisName = 'unit') {
  const basis = new Map();
  for (const { name, records } of sources) {
    if (name !== basisName) continue;
    for (const rec of records) basis.set(rec.sf, new Set(rec.lines.map(([n]) => n)));
  }

  const byFile = new Map();
  const orphans = new Set();
  for (const { records } of sources) {
    for (const rec of records) {
      const allowed = basis.get(rec.sf) ?? null;
      if (allowed === null) orphans.add(rec.sf);
      let lines = byFile.get(rec.sf);
      if (!lines) byFile.set(rec.sf, (lines = new Map()));
      for (const [lineNo, hits] of rec.lines) {
        // Outside the basis: a comment or a blank line that only c8 believes is
        // code. Dropped rather than counted as an unexecuted statement.
        if (allowed !== null && !allowed.has(lineNo)) continue;
        lines.set(lineNo, (lines.get(lineNo) ?? 0) + hits);
      }
    }
  }
  return { byFile, orphans };
}

/** Line coverage of one `Map(lineNo, hits)`. */
export function coverageOf(lines) {
  const lf = lines.size;
  const lh = [...lines.values()].filter((h) => h > 0).length;
  return { lf, lh, pct: lf === 0 ? 100 : (lh / lf) * 100 };
}

const sources = [
  { name: 'unit', lcov: 'coverage/unit/lcov.info' },
  { name: 'e2e-server', lcov: c8Report('.coverage-tmp/server', 'coverage/e2e-server') },
  { name: 'e2e-browser', lcov: await browserReport('.coverage-tmp/browser', 'coverage/e2e-browser') },
];

const loaded = [];
for (const { name, lcov } of sources) {
  if (lcov === null || !fs.existsSync(lcov)) {
    console.warn(`merge-coverage: missing ${name} lcov — skipping`);
    continue;
  }
  const records = parseLcov(lcov);
  // Each source's own number, printed beside the others. Two honest numbers
  // that disagree are information; one number that hides the disagreement is
  // what NEWS-357 was.
  let lf = 0;
  let lh = 0;
  for (const rec of records) {
    lf += rec.lines.length;
    lh += rec.lines.filter(([, h]) => h > 0).length;
  }
  const pct = lf === 0 ? 0 : (lh / lf) * 100;
  console.log(`merge-coverage: ${name}: ${records.length} src/ file records, ${lh}/${lf} lines (${pct.toFixed(1)}%)`);
  loaded.push({ name, records });
}

// Refuse a source that cannot tell a covered line from an uncovered one, and
// say so where somebody will read it (NEWS-357).
const usable = loaded.filter(({ name, records }) => {
  if (!looksUnmeasured(records)) return true;
  console.warn(
    `merge-coverage: EXCLUDING ${name} — it reports every one of its lines as hit, which measures "was loaded", not "was covered". Its lcov is still written for inspection.`,
  );
  return false;
});

const { byFile, orphans } = mergeSources(usable, 'unit');
if (orphans.size > 0) {
  console.warn(
    `merge-coverage: ${orphans.size} file(s) had no unit-coverage record and kept their own line basis: ${[...orphans].join(', ')}`,
  );
}

// Write the merged lcov (one unioned record per file).
fs.mkdirSync('coverage/merged', { recursive: true });
const out = [];
for (const [sf, lines] of [...byFile.entries()].sort()) {
  out.push('TN:', `SF:${sf}`);
  let hit = 0;
  for (const [lineNo, hits] of [...lines.entries()].sort((a, b) => a[0] - b[0])) {
    out.push(`DA:${lineNo},${hits}`);
    if (hits > 0) hit++;
  }
  out.push(`LF:${lines.size}`, `LH:${hit}`, 'end_of_record');
}
fs.writeFileSync('coverage/merged/lcov.info', out.join('\n') + '\n');

// Summary table.
let totalLines = 0;
let totalHit = 0;
const excluded = loaded.filter((l) => !usable.includes(l)).map((l) => l.name);
console.log(`\nMerged line coverage (${usable.map((l) => l.name).join(' + ')}):\n`);
const rows = [...byFile.entries()]
  .map(([sf, lines]) => {
    const { lf, lh, pct } = coverageOf(lines);
    totalLines += lf;
    totalHit += lh;
    return { sf, lf, lh, pct };
  })
  .sort((a, b) => a.pct - b.pct);
for (const { sf, lf, lh, pct } of rows) {
  console.log(`  ${pct.toFixed(1).padStart(6)}%  ${String(lh).padStart(4)}/${String(lf).padEnd(4)}  ${sf}`);
}
console.log(`\n  TOTAL ${((totalHit / Math.max(totalLines, 1)) * 100).toFixed(1)}%  (${totalHit}/${totalLines} lines)`);
console.log('  merged lcov: coverage/merged/lcov.info');
if (excluded.length > 0) {
  // Without this, `src/client/**` reading 0% looks like "the client is
  // untested" — when it is heavily exercised by E2E and merely unmeasured.
  // Saying which is which is the whole point of the NEWS-357 fix.
  console.log(
    `\n  NOTE: ${excluded.join(', ')} excluded as unmeasured, so any file covered only from there reads 0%.` +
      `\n  Those files are still exercised by the suite — this is a measurement gap, not a testing one.`,
  );
}
