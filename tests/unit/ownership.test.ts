import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * The project attributes itself to its owner, not to a person (NEWS-186).
 *
 * The repo moved to `Small-Tale/newsmonger` and is owned by Small Tale Inc., but
 * two pieces of metadata still carried a personal name: `package.json`'s
 * `author`, and — more consequentially — the Tauri bundle `identifier`, which
 * was `com.brianwestphal.newsmonger`. A bundle identifier is the app's permanent
 * identity on macOS: it keys code signing, notarization, notification
 * permissions and the app-support directory. It is the one field here that is
 * genuinely expensive to change *after* a release, which is why it is worth
 * pinning now, pre-launch, while changing it is free.
 *
 * Personal names get reintroduced by accident — a scaffolding tool that defaults
 * the identifier from `git config user.name`, a copy-paste from another project.
 * These assertions are cheap and they fail loudly when that happens.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The reverse-DNS prefix every bundle identifier must sit under. */
const ORG_PREFIX = 'com.smalltale';

/** The GitHub owner/repo the project now lives at. */
const REPO_SLUG = 'Small-Tale/newsmonger';

const readJson = (rel: string): unknown => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

const PackageSchema = z.object({
  name: z.string().min(1),
  author: z.string().min(1),
  repository: z.object({ type: z.literal('git'), url: z.string().min(1) }),
  bugs: z.object({ url: z.string().min(1) }),
  homepage: z.string().min(1),
});

const TauriSchema = z.object({ productName: z.string().min(1), identifier: z.string().min(1) });

const pkg = (): z.infer<typeof PackageSchema> => PackageSchema.parse(readJson('package.json'));
const tauri = (): z.infer<typeof TauriSchema> => TauriSchema.parse(readJson('src-tauri/tauri.conf.json'));

describe('the package attributes itself to the owning company (NEWS-186)', () => {
  it('names the company as author', () => {
    expect(pkg().author).toBe('Small Tale Inc.');
  });

  it('points every repo link at the current location', () => {
    // All three are checked together because npm surfaces them in different
    // places (`npm repo`, `npm bugs`, `npm docs`), and a stale one sends people
    // to a URL that either 404s or — worse, once a name is reused — to somebody
    // else's project.
    const { repository, bugs, homepage } = pkg();
    for (const url of [repository.url, bugs.url, homepage]) {
      expect(url).toContain(REPO_SLUG);
    }
  });

  it('mentions no personal name in its metadata', () => {
    // Deliberately checks only the fields this project owns. The
    // `brianwestphal/kerf` links in the README and CLAUDE.md are NOT covered:
    // kerfjs is a third-party dependency that genuinely still lives there, and
    // rewriting those URLs would break them.
    const { author, repository, bugs, homepage } = pkg();
    const owned = [author, repository.url, bugs.url, homepage, tauri().identifier].join(' ').toLowerCase();
    expect(owned).not.toContain('westphal');
  });
});

describe('the Tauri bundle identifier belongs to the org (NEWS-186)', () => {
  it('sits under the company reverse-DNS prefix', () => {
    expect(tauri().identifier.startsWith(`${ORG_PREFIX}.`)).toBe(true);
  });

  it('ends with the product name', () => {
    // Reverse-DNS convention, and it keeps the identifier legible in Console
    // logs and `codesign -dv` output where the trailing segment is what a human
    // scans for.
    const { identifier, productName } = tauri();
    expect(identifier).toBe(`${ORG_PREFIX}.${productName.toLowerCase()}`);
  });

  it('is a well-formed reverse-DNS string', () => {
    // Apple accepts only alphanumerics, hyphens and dots. An underscore or a
    // space is rejected at signing time — minutes into a build, on a machine
    // that may not be the one that introduced it.
    expect(tauri().identifier).toMatch(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/);
  });
});
