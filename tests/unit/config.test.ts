import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROVIDER_NAMES } from '../../src/ai/types.js';
import { defaultDataDir, earlyExitFlag, HELP_TEXT, parseArgs, USAGE_LINE } from '../../src/config.js';

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
      effort: null,
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

describe('--help and --version (NEWS-216)', () => {
  it('recognizes both spellings of each', () => {
    for (const arg of ['--help', '-h']) expect(earlyExitFlag([arg])).toBe('help');
    for (const arg of ['--version', '-v']) expect(earlyExitFlag([arg])).toBe('version');
    expect(earlyExitFlag([])).toBe(null);
    expect(earlyExitFlag(['--ai-test', '--no-open'])).toBe(null);
  });

  it('answers them even next to arguments that would fail to parse', () => {
    // The point of the early scan: someone typing `--help` is asking what the
    // valid flags *are*, so replying "unknown argument" would be backwards. It
    // has to work before `parseArgs` runs, not inside it.
    expect(earlyExitFlag(['--bogus', '--help'])).toBe('help');
    expect(earlyExitFlag(['--port', 'not-a-port', '--version'])).toBe('version');
    expect(() => parseArgs(['--bogus', '--help'], {})).toThrow(/unknown argument/);
  });

  it('takes the first of the two when both are given', () => {
    expect(earlyExitFlag(['--help', '--version'])).toBe('help');
    expect(earlyExitFlag(['--version', '--help'])).toBe('version');
  });

  it('does not mistake a flag value for a request', () => {
    // `--model -v` is a silly model id, but it is a *value*, and treating it as
    // a version request would print 0.2.0 and never start the server.
    expect(earlyExitFlag(['--model', '-v'])).toBe(null);
    expect(earlyExitFlag(['--data-dir', '--help'])).toBe(null);
    expect(earlyExitFlag(['--model', '-v', '--help'])).toBe('help');
  });

  it('keeps the help text and the usage line honest about the providers', () => {
    // Both are built from PROVIDER_NAMES (NEWS-204) — the hardcoded list had
    // drifted twice, advertising a provider that did not exist and omitting two
    // that did.
    for (const text of [USAGE_LINE, HELP_TEXT]) {
      for (const name of PROVIDER_NAMES) expect(text, `omits ${name}`).toContain(name);
      expect(text, 'ollama is not a provider').not.toContain('ollama');
    }
    expect(HELP_TEXT).toContain('--help');
    expect(HELP_TEXT).toContain('--version');
  });

  it('documents every flag parseArgs accepts', () => {
    // A flag that exists but is undocumented is one nobody finds; the help text
    // is the only place a user can look.
    const accepted: string[][] = [
      ['--port', '5000'],
      ['--data-dir', '/tmp/x'],
      ['--provider', 'openai'],
      ['--model', 'gpt-x'],
      ['--endpoint', 'http://h:1234/v1'],
      ['--no-open'],
      ['--strict-port'],
      ['--ai-test'],
      ['--demo'],
      ['--effort', 'high'],
    ];
    for (const args of accepted) {
      const flag = args[0] ?? '';
      expect(HELP_TEXT, `${flag} is missing from --help`).toContain(flag);
      expect(() => parseArgs(args, {}), `${flag} should parse`).not.toThrow();
    }
  });
});

describe('--effort (NEWS-189)', () => {
  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('accepts %o', (level) => {
    expect(parseArgs(['--effort', level], {}).effort).toBe(level);
  });

  it('rejects a level the API would reject, naming the valid ones', () => {
    // A bad level is worth catching here rather than as a 400 mid-check.
    expect(() => parseArgs(['--effort', 'extreme'], {})).toThrow(/--effort must be one of/);
    expect(() => parseArgs(['--effort'], {})).toThrow(/--effort requires a value/);
  });

  it('is null unless asked for, so settings are left alone', () => {
    expect(parseArgs([], {}).effort).toBe(null);
  });

  it('reads NEWSMONGER_EFFORT, and validates it the same way', () => {
    expect(parseArgs([], { NEWSMONGER_EFFORT: 'high' }).effort).toBe('high');
    expect(parseArgs([], { NEWSMONGER_EFFORT: '' }).effort).toBe(null);
    expect(() => parseArgs([], { NEWSMONGER_EFFORT: 'nope' })).toThrow(/--effort must be one of/);
  });

  it('takes a value, so --effort -v is a level and not a version request', () => {
    // The NEWS-216 scan has to know this flag consumes its argument.
    expect(earlyExitFlag(['--effort', '-v'])).toBe(null);
  });
});
