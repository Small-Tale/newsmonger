import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The quiet button variant must stay pressable-looking (NEWS-305).
 *
 * `.btn.subtle` was `background: none; border-color: transparent`, so at rest it
 * was `--ink-soft` text with no fill and no edge — sitting, on Settings → App,
 * among `--ink-soft` prose with no fill and no edge. Two features were reachable
 * only through controls that read as captions.
 *
 * The resting edge is asserted where a reader meets it, in
 * `tests/e2e/layout.spec.ts`, by computed style. The **disabled** half cannot be
 * asserted there: every subtle control that can be disabled — `install-update`,
 * `check-updates` — is desktop-only, so the browser E2E build has none to look
 * at. That leaves the stylesheet as the only place the rule exists, which is
 * exactly the kind of un-exercised declaration that gets "tidied" back to
 * `transparent` by someone reading the variant name literally.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scss = fs.readFileSync(path.join(root, 'src/client/styles.scss'), 'utf8');

/** The body of a top-level rule, brace-matched so nested blocks come with it. */
function ruleBody(selector: string): string {
  const at = scss.indexOf(`${selector} {`);
  expect(at, `${selector} not found in styles.scss`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = scss.indexOf('{', at); i < scss.length; i++) {
    if (scss[i] === '{') depth++;
    else if (scss[i] === '}' && --depth === 0) return scss.slice(at, i + 1);
  }
  throw new Error(`unterminated rule for ${selector}`);
}

describe('.btn.subtle (NEWS-305)', () => {
  const body = ruleBody('.btn.subtle');

  it('has a resting border colour that is not transparent', () => {
    const resting = /^\s*border-color:\s*(.+);/m.exec(body);
    expect(resting, 'the variant must declare a resting border-color').not.toBeNull();
    expect(resting?.[1]).not.toBe('transparent');
    expect(resting?.[1]).not.toBe('none');
  });

  it('never sets the border back to transparent in any of its states', () => {
    expect(body).not.toContain('border-color: transparent');
  });

  it('keeps the edge when disabled and fades less far than a filled button', () => {
    // The base `.btn:disabled` is 0.5. Against no fill that takes a hairline
    // below where it reads in dark mode, so the variant overrides it — and the
    // override has to be a *reduction*, or disabled stops looking disabled.
    const faded = /&:disabled\s*\{[^}]*opacity:\s*([\d.]+)/s.exec(body);
    expect(faded, 'subtle must set its own disabled opacity').not.toBeNull();
    const opacity = Number(faded?.[1]);
    expect(opacity).toBeGreaterThan(0.5);
    expect(opacity).toBeLessThan(1);
  });
});
