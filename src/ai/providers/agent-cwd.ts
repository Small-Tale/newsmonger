import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A neutral working directory for a spawned CLI agent (NEWS-219).
 *
 * `claude` and `codex` are general-purpose coding agents: started in a
 * directory, they read it. Newsmonger passes the entire prompt explicitly and
 * wants no project context at all, so the directory they start in should hold
 * nothing of the user's.
 *
 * It previously held whatever the server inherited — the repo root under
 * `tauri dev`, or the launcher's directory in a release build. On macOS that is
 * not merely untidy: **TCC attributes a child process's file access to the
 * responsible application**, so a CLI agent reading its cwd makes the OS ask the
 * user whether *Newsmonger* may read their Documents folder. The user sees an
 * app that tracks news asking for their documents, which is both alarming and
 * fair enough. Three such grants were recorded against `com.smalltale.newsmonger`
 * before this was found: Documents, Downloads and MediaLibrary.
 *
 * A subdirectory of the temp dir rather than the temp dir itself, so anything an
 * agent leaves behind is identifiable and confined. Never `~/Documents`,
 * `~/Downloads`, `~/Desktop` or any other directory macOS protects — the whole
 * point is that this one is boring.
 */
let cached: string | undefined;
export function agentCwd(): string {
  if (cached !== undefined) return cached;
  const dir = path.join(os.tmpdir(), 'newsmonger-agent-cwd');
  try {
    fs.mkdirSync(dir, { recursive: true });
    cached = dir;
  } catch {
    // Falling back to the temp dir keeps the property that matters — it is not a
    // directory the user keeps anything in — even if the subdirectory can't be
    // made. Returning undefined would silently restore the inherited cwd, which
    // is the bug.
    cached = os.tmpdir();
  }
  return cached;
}
