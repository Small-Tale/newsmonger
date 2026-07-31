import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The app's own version, for diagnostics (NEWS-88) and `--version` (NEWS-216).
 *
 * Read from the nearest `package.json` and cached. Returns '' rather than
 * throwing when it can't be found — a diagnostics bundle that says "version
 * unknown" is far better than one that fails to render.
 *
 * The walk starts at this module and goes up, so it finds `package.json` both
 * from `src/` under tsx and from `dist/cli.js` in an installed package, where
 * it sits one level up in `node_modules/newsmonger/`.
 */
let cachedVersion: string | undefined;
export function appVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  cachedVersion = '';
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof parsed.version === 'string') {
          cachedVersion = parsed.version;
        }
      } catch {
        // unreadable or not JSON — leave it as ''
      }
      break;
    }
    dir = path.dirname(dir);
  }
  return cachedVersion;
}
