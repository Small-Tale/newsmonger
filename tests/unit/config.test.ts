import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultDataDir, parseArgs } from '../../src/config.js';

describe('defaultDataDir', () => {
  it('prefers NEWS_DATA_DIR when set', () => {
    expect(defaultDataDir({ NEWS_DATA_DIR: '/tmp/custom' })).toBe('/tmp/custom');
  });

  it('falls back to ~/.news', () => {
    expect(defaultDataDir({})).toBe(path.join(os.homedir(), '.news'));
  });
});

describe('parseArgs', () => {
  it('returns defaults with no args', () => {
    const opts = parseArgs([], {});
    expect(opts).toEqual({
      port: null,
      dataDir: path.join(os.homedir(), '.news'),
      open: true,
      strictPort: false,
      aiTest: false,
    });
  });

  it('parses all flags', () => {
    const opts = parseArgs(['--port', '5000', '--data-dir', '/tmp/x', '--no-open', '--strict-port', '--ai-test'], {});
    expect(opts.port).toBe(5000);
    expect(opts.dataDir).toBe(path.resolve('/tmp/x'));
    expect(opts.open).toBe(false);
    expect(opts.strictPort).toBe(true);
    expect(opts.aiTest).toBe(true);
  });

  it('rejects bad ports', () => {
    expect(() => parseArgs(['--port', 'abc'], {})).toThrow(/--port/);
    expect(() => parseArgs(['--port'], {})).toThrow(/--port/);
    expect(() => parseArgs(['--port', '0'], {})).toThrow(/--port/);
    expect(() => parseArgs(['--port', '70000'], {})).toThrow(/--port/);
  });

  it('rejects missing --data-dir value and unknown flags', () => {
    expect(() => parseArgs(['--data-dir'], {})).toThrow(/--data-dir/);
    expect(() => parseArgs(['--bogus'], {})).toThrow(/unknown argument/);
  });
});
