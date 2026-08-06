import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The desktop shell explains a server that never started (NEWS-338).
 *
 * The failure this was written for: a database that refuses to open makes the
 * server exit with a message saying exactly what happened *and* that the user's
 * data is untouched. That message went to stderr, which the shell inherited —
 * so in a bundled `.app`, with no terminal behind it, it went nowhere. The user
 * got a window stuck on a spinner and no reason to believe their news was still
 * there.
 *
 * Two halves have to agree for the message to arrive, and nothing else checks
 * that they do: the Rust calls `window.showExited(detail)`, and the loading page
 * has to define it *and take the argument*. A page whose `showExited()` ignored
 * its parameter would compile, run, and silently show nothing — which is the
 * bug, back again. The Rust half's own logic is tested in `src-tauri/src/lib.rs`.
 *
 * The rest of the shell needs a GUI and a Rust toolchain; see
 * [`docs/manual-test-plan.md`](../../docs/manual-test-plan.md).
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const loadingPage = fs.readFileSync(path.join(root, 'src-tauri/loading/index.html'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');

/**
 * Run the loading page's script against a stub DOM and report what it painted.
 *
 * Hand-rolled rather than jsdom, which this repo doesn't carry: the page uses
 * four DOM features in total, and pulling in a browser environment to reach
 * them would cost more than it explains.
 */
type Hooks = Record<string, ((detail?: string) => void) | undefined>;

function render(call: (win: Hooks) => void): Record<string, string> {
  const painted: Record<string, string> = {};
  const element = (id: string): Record<string, unknown> => ({
    set textContent(value: string) {
      painted[id] = value;
    },
    set className(value: string) {
      painted[`${id}.class`] = value;
    },
    set hidden(value: boolean) {
      painted[`${id}.hidden`] = String(value);
    },
  });
  const known = new Map<string, Record<string, unknown>>();
  const document = {
    getElementById: (id: string): Record<string, unknown> => {
      const existing = known.get(id);
      if (existing !== undefined) return existing;
      const made = element(id);
      known.set(id, made);
      return made;
    },
  };
  const win: Hooks = {};
  const script = /<script>([\s\S]*?)<\/script>/.exec(loadingPage)?.[1];
  expect(script, 'the loading page has an inline script').toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const define = new Function('document', 'window', script ?? '') as (doc: unknown, w: Hooks) => void;
  define(document, win);
  call(win);
  return painted;
}

describe('the shell reports a server that exited before it was ready (NEWS-338)', () => {
  it('shows what the server said, verbatim', () => {
    // The whole point of the ticket. The reassurance is the load-bearing half:
    // someone looking at a broken app deletes things to fix it.
    const detail =
      'newsmonger: cannot open the database at /home/x/.newsmonger/newsmonger.db — Error: duplicate column name: thread_id\n' +
      'Your data has NOT been touched.';
    const painted = render((win) => {
      win.showExited?.(detail);
    });
    expect(painted.detail).toBe(detail);
  });

  it('takes its detail as an argument rather than ignoring it', () => {
    // A `showExited()` that took no parameter would still run, still hide the
    // spinner, and still tell the user nothing. That is the bug, restored.
    const painted = render((win) => {
      win.showExited?.('the reason');
    });
    expect(painted.detail).toBe('the reason');
    expect(painted.detail).not.toBe('');
  });

  it('says a failed start does not delete anything', () => {
    const painted = render((win) => {
      win.showExited?.('boom');
    });
    expect(painted['reassure.hidden']).toBe('false');
    expect(loadingPage).toMatch(/does not delete your topics or stories/i);
  });

  it('covers the never-started path the same way', () => {
    // `showError` fires before a server exists, so there is no server output —
    // but the user's need is identical and so is the treatment.
    const painted = render((win) => {
      win.showError?.('bundled Node sidecar is missing: /Applications/x.app/newsmonger-node');
    });
    expect(painted.detail).toContain('sidecar is missing');
    expect(painted['reassure.hidden']).toBe('false');
  });

  it('stops sending people to a terminal a bundled app does not have', () => {
    // The old copy read "Check the terminal output." A double-clicked `.app`
    // has nowhere to check, which is what made this a dead end.
    expect(loadingPage).not.toMatch(/terminal/i);
  });

  it('defines every hook the Rust actually calls', () => {
    const called = [...shell.matchAll(/window\.(show\w+)\s*&&/g)].map((m) => m[1]);
    expect(called.length).toBeGreaterThan(0);
    for (const hook of called) {
      expect(loadingPage, `loading page defines window.${hook}`).toContain(`window.${hook} =`);
    }
  });

  it('pipes the server stderr instead of inheriting it', () => {
    // The root cause in one line: inherited stderr goes to a terminal the
    // shell cannot read and a bundled app does not have.
    expect(shell).not.toMatch(/\.stderr\(Stdio::inherit\(\)\)/);
    expect(shell).toMatch(/\.stderr\(Stdio::piped\(\)\)/);
  });
});
