import { beforeEach, describe, expect, it } from 'vitest';

import { readOnboardingSeen, writeOnboardingSeen } from '../../src/client/stores.js';

/**
 * The dismissal flag for the first-run guide (NEWS-423).
 *
 * The reported symptom was that deleting `~/.newsmonger` did not bring the setup
 * guide back. The flag lives in the webview's `localStorage`, which the data
 * directory cannot reach — so the desktop app had no factory reset: every topic
 * and every setting gone, and the app still behaving as though it had already
 * introduced itself.
 *
 * The fix is that the flag names the **install it was dismissed for** rather
 * than being a bare `'1'`. That keeps the per-browser property FR-20.3 chose
 * deliberately, which moving the flag to the server would have given up.
 */

const KEY = 'news:onboarding-seen';

/** Minimal localStorage stand-in — these run in Node, not a browser. */
function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => {
      store.clear();
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  return store;
}

beforeEach(() => {
  installStorage();
});

describe('reading the flag', () => {
  it('is unseen on a browser that has never been shown the guide', () => {
    expect(readOnboardingSeen('install-a')).toBe(false);
  });

  it('is seen once dismissed against the same install', () => {
    writeOnboardingSeen('install-a');
    expect(readOnboardingSeen('install-a')).toBe(true);
  });

  it('is unseen against a different install — the reported bug', () => {
    // Deleting the data directory mints a new id, so the flag left behind names
    // a database that no longer exists and must not suppress anything.
    writeOnboardingSeen('install-a');
    expect(readOnboardingSeen('install-b')).toBe(false);
  });

  it("does not honour the pre-NEWS-423 '1', on purpose", () => {
    // Honouring it was the first attempt at this change, and it defeated the fix
    // for the only person it was for: the report came from someone whose webview
    // already held a '1', so reading it as "seen" left them with exactly the
    // behaviour they filed. It also spared nobody — the case it was meant to
    // protect is an existing user on upgrade, and they have topics, which is
    // already the whole auto-open test.
    installStorage({ [KEY]: '1' });
    expect(readOnboardingSeen('install-a')).toBe(false);
  });

  it('writes nothing when it cannot name the install', () => {
    // A placeholder would be a dismissal no id ever matches — a flag that can
    // only read as unseen, which is worse than an absent one because it looks
    // like a record.
    const store = installStorage();
    writeOnboardingSeen('');
    expect(store.has(KEY)).toBe(false);
  });

  it('treats an unknown install id as seen, not unseen', () => {
    // '' means the server did not say — an older build, or a state response
    // cached across an upgrade. The wrong guess in this direction is a missing
    // prompt; the other direction is a wizard over an established user's feed.
    writeOnboardingSeen('install-a');
    expect(readOnboardingSeen('')).toBe(true);
    installStorage();
    expect(readOnboardingSeen('')).toBe(true);
  });
});

describe('the sequence the ticket describes', () => {
  it('shows the guide, stays quiet, then shows it again after a data-dir delete', () => {
    // A walked sequence rather than the states in isolation: every step here
    // passed on its own while the behaviour as a whole was wrong, which is the
    // blindness the testing philosophy describes.
    expect(readOnboardingSeen('install-a')).toBe(false); // first launch — show it

    writeOnboardingSeen('install-a'); // user dismisses
    expect(readOnboardingSeen('install-a')).toBe(true); // reload — stays shut
    expect(readOnboardingSeen('install-a')).toBe(true); // restart — still shut

    // `rm -rf ~/.newsmonger`, then relaunch: a new database, a new id.
    expect(readOnboardingSeen('install-b')).toBe(false); // show it again

    writeOnboardingSeen('install-b');
    expect(readOnboardingSeen('install-b')).toBe(true);
    // And the old id does not come back to haunt a database that outlived it.
    expect(readOnboardingSeen('install-a')).toBe(false);
  });

  it('keeps two browsers independent against one server', () => {
    // The property FR-20.3 chose on purpose, and the one a server-side flag
    // would have cost. Two localStorages, one install id.
    const browserOne = installStorage();
    writeOnboardingSeen('install-a');
    expect(readOnboardingSeen('install-a')).toBe(true);
    expect(browserOne.get(KEY)).toBe('install-a');

    installStorage(); // a second browser, same server
    expect(readOnboardingSeen('install-a')).toBe(false);
  });
});
