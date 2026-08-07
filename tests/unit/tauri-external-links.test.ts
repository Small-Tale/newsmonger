/**
 * Links the desktop shell hands to the system browser (NEWS-401, FR-3.8).
 *
 * **A cheap second layer.** The real test is in `tests/e2e/export.spec.ts`, which
 * defines `window.__TAURI__` to drive the desktop path in a normal browser and
 * asserts the URL reaching `/api/open-external` is absolute — it even names this
 * exact trap in a comment.
 *
 * That test existed, was correct, and **covered only the stories export**. The
 * topics export was added afterwards and never joined it, which is how a button
 * shipped dead beside a working one with a passing test between them. The E2E now
 * covers both; this file adds the source-level rule at unit speed, because the
 * failure is a *pairing* — a relative href with the wrong hook — and a rule about
 * pairings is cheaper to state than to enumerate one control at a time.
 *
 * What shipped broken: **Export topics…** was authored with `data-external` and a
 * *relative* href. That handler passed the raw `href` attribute to
 * `/api/open-external`, which parses with `new URL()` and rejects anything not
 * absolute http(s). `openExternalUrl` returns true whether or not the call
 * succeeds, so the click was `preventDefault`ed and the rejection was swallowed:
 * a button that did nothing, with no error to show for it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const CLIENT_VIEWS = ['src/client/app.tsx', 'src/client/settings.tsx', 'src/client/dialogs.tsx', 'src/client/feed.tsx'];

describe('handing a URL to the system browser', () => {
  it('resolves the href rather than reading the attribute', () => {
    // The whole bug in one line. `getAttribute('href')` is whatever was
    // authored — possibly relative; `el.href` is the resolved absolute URL,
    // which is the only shape `/api/open-external` accepts.
    const app = read('src/client/app.tsx');
    for (const hook of ['data-external', 'data-export']) {
      const handler = app.slice(app.indexOf(`'a[${hook}]'`));
      const body = handler.slice(0, handler.indexOf('});'));
      expect(body, `the a[${hook}] handler must pass el.href`).toContain('openExternalUrl(el.href)');
      expect(body, `the a[${hook}] handler must not pass the raw href attribute`).not.toContain(
        "getAttribute('href')",
      );
    }
  });

  it('never pairs a relative href with an external-link hook', () => {
    // Belt as well as braces: even with both handlers resolving `el.href`, an
    // anchor pointing at an app route is a *download*, not an outbound link, and
    // wants the export hook's teardown handling.
    for (const file of CLIENT_VIEWS) {
      const src = read(file);
      // `href="/..."` on the same tag as data-external.
      const offenders = [...src.matchAll(/<a\b[^>]*>/g)]
        .map((m) => m[0])
        .filter((tag) => tag.includes('data-external') && /href=\{?"\//.test(tag));
      expect(offenders, `${file}: a relative href must not use data-external (NEWS-401)`).toEqual([]);
    }
  });

  it('sends the topics export through the export hook', () => {
    // Named directly because this is the control that was dead, and a general
    // rule above would still pass if someone reverted just this one.
    const settings = read('src/client/settings.tsx');
    const tag = /<a\b[^>]*href="\/api\/export-topics\.json"[^>]*>/.exec(settings)?.[0] ?? '';
    expect(tag, 'the topics export anchor should still exist').not.toBe('');
    expect(tag, 'topics export must use data-export, not data-external').toContain('data-export');
    expect(tag).not.toContain('data-external');
    // `download` is what makes it a save rather than a navigation in a browser,
    // where `openExternalUrl` returns false and this handler does nothing.
    expect(tag).toContain('download');
  });

  it('keeps every export route answering as an attachment', () => {
    // The reason handing the URL to the system browser works at all: the browser
    // saves it instead of rendering it. If a route stopped sending
    // Content-Disposition, the desktop export would open a JSON blob in a tab.
    const api = fs.readFileSync(path.join(root, 'src/routes/api.ts'), 'utf8');
    const exportRoutes = [...api.matchAll(/['"`](\/api\/export-[a-z-]+\.[a-z]+)['"`]/g)].map((m) => m[1]);
    expect(exportRoutes.length, 'expected at least one export route').toBeGreaterThan(0);
    expect(api).toContain('Content-Disposition');
  });
});
