import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Every `/static/…` the client asks for is actually built and shipped (NEWS-203).
 *
 * The masthead wordmark shipped broken in a packaged build because the asset
 * pipeline had **three** copy lists and only two were known about:
 * `build:client`, `build:client:dev`, and a hardcoded `cp` in
 * `scripts/build-sidecar.sh`. CLAUDE.md said to update "both copy lists".
 *
 * `build-sidecar.sh` no longer has a list — it copies everything `build:client`
 * produced, and its isolated boot check now fetches every staged file. That closes
 * "in dist/client but not in the bundle".
 *
 * This closes the other half: "referenced by the client but never built at all".
 * Neither the boot check nor E2E can see that one — the boot check derives its
 * URLs from what was staged, so an asset that was never produced is never checked,
 * and E2E serves the same `dist/client` the dev build writes.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** URLs the server generates rather than copying — not files in `assets/`. */
const GENERATED = new Set(['/static/app.js', '/static/styles.css']);

/** Source files that may reference a static asset. */
const SOURCES = ['src/client/app.tsx', 'src/components/layout.tsx', 'src/routes/pages.tsx'];

const pkg = (): { scripts: Record<string, string> } =>
  z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')));

/** Every distinct `/static/…` path the client source references. */
function referencedAssets(): string[] {
  const found = new Set<string>();
  for (const rel of SOURCES) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    for (const m of fs.readFileSync(full, 'utf8').matchAll(/\/static\/[A-Za-z0-9._-]+/g)) {
      found.add(m[0]);
    }
  }
  return [...found].sort();
}

/**
 * The filenames a `build:client*` script copies out of `assets/`.
 *
 * Both scripts embed the list inside an inline `node -e`, so it is parsed out of
 * the array literal rather than read from anywhere structured.
 */
function copyList(script: string): string[] {
  const arr = /for \(const f of \[([^\]]+)\]\)/.exec(script);
  if (arr === null) return [];
  return [...arr[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

describe('client static assets are built and shipped (NEWS-203)', () => {
  it('finds the references it is supposed to be checking', () => {
    // Guards the guard: a regex that silently matched nothing would make every
    // assertion below vacuously true.
    const refs = referencedAssets();
    expect(refs.length).toBeGreaterThanOrEqual(5);
    expect(refs).toContain('/static/wordmark-light.svg');
    expect(refs).toContain('/static/wordmark-dark.svg');
  });

  it('every referenced asset is either generated or copied from assets/', () => {
    const copied = new Set(copyList(pkg().scripts['build:client']));
    const missing = referencedAssets()
      .filter((url) => !GENERATED.has(url))
      .filter((url) => !copied.has(path.basename(url)));
    expect(missing, 'referenced but never copied into dist/client').toEqual([]);
  });

  it('every copied asset actually exists in assets/', () => {
    // A name in the copy list with no file behind it fails the build loudly, but
    // only when someone runs it — this says so in a second.
    const missing = copyList(pkg().scripts['build:client']).filter(
      (name) => !fs.existsSync(path.join(root, 'assets', name)),
    );
    expect(missing, 'listed in build:client but absent from assets/').toEqual([]);
  });

  it('the prod and dev copy lists agree', () => {
    // They differ only in `__KERF_DEV__`. An asset added to one and not the other
    // works in exactly one of the two modes, which is a confusing way to find out.
    const { scripts } = pkg();
    expect(copyList(scripts['build:client:dev'])).toEqual(copyList(scripts['build:client']));
  });

  it('build-sidecar.sh does not hardcode an asset list', () => {
    // The actual regression. It used to name four files, which made it a third
    // list — and the invisible one, since CLAUDE.md documents two. It now copies
    // whatever build:client produced, so this asserts the fix cannot be undone
    // quietly.
    const sh = fs.readFileSync(path.join(root, 'scripts/build-sidecar.sh'), 'utf8');
    const staging = /# --- 3\. Stage the server bundle[\s\S]*?# A package\.json beside cli\.js/.exec(sh);
    expect(staging, 'staging section not found — has the script been restructured?').not.toBeNull();
    const code = (staging?.[0] ?? '')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    // Naming any specific asset here is the thing that rots.
    for (const name of copyList(pkg().scripts['build:client'])) {
      expect(code, `build-sidecar.sh names ${name} explicitly`).not.toContain(name);
    }
  });

  it('the staged-bundle check verifies assets rather than a fixed pair', () => {
    // The check existed to catch staging mistakes and missed this one because its
    // own URL list was hardcoded. A check with a hardcoded list cannot catch a
    // hardcoded list being wrong, so it must enumerate what was staged.
    const sh = fs.readFileSync(path.join(root, 'scripts/build-sidecar.sh'), 'utf8');
    expect(sh).not.toContain('for path in /healthz /static/app.js /static/styles.css');
    expect(sh).toMatch(/for f in "\$VERIFY_DIR"\/server\/client\/\*/);
  });
});
