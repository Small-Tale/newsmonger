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
 *   stdout                       — per-file line-coverage summary of the union
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

function c8Report(tempDir, reportDir) {
  if (!fs.existsSync(tempDir) || fs.readdirSync(tempDir).length === 0) {
    console.warn(`merge-coverage: no V8 coverage in ${tempDir} — skipping`);
    return null;
  }
  execFileSync(
    'npx',
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
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
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

const sources = [
  { name: 'unit', lcov: 'coverage/unit/lcov.info' },
  { name: 'e2e-server', lcov: c8Report('.coverage-tmp/server', 'coverage/e2e-server') },
  { name: 'e2e-browser', lcov: c8Report('.coverage-tmp/browser', 'coverage/e2e-browser') },
];

const allRecords = [];
for (const { name, lcov } of sources) {
  if (lcov === null || !fs.existsSync(lcov)) {
    console.warn(`merge-coverage: missing ${name} lcov — skipping`);
    continue;
  }
  const records = parseLcov(lcov);
  console.log(`merge-coverage: ${name}: ${records.length} src/ file records`);
  allRecords.push(...records);
}

// Union line hits per file.
const byFile = new Map();
for (const rec of allRecords) {
  let lines = byFile.get(rec.sf);
  if (!lines) byFile.set(rec.sf, (lines = new Map()));
  for (const [lineNo, hits] of rec.lines) {
    lines.set(lineNo, (lines.get(lineNo) ?? 0) + hits);
  }
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
console.log('\nMerged line coverage (unit + E2E server + E2E browser):\n');
const rows = [...byFile.entries()]
  .map(([sf, lines]) => {
    const lf = lines.size;
    const lh = [...lines.values()].filter((h) => h > 0).length;
    totalLines += lf;
    totalHit += lh;
    return { sf, lf, lh, pct: lf === 0 ? 100 : (lh / lf) * 100 };
  })
  .sort((a, b) => a.pct - b.pct);
for (const { sf, lf, lh, pct } of rows) {
  console.log(`  ${pct.toFixed(1).padStart(6)}%  ${String(lh).padStart(4)}/${String(lf).padEnd(4)}  ${sf}`);
}
console.log(`\n  TOTAL ${((totalHit / Math.max(totalLines, 1)) * 100).toFixed(1)}%  (${totalHit}/${totalLines} lines)`);
console.log('  merged lcov: coverage/merged/lcov.info');
