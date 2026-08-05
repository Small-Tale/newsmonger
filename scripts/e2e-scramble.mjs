/**
 * Run the E2E specs in a scrambled file order (NEWS-314).
 *
 * Playwright orders files alphabetically and offers no hook to change it, so
 * the order is imposed by *name*: the specs are copied to a scratch directory
 * with a numeric prefix, and a wrapper config points `testDir` at the copy.
 * Everything else — the shared server, the single worker, the per-file serial
 * mode — is the real config, because the leakage this is hunting only exists
 * when the files share a server.
 *
 * Not part of any gate. It is the audit NEWS-314 asks for before sharding:
 * cross-file order dependencies are what would turn sharding into a flake
 * storm, and this asks the question serially, where a failure is legible.
 *
 * Usage: node scripts/e2e-scramble.mjs [seed]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const seed = Number(process.argv[2] ?? 1);
const root = process.cwd();
const src = path.join(root, 'tests/e2e');
const dst = path.join(root, 'tests/e2e-scramble');

// `real-providers` is opt-in and spends plan quota; it is never in a gate run.
const specs = fs
  .readdirSync(src)
  .filter((f) => f.endsWith('.spec.ts') && f !== 'real-providers.spec.ts')
  .sort();

/** Deterministic per-seed shuffle, so a failing order can be replayed exactly. */
function shuffle(items, s) {
  const out = [...items];
  let state = s * 2654435761 + 1;
  const next = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
fs.copyFileSync(path.join(src, 'fixtures.ts'), path.join(dst, 'fixtures.ts'));

const order = shuffle(specs, seed);
order.forEach((f, i) => {
  fs.copyFileSync(path.join(src, f), path.join(dst, `${String(i).padStart(2, '0')}-${f}`));
});

fs.writeFileSync(
  path.join(root, 'playwright.scramble.config.ts'),
  `import base from './playwright.config.js';\nexport default { ...base, testDir: 'tests/e2e-scramble' };\n`,
);

console.log(`[scramble seed=${seed}] ${order.join(' → ')}\n`);
let failed = false;
try {
  execFileSync('npx', ['playwright', 'test', '--config=playwright.scramble.config.ts', '--reporter=line'], {
    stdio: 'inherit',
  });
} catch {
  failed = true;
} finally {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.rmSync(path.join(root, 'playwright.scramble.config.ts'), { force: true });
}
console.log(`\n[scramble seed=${seed}] ${failed ? 'FAILED' : 'passed'} — order above`);
process.exit(failed ? 1 : 0);
