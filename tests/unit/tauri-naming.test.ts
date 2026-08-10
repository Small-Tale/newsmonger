import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * The app names itself consistently (NEWS-184).
 *
 * macOS names a **running** application from `CFBundleExecutable` — not from
 * `CFBundleName` or `CFBundleDisplayName`. Both of those were already correct
 * and the Dock still showed `newsmonger`, because the executable inherited the
 * Cargo *package* name, which is lowercase by crates.io convention.
 *
 * Verified rather than assumed: the built bundle was launched and
 * `lsappinfo list` reported it as `newsmonger`, alongside helper processes
 * named `newsmonger Networking` and `newsmonger Web Content`, while Finder and
 * Spotlight both showed `Newsmonger`. Three different names for one app.
 *
 * These assertions cover what a unit test can reach: the declared binary name
 * matches the product name. What the *bundle* ends up with needs a Rust
 * toolchain and minutes, so it stays in the manual plan alongside the icon
 * check that shares its cause.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tauriDir = path.join(root, 'src-tauri');

const ConfSchema = z.object({ productName: z.string().min(1) });

function productName(): string {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(tauriDir, 'tauri.conf.json'), 'utf8'));
  return ConfSchema.parse(raw).productName;
}

const cargoToml = (): string => fs.readFileSync(path.join(tauriDir, 'Cargo.toml'), 'utf8');

/**
 * The `[[bin]]` target's name.
 *
 * Read from `Cargo.toml` rather than from a build artifact, because the point is
 * to catch the mismatch *before* anything is built.
 */
function binaryName(): string | null {
  const section = /\[\[bin\]\]([\s\S]*?)(?=\n\[|$)/.exec(cargoToml());
  if (section === null) return null;
  return /^\s*name\s*=\s*"([^"]+)"/m.exec(section[1])?.[1] ?? null;
}

describe('the executable is named after the product (NEWS-184)', () => {
  it('declares an explicit [[bin]] target', () => {
    // Without one, cargo names the binary after the *package*, which is
    // lowercase by convention — and that name is what the Dock displays.
    expect(binaryName(), 'Cargo.toml should declare [[bin]] name').not.toBeNull();
  });

  it('names the binary exactly the product name', () => {
    // Not a case-insensitive comparison: the whole bug was a casing mismatch,
    // so folding case here would let the original defect pass.
    expect(binaryName()).toBe(productName());
  });

  it('points the [[bin]] target at a source file that exists', () => {
    // A renamed target with a stale `path` fails at build time rather than
    // here, which is a slower and more confusing way to find out.
    const section = /\[\[bin\]\]([\s\S]*?)(?=\n\[|$)/.exec(cargoToml());
    const declared = section === null ? null : /^\s*path\s*=\s*"([^"]+)"/m.exec(section[1])?.[1];
    expect(declared, '[[bin]] should declare a path').toBeTruthy();
    expect(fs.existsSync(path.join(tauriDir, declared ?? ''))).toBe(true);
  });

  it('keeps the sidecar binary name distinct from the app binary', () => {
    // `externalBin` resolves `<name>-<target-triple>` on disk. Renaming the app
    // binary to collide with the sidecar's stem would break that lookup in a
    // way that only shows up in a packaged build.
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(tauriDir, 'tauri.conf.json'), 'utf8'));
    const external = z
      .object({ bundle: z.object({ externalBin: z.array(z.string()).optional() }) })
      .parse(raw).bundle.externalBin;
    for (const rel of external ?? []) {
      expect(path.basename(rel)).not.toBe(binaryName());
    }
  });
});

describe('the window title is set but hidden on macOS (NEWS-185)', () => {
  const windowConfig = () => {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(tauriDir, 'tauri.conf.json'), 'utf8'));
    return z
      .object({
        app: z.object({
          windows: z
            .array(z.object({ title: z.string(), hiddenTitle: z.boolean().optional() }))
            .nonempty(),
        }),
      })
      .parse(raw).app.windows[0];
  };

  it('still declares a title', () => {
    // This is the assertion that matters. `hiddenTitle` hides the titlebar
    // *text*; the Window menu and the Dock icon's context menu read the window's
    // `title`. Clearing it — the obvious way to "remove the title" — would hide
    // the text and silently break both listings, which is the outcome the
    // ticket explicitly asked to avoid.
    expect(windowConfig().title.length).toBeGreaterThan(0);
  });

  it('names the window after the product', () => {
    expect(windowConfig().title).toBe(productName());
  });

  it('hides the titlebar text', () => {
    // Redundant with the wordmark in the app's own header, which is the whole
    // complaint. macOS-only by design — see FR-5.10 for why Windows and Linux
    // deliberately keep theirs.
    expect(windowConfig().hiddenTitle).toBe(true);
  });
});

describe('the capability reaches the origin the window actually loads (NEWS-40)', () => {
  const capability = (): Record<string, unknown> =>
    JSON.parse(
      fs.readFileSync(path.join(root, 'src-tauri/capabilities/default.json'), 'utf8'),
    ) as Record<string, unknown>;

  /**
   * The bug this pins, which cost a release and a hunt through macOS System
   * Settings for an entry that could not exist.
   *
   * `frontendDist` is a static loading page; `lib.rs` then navigates the webview
   * to the `http://127.0.0.1:PORT` the sidecar prints. From that moment the page
   * is a **remote origin**, and a Tauri capability with no `remote` block grants
   * its permissions to *local* origins only. So every permission below was
   * silently inert at runtime: the notification plugin's request was refused
   * before it reached macOS — which is why the OS never prompted and never
   * listed the app — and the updater and relaunch were dead the same way.
   *
   * Nothing fails loudly when this is wrong. The build succeeds, the app runs,
   * and the features just don't work.
   */
  it('grants its permissions to the loopback origin, not only to tauri://', () => {
    const remote = capability()['remote'] as { urls?: string[] } | undefined;
    expect(remote, 'no `remote` block: every permission is inert once the window navigates').toBeDefined();
    const urls = remote?.urls ?? [];
    expect(urls.some((u) => u.includes('127.0.0.1'))).toBe(true);
    // The server prints whichever host it bound; `localhost` and `127.0.0.1` are
    // different origins to a URL matcher, so both have to be listed.
    expect(urls.some((u) => u.includes('localhost'))).toBe(true);
  });

  it('does not pin a port, because the server falls forward when one is taken', () => {
    // 4187 is a default, not a guarantee (FR-4.x). A pinned port would work
    // until someone else held it, and then fail in the same silent way.
    const urls = ((capability()['remote'] as { urls?: string[] } | undefined)?.urls ?? []).join(' ');
    expect(urls).toMatch(/127\.0\.0\.1:\*/);
    expect(urls, 'a fixed port would break on port fallback').not.toMatch(/127\.0\.0\.1:\d+/);
  });

  it('stays scoped to loopback', () => {
    // These permissions include notifications, the updater and process relaunch.
    // Granting them to a non-loopback origin would hand real system access to
    // whatever answered — the sidecar only ever binds loopback.
    for (const u of ((capability()['remote'] as { urls?: string[] } | undefined)?.urls ?? [])) {
      expect(u, `${u} is not a loopback origin`).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)/);
    }
  });

  it('keeps the permissions the client actually calls', () => {
    const perms = capability()['permissions'] as string[];
    for (const p of [
      'core:default',
      'notification:default',
      'updater:default',
      'process:default',
      'allow-get-pending-update',
      'allow-check-for-update',
      'allow-install-update',
    ]) {
      expect(perms).toContain(p);
    }
  });

  it('generates and grants ACL permissions for every custom command (NEWS-447)', () => {
    const build = fs.readFileSync(path.join(tauriDir, 'build.rs'), 'utf8');
    const handler = fs.readFileSync(path.join(tauriDir, 'src/lib.rs'), 'utf8');
    const manifestCommands = /const COMMANDS[^=]*=\s*&\[([^\]]*)\]/.exec(build)?.[1] ?? '';
    const generated = new Set(
      [...manifestCommands.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]),
    );
    const granted = new Set(
      (capability()['permissions'] as string[])
        .filter((permission) => permission.startsWith('allow-'))
        .map((permission) => permission.slice('allow-'.length).replaceAll('-', '_')),
    );
    const commands = /tauri::generate_handler!\[([\s\S]*?)\]/
      .exec(handler)?.[1]
      .split(',')
      .map((command) => command.trim())
      .filter(Boolean) ?? [];

    expect(commands, 'invoke handler should expose updater commands').not.toHaveLength(0);
    expect(generated, 'build.rs must generate application-command permissions').toEqual(
      new Set(commands),
    );
    expect(granted, 'the loopback capability must grant every generated command').toEqual(
      new Set(commands),
    );
  });
});
