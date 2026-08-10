/**
 * Desktop auto-update state (NEWS-89).
 *
 * The store is what decides whether the banner is on screen and what its button
 * says, so these walk *sequences* rather than each action from a clean state —
 * the bugs in this shape of code live in the transitions (a re-announced version
 * resurrecting a dismissed banner, an install state surviving into a newer
 * version) and single-action tests can't see them. See CLAUDE.md, "Testing
 * Philosophy → transition-matrix testing".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { appStore } from '../../src/client/stores.js';
import { getTauriInvoke, isTauri } from '../../src/client/tauri.js';
import { updateCheckFailure } from '../../src/client/update.js';

/** Reset just the update slice, leaving the rest of the store alone. */
beforeEach(() => {
  appStore.actions.setUpdateVersion(null);
  appStore.actions.setUpdateInstall('idle');
  appStore.actions.setUpdateCheckMessage(null);
});

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

const s = () => appStore.state.value;

/**
 * Run `body` with a faked desktop shell.
 *
 * The unit env is Node with no `window`, and `getTauriGlobal()` reads
 * `window.__TAURI__` — so faking the window is what makes the shell-only paths
 * reachable at all here (same trick as `notifications.test.ts`). Removed
 * afterwards so a leaked window can't make a later test think it's in the shell.
 */
function withTauri(tauri: unknown, body: () => void): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const had = 'window' in g;
  const prev = g['window'];
  g['window'] = { __TAURI__: tauri };
  try {
    body();
  } finally {
    if (had) g['window'] = prev;
    else delete g['window'];
  }
}

describe('update state', () => {
  it('starts with nothing pending', () => {
    expect(s().updateVersion).toBeNull();
    expect(s().updateDismissed).toBe(false);
    expect(s().updateInstall).toBe('idle');
    expect(s().updateCheckMessage).toBeNull();
  });

  it('records a pending version', () => {
    appStore.actions.setUpdateVersion('0.2.0');
    expect(s().updateVersion).toBe('0.2.0');
    expect(s().updateDismissed).toBe(false);
  });

  it('keeps a dismissal when the same version is announced again', () => {
    // The startup poll reads `get_pending_update` up to three times, and a
    // Settings check can announce the same version a fourth. If any of those
    // re-set the version, the banner the user just closed comes straight back.
    appStore.actions.setUpdateVersion('0.2.0');
    appStore.actions.dismissUpdate();
    expect(s().updateDismissed).toBe(true);

    appStore.actions.setUpdateVersion('0.2.0');
    expect(s().updateDismissed).toBe(true);
  });

  it('un-dismisses for a newer version', () => {
    appStore.actions.setUpdateVersion('0.2.0');
    appStore.actions.dismissUpdate();
    appStore.actions.setUpdateVersion('0.3.0');

    expect(s().updateVersion).toBe('0.3.0');
    expect(s().updateDismissed).toBe(false);
  });

  it('walks an install through to installed', () => {
    appStore.actions.setUpdateVersion('0.2.0');
    appStore.actions.setUpdateInstall('installing');
    expect(s().updateInstall).toBe('installing');
    appStore.actions.setUpdateInstall('installed');
    expect(s().updateInstall).toBe('installed');
    // Still pending, deliberately: the binary is on disk but this process is
    // running the old one, so the banner has to stay up asking for a restart.
    expect(s().updateVersion).toBe('0.2.0');
  });

  it('allows a retry after a failed install', () => {
    appStore.actions.setUpdateVersion('0.2.0');
    appStore.actions.setUpdateInstall('installing');
    appStore.actions.setUpdateInstall('failed');
    appStore.actions.setUpdateInstall('installing');
    expect(s().updateInstall).toBe('installing');
  });

  it('resets install progress when a newer version arrives', () => {
    // Without this a user who installed 0.2.0 and left the app open would see
    // the 0.3.0 banner with no Install button, because the old terminal
    // `installed` state was still driving it.
    appStore.actions.setUpdateVersion('0.2.0');
    appStore.actions.setUpdateInstall('installed');
    appStore.actions.setUpdateVersion('0.3.0');
    expect(s().updateInstall).toBe('idle');
  });

  it('resets install progress when a failed version is superseded', () => {
    appStore.actions.setUpdateVersion('0.2.0');
    appStore.actions.setUpdateInstall('failed');
    appStore.actions.setUpdateVersion('0.3.0');
    expect(s().updateInstall).toBe('idle');
  });

  it('clears a pending update back to nothing', () => {
    appStore.actions.setUpdateVersion('0.2.0');
    appStore.actions.dismissUpdate();
    appStore.actions.setUpdateVersion(null);
    expect(s().updateVersion).toBeNull();
    expect(s().updateDismissed).toBe(false);
  });

  it('survives a dismiss during an install', () => {
    // Adversarial: closing the banner mid-install must not lose the fact that
    // the install is running, or a re-open would offer to start a second one.
    appStore.actions.setUpdateVersion('0.2.0');
    appStore.actions.setUpdateInstall('installing');
    appStore.actions.dismissUpdate();
    expect(s().updateInstall).toBe('installing');
    appStore.actions.setUpdateInstall('installed');
    expect(s().updateDismissed).toBe(true);
    expect(s().updateInstall).toBe('installed');
  });

  it('survives repeated dismissals', () => {
    appStore.actions.setUpdateVersion('0.2.0');
    appStore.actions.dismissUpdate();
    appStore.actions.dismissUpdate();
    expect(s().updateDismissed).toBe(true);
    expect(s().updateVersion).toBe('0.2.0');
  });
});

describe('settings update check', () => {
  it('keeps the native reason when a manual check fails', () => {
    expect(updateCheckFailure('error sending request for url')).toBe(
      'Could not check for updates: error sending request for url',
    );
    expect(updateCheckFailure(new Error('the platform was not found'))).toBe(
      'Could not check for updates: the platform was not found',
    );
  });

  it('falls back safely when the rejection carries no readable reason', () => {
    expect(updateCheckFailure(undefined)).toBe('Could not check for updates.');
    expect(updateCheckFailure('   ')).toBe('Could not check for updates.');
  });

  it('clears the previous result when a new check starts', () => {
    // Otherwise "up to date" from a minute ago sits under a spinning button and
    // reads as the answer to the check now running.
    appStore.actions.setUpdateCheckMessage('Newsmonger is up to date.');
    appStore.actions.setUpdateChecking(true);
    expect(s().updateChecking).toBe(true);
    expect(s().updateCheckMessage).toBeNull();
  });

  it('ends the checking state when a result lands', () => {
    appStore.actions.setUpdateChecking(true);
    appStore.actions.setUpdateCheckMessage('Could not check for updates.');
    expect(s().updateChecking).toBe(false);
    expect(s().updateCheckMessage).toBe('Could not check for updates.');
  });

  it('leaves the message alone when checking is set false directly', () => {
    appStore.actions.setUpdateCheckMessage('Update available: v0.2.0');
    appStore.actions.setUpdateChecking(false);
    expect(s().updateCheckMessage).toBe('Update available: v0.2.0');
  });

  it('does not disturb a pending update found by the startup poll', () => {
    appStore.actions.setUpdateVersion('0.2.0');
    appStore.actions.setUpdateChecking(true);
    appStore.actions.setUpdateCheckMessage('Update available: v0.2.0');
    expect(s().updateVersion).toBe('0.2.0');
  });
});

describe('the Tauri command bridge', () => {
  it('is absent outside the desktop shell', () => {
    // Which is what keeps the browser build from rendering an Install button
    // for a binary it has no way to replace.
    expect(isTauri()).toBe(false);
    expect(getTauriInvoke()).toBeUndefined();
  });

  it('is the shell-provided invoke when the global is present', () => {
    const invoke = () => Promise.resolve('0.2.0');
    withTauri({ core: { invoke } }, () => {
      expect(isTauri()).toBe(true);
      expect(getTauriInvoke()).toBe(invoke);
    });
  });

  it('is absent when the shell exposes no core namespace', () => {
    // An older shell, or one built without `withGlobalTauri` — `isTauri()` is
    // true but there is no bridge, so every caller must still handle undefined.
    withTauri({}, () => {
      expect(isTauri()).toBe(true);
      expect(getTauriInvoke()).toBeUndefined();
    });
  });
});

describe('the updater endpoint is single-channel by decision (NEWS-205)', () => {
  // Parsed through zod rather than cast — validate, don't assert, same as the
  // rest of the project (and `strictTypeChecked` rejects the bare `any` anyway).
  const ConfSchema = z.object({
    plugins: z.object({
      updater: z.object({ endpoints: z.array(z.string()), pubkey: z.string() }),
    }),
  });
  const conf = (): z.infer<typeof ConfSchema> =>
    ConfSchema.parse(JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')));

  it('points every build at exactly one manifest', () => {
    // Copied from glassbox, which ships one endpoint and no channel handling.
    // The consequence is deliberate: `releases/latest` skips prereleases, so a
    // beta install takes the next *stable* release and rejoins the stable
    // channel. A beta is a one-way trip (FR-5.18, docs/5-desktop-app.md).
    const endpoints = conf().plugins.updater.endpoints;
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toBe(
      'https://github.com/Small-Tale/newsmonger/releases/latest/download/latest.json',
    );
  });

  it('has no per-channel manifest', () => {
    // A second endpoint would buy a "stay on beta" mode nobody asked for and cost
    // a channel-switching problem — the endpoint is compiled into the binary, so
    // moving channels stops being an update and becomes a reinstall.
    const raw = fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8');
    expect(raw).not.toContain('beta.json');
    expect(raw).not.toContain('channel=');
  });

  it('carries a pubkey, without which the endpoint is meaningless', () => {
    expect(conf().plugins.updater.pubkey).not.toBe('');
  });
});
