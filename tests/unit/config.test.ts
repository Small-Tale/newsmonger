import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultDataDir, parseArgs } from '../../src/config.js';

describe('defaultDataDir', () => {
  it('prefers NEWSMONGER_DATA_DIR when set', () => {
    expect(defaultDataDir({ NEWSMONGER_DATA_DIR: '/tmp/custom' })).toBe('/tmp/custom');
  });

  it('falls back to ~/.newsmonger', () => {
    expect(defaultDataDir({})).toBe(path.join(os.homedir(), '.newsmonger'));
  });
});

describe('parseArgs', () => {
  it('returns defaults with no args', () => {
    const opts = parseArgs([], {});
    expect(opts).toEqual({
      port: null,
      dataDir: path.join(os.homedir(), '.newsmonger'),
      open: true,
      strictPort: false,
      aiTest: false,
      demo: false,
      provider: null,
      model: null,
      endpoint: null,
    });
  });

  it('parses all flags', () => {
    const opts = parseArgs(
      ['--port', '5000', '--data-dir', '/tmp/x', '--no-open', '--strict-port', '--ai-test', '--provider', 'openai', '--model', 'gpt-x', '--endpoint', 'http://h:1234/v1'],
      {},
    );
    expect(opts.port).toBe(5000);
    expect(opts.dataDir).toBe(path.resolve('/tmp/x'));
    expect(opts.open).toBe(false);
    expect(opts.strictPort).toBe(true);
    expect(opts.aiTest).toBe(true);
    expect(opts.provider).toBe('openai');
    expect(opts.model).toBe('gpt-x');
    expect(opts.endpoint).toBe('http://h:1234/v1');
  });

  it('reads provider/model/endpoint from env, with flags overriding', () => {
    const env = { NEWSMONGER_PROVIDER: 'anthropic', NEWSMONGER_MODEL: 'claude-x', NEWSMONGER_ENDPOINT: 'http://e' };
    expect(parseArgs([], env).provider).toBe('anthropic');
    expect(parseArgs([], env).model).toBe('claude-x');
    expect(parseArgs(['--provider', 'mock'], env).provider).toBe('mock');
  });

  it('rejects an invalid provider name', () => {
    expect(() => parseArgs(['--provider', 'grok'], {})).toThrow(/--provider must be one of/);
    expect(() => parseArgs([], { NEWSMONGER_PROVIDER: 'grok' })).toThrow(/--provider must be one of/);
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

describe('--demo (NEWS-212)', () => {
  it('implies --ai-test', () => {
    // Both mean "make no real AI call", and every `aiTest` guard downstream
    // (image fetching, link probing, key verification) should apply to a demo
    // capture too. Implying it here beats pairing a second condition with each.
    const opts = parseArgs(['--demo'], {});
    expect(opts.demo).toBe(true);
    expect(opts.aiTest).toBe(true);
  });

  it('is off unless asked for, and --ai-test alone does not enable it', () => {
    expect(parseArgs([], {}).demo).toBe(false);
    expect(parseArgs(['--ai-test'], {}).demo).toBe(false);
    expect(parseArgs(['--ai-test'], {}).aiTest).toBe(true);
  });
});
