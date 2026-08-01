import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Find a CLI agent's binary without relying on `PATH` (NEWS-240).
 *
 * **A macOS app launched from Finder does not inherit your shell's `PATH`.** It
 * gets launchd's, which is `/usr/bin:/bin:/usr/sbin:/sbin` unless someone has
 * set one with `launchctl setenv` — and nobody has. `claude` and `codex` install
 * to `~/.local/bin`, Homebrew to `/opt/homebrew/bin`, neither of which is on
 * that list. So `spawn('claude')` works perfectly in a terminal and in
 * `npm run dev`, and fails with `ENOENT` in the packaged app.
 *
 * That is what shipped in v0.2.0-beta.8: the Source tab reported **"no API
 * key"** for a subscription provider that needs no key, because the probe could
 * not run the binary at all. The label was wrong, but the real damage was worse
 * — subscription checks could not run either, and subscriptions are the
 * *recommended default* way to use this app.
 *
 * Windows and Linux are less prone to it, but the same resolution runs there
 * because the failure mode is identical when it happens and the search is cheap.
 */

/**
 * Where these tools actually install, most-specific first.
 *
 * `PATH` is still consulted first, so a terminal run or an unusual install keeps
 * working. This list is the fallback for the GUI case, not a replacement.
 */
function candidateDirs(home: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
    const local = process.env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local');
    return [path.join(appData, 'npm'), path.join(local, 'Programs'), path.join(home, '.local', 'bin')];
  }
  return [
    path.join(home, '.local', 'bin'), // where the Claude Code and Codex installers put it
    path.join(home, '.claude', 'local'),
    '/opt/homebrew/bin', // Apple Silicon Homebrew
    '/usr/local/bin', // Intel Homebrew, and most manual installs
    path.join(home, 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    '/usr/bin',
  ];
}

function isExecutableFile(p: string): boolean {
  try {
    // `X_OK` rather than a stat-mode check: it accounts for ownership and ACLs,
    // and a file we cannot execute is no use to us however its bits read.
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile() || fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Executable names to try for `name`, in order. */
function variants(name: string, platform: NodeJS.Platform): string[] {
  // `.cmd` first on Windows: npm's shim is what `spawn` can actually launch,
  // since a bare extensionless script is not executable there.
  return platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];
}

/**
 * Resolve `name` to an absolute path, or return it unchanged.
 *
 * Returning the bare name when nothing is found is deliberate: `spawn` then
 * produces its usual `ENOENT`, and the caller's existing "is it installed?"
 * error is still the right message. This function's job is to remove a
 * *false* negative, not to invent a new failure.
 */
export function resolveCliBinary(
  name: string,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  // `undefined` means "use this process's PATH" (the default-parameter case);
  // `''` means "search nothing". A caller cannot express the latter by passing
  // `undefined`, which is the sort of thing that makes a test pass by reading
  // the developer's real environment — the very thing that hides this bug.
  pathEnv: string | undefined = process.env['PATH'],
): string {
  const names = variants(name, platform);
  const sep = platform === 'win32' ? ';' : ':';

  // PATH first — in a terminal, dev run, or CI it is already correct, and
  // whatever it names is what the user would get by typing the command.
  for (const dir of (pathEnv ?? '').split(sep).filter(Boolean)) {
    for (const n of names) {
      const full = path.join(dir, n);
      if (isExecutableFile(full)) return full;
    }
  }

  for (const dir of candidateDirs(home, platform)) {
    for (const n of names) {
      const full = path.join(dir, n);
      if (isExecutableFile(full)) return full;
    }
  }
  return name;
}

/** The directories searched, for a diagnostic that can say where it looked. */
export function cliSearchPath(
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  return candidateDirs(home, platform);
}
