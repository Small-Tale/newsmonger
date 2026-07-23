import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach } from 'vitest';

const created: string[] = [];

/** Create a temporary data directory, cleaned up after each test. */
export function tmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-test-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});
