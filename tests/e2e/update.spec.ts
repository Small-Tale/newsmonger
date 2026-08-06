/**
 * Desktop auto-update, end to end (NEWS-89).
 *
 * The update surface only exists inside the Tauri shell, and Playwright drives a
 * normal browser — so these fake `window.__TAURI__` with a scripted `core.invoke`
 * before load. That is the same trick the export-in-Tauri test uses (app.spec.ts):
 * the client's only test for "am I in the desktop app" is that global, so defining
 * it drives the real banner, the real delegate handlers and the real store
 * transitions. Everything below the bridge — the Rust commands, the signed
 * manifest, an actual install — is manual (docs/manual-test-plan.md).
 *
 * Self-contained rather than appended to app.spec.ts: the injected global changes
 * how *every* external link behaves, which is not something to leave switched on
 * inside that file's shared serial state.
 */

import type { Page } from '@playwright/test';

import { expect, openSettingsTab, resetSharedState, test, workerBaseURL } from './fixtures.js';

test.describe.configure({ mode: 'serial' });

// Every spec file establishes its own precondition (NEWS-313). This one used to
// inherit whatever the previous file left behind — which is fine until that file
// fails before its own cleanup, and then the failure lands here instead.
test.beforeAll(async () => {
  await resetSharedState(workerBaseURL());
});

/** How the fake shell should answer each command. */
interface ShellScript {
  /** Version returned by `get_pending_update` (the startup check's result). */
  pending?: string | null;
  /** Version returned by `check_for_update` (the Settings button). */
  check?: string | null;
  /** Whether `install_update` rejects. */
  installFails?: boolean;
}

/**
 * Install a fake desktop shell for the next navigation.
 *
 * Records every command name on `window.__invoked` so a test can assert that the
 * client actually went through the bridge rather than guessing a version.
 */
async function fakeShell(page: Page, script: ShellScript): Promise<void> {
  await page.addInitScript((s: ShellScript) => {
    const w = window as unknown as Record<string, unknown>;
    const invoked: string[] = [];
    w['__invoked'] = invoked;
    w['__TAURI__'] = {
      core: {
        invoke: (cmd: string) => {
          invoked.push(cmd);
          if (cmd === 'get_pending_update') return Promise.resolve(s.pending ?? null);
          if (cmd === 'check_for_update') return Promise.resolve(s.check ?? null);
          if (cmd === 'install_update') {
            return s.installFails === true ? Promise.reject(new Error('nope')) : Promise.resolve(null);
          }
          return Promise.resolve(null);
        },
      },
    };
  }, script);
}

const banner = '.banner.update';

test('the browser build shows no update banner and no update check (NEWS-89)', async ({ page }) => {
  // The negative case first, and it needs no fake shell — that's the point. A
  // browser pointed at the localhost server has no app binary to replace, so
  // offering to install one would be a dead button.
  await page.goto('/');
  await expect(page.locator(banner)).toHaveCount(0);
  await openSettingsTab(page, 'App');
  await expect(page.locator('[data-action=check-updates]')).toHaveCount(0);
});

test('an update found at startup is announced in the banner (NEWS-89)', async ({ page }) => {
  await fakeShell(page, { pending: '9.9.9' });
  await page.goto('/');

  await expect(page.locator(banner)).toBeVisible();
  await expect(page.locator(`${banner} .banner-text`)).toHaveText('Newsmonger 9.9.9 is available.');
  // Announced, not applied: nothing is installed until the user says so.
  const invoked = await page.evaluate(() => (window as unknown as { __invoked: string[] }).__invoked);
  expect(invoked).toContain('get_pending_update');
  expect(invoked).not.toContain('install_update');
});

test('the banner lives in the live region so the announcement is heard (NEWS-89)', async ({ page }) => {
  // `#banners` is an ARIA live region that must exist before its content or the
  // announcement is lost (NEWS-99, docs/3-ui.md) — a banner rendered outside it
  // would look right and say nothing.
  await fakeShell(page, { pending: '9.9.9' });
  await page.goto('/');
  await expect(page.locator(`#banners ${banner}`)).toBeVisible();
});

test('installing an update ends by asking for a restart (NEWS-89)', async ({ page }) => {
  await fakeShell(page, { pending: '9.9.9' });
  await page.goto('/');

  await page.locator('[data-action=install-update]').click();

  await expect(page.locator(`${banner} .banner-text`)).toHaveText(
    'Newsmonger 9.9.9 is installed — restart to start using it.',
  );
  // The Install button is gone — there is nothing left to install, and the only
  // remaining step is one this process can't take for the user.
  await expect(page.locator('[data-action=install-update]')).toHaveCount(0);
  const invoked = await page.evaluate(() => (window as unknown as { __invoked: string[] }).__invoked);
  expect(invoked).toContain('install_update');
});

test('a failed install offers a retry rather than a dead end (NEWS-89)', async ({ page }) => {
  await fakeShell(page, { pending: '9.9.9', installFails: true });
  await page.goto('/');

  const install = page.locator('[data-action=install-update]');
  await install.click();

  await expect(install).toHaveText('Install failed — retry');
  await expect(install).toBeEnabled();
  // The pending version survives the failure, so the retry has something to do.
  await expect(page.locator(`${banner} .banner-text`)).toHaveText('Newsmonger 9.9.9 is available.');
});

test('the update banner can be dismissed (NEWS-89)', async ({ page }) => {
  await fakeShell(page, { pending: '9.9.9' });
  await page.goto('/');

  await expect(page.locator(banner)).toBeVisible();
  await page.locator(`${banner} [data-action=dismiss-update]`).click();
  await expect(page.locator(banner)).toHaveCount(0);

  // The sleep that used to be here (3500ms, against the [0, 3000, 10_000] startup
  // poll delays) was waiting for polls that never fire: `pollPendingUpdate`
  // *returns* as soon as a version comes back, and this fixture answers on the
  // first call. So it proved nothing except that 3.5 seconds had passed
  // (NEWS-228).
  //
  // What is genuinely checkable here is that exactly one poll happened and the
  // banner stayed closed. Re-announcing the same version *is* protected —
  // `setUpdateVersion` returns early when the version is unchanged, so the
  // dismissal survives — and that is covered directly in
  // `tests/unit/update.test.ts` ("keeps a dismissal when the same version is
  // announced again"), which is the right level for it: no polling, no clock.
  const checks = await page.evaluate(
    () => (window as unknown as { __invoked: string[] }).__invoked.filter((c) => c === 'get_pending_update').length,
  );
  expect(checks, 'the startup loop stops at the first version it finds').toBe(1);
  await expect(page.locator(banner)).toHaveCount(0);
});

test('Settings reports an available update and raises the banner (NEWS-89)', async ({ page }) => {
  await fakeShell(page, { pending: null, check: '9.9.9' });
  await page.goto('/');

  // Nothing at startup, so this is purely the manual check's doing.
  await expect(page.locator(banner)).toHaveCount(0);
  await openSettingsTab(page, 'App');
  await page.locator('[data-action=check-updates]').click();

  await expect(page.locator('.update-check-note')).toHaveText('Update available: v9.9.9');
  await expect(page.locator('[data-action=check-updates]')).toHaveText('Check for updates');
  // The banner is waiting behind the dialog — the news reaches the user whether
  // or not they stay in Settings.
  await page.locator('.dialog [data-action=close-settings]').click();
  await expect(page.locator(banner)).toBeVisible();
});

test('Settings says so when the app is already current (NEWS-89)', async ({ page }) => {
  await fakeShell(page, { pending: null, check: null });
  await page.goto('/');

  await openSettingsTab(page, 'App');
  await page.locator('[data-action=check-updates]').click();

  // "Up to date" is only ever said to someone who asked — the startup check
  // stays silent, which is why this line lives in Settings and not the banner.
  await expect(page.locator('.update-check-note')).toHaveText('Newsmonger is up to date.');
  await expect(page.locator(banner)).toHaveCount(0);
});

test('a failed check from Settings says so instead of nothing (NEWS-89)', async ({ page }) => {
  // No `core` namespace: the shell is there but the bridge isn't, which is the
  // shape an older or misbuilt shell has. The button must not hang.
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>)['__TAURI__'] = {
      core: {
        invoke: (cmd: string) =>
          cmd === 'check_for_update' ? Promise.reject(new Error('offline')) : Promise.resolve(null),
      },
    };
  });
  await page.goto('/');

  await openSettingsTab(page, 'App');
  await page.locator('[data-action=check-updates]').click();

  await expect(page.locator('.update-check-note')).toHaveText('Could not check for updates.');
});
