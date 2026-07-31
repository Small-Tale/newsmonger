import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ClaudeCliRunner } from '../../src/ai/providers/claude-cli.js';
import { createClaudeCliProvider, parseCliEnvelope } from '../../src/ai/providers/claude-cli.js';

const NEWS = JSON.stringify({
  items: [
    {
      title: 'Fusion milestone',
      summary: 'A thing happened.',
      sources: [{ title: 'Example', url: 'https://example.test/a' }],
    },
  ],
});

/** A runner that never spawns anything — the CLI is not exercised in tests. */
function fakeRunner(over: Partial<ClaudeCliRunner> = {}): ClaudeCliRunner {
  return {
    run: () => Promise.resolve(NEWS),
    available: () => Promise.resolve(true),
    ...over,
  };
}

describe('parseCliEnvelope', () => {
  it('prefers structured_output over re-parsing the prose result', () => {
    // `--json-schema` makes the CLI emit a validated object, so nothing has to
    // fish JSON back out of free text.
    const envelope = JSON.stringify({
      is_error: false,
      result: 'some prose the model also wrote',
      structured_output: { items: [] },
    });
    expect(parseCliEnvelope(envelope)).toBe('{"items":[]}');
  });

  it('falls back to result when there is no structured output', () => {
    const envelope = JSON.stringify({ is_error: false, result: '```json\n{"items":[]}\n```' });
    expect(parseCliEnvelope(envelope)).toContain('"items"');
  });

  it('throws when the CLI reports an error, naming the subtype', () => {
    const envelope = JSON.stringify({ is_error: true, subtype: 'rate_limit', result: '' });
    expect(() => parseCliEnvelope(envelope)).toThrow(/rate_limit/);
  });

  it('throws on output that is not JSON at all', () => {
    // e.g. a login prompt or a stack trace on stdout.
    expect(() => parseCliEnvelope('Please run `claude login`')).toThrow(/not JSON/);
  });

  it('throws when the envelope carries no usable result', () => {
    expect(() => parseCliEnvelope(JSON.stringify({ is_error: false }))).toThrow(/no result/);
  });

  it('treats a null structured_output as absent', () => {
    const envelope = JSON.stringify({ is_error: false, structured_output: null, result: '{"items":[]}' });
    expect(parseCliEnvelope(envelope)).toBe('{"items":[]}');
  });
});

describe('createClaudeCliProvider', () => {
  it('is an attended provider — it spends subscription quota', () => {
    // This is what subjects it to the foreground gate in src/attendance.ts.
    expect(createClaudeCliProvider({ runner: fakeRunner() }).attended).toBe(true);
  });

  it('identifies as claude-cli', () => {
    expect(createClaudeCliProvider({ runner: fakeRunner() }).name).toBe('claude-cli');
  });

  it('reports the default model when none is configured', () => {
    expect(createClaudeCliProvider({ runner: fakeRunner() }).model).toBe('claude-code default');
    expect(createClaudeCliProvider({ runner: fakeRunner(), model: 'opus' }).model).toBe('opus');
  });

  it('parses stories out of a successful run', async () => {
    const p = createClaudeCliProvider({ runner: fakeRunner() });
    const result = await p.checkTopic('fusion energy', [], null);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe('Fusion milestone');
  });

  it('passes the shared system and user prompts through', async () => {
    // The CLI provider must not invent its own prompt — dedup and the window
    // wording live in the shared builders.
    const seen: { system: string; prompt: string; model: string | undefined }[] = [];
    const p = createClaudeCliProvider({
      runner: fakeRunner({
        run: (system, prompt, model) => {
          seen.push({ system, prompt, model });
          return Promise.resolve(NEWS);
        },
      }),
    });

    await p.checkTopic('fusion energy', [{ title: 'Old story', foundAt: '2026-07-20T00:00:00.000Z' }], null);

    expect(seen[0]?.system).toMatch(/news research assistant/);
    expect(seen[0]?.prompt).toContain('Topic: fusion energy');
    expect(seen[0]?.prompt).toContain('Old story'); // dedup list is included
    expect(seen[0]?.model).toBeUndefined(); // no --model unless configured
  });

  it('forwards a configured model', async () => {
    const seen: (string | undefined)[] = [];
    const p = createClaudeCliProvider({
      model: 'claude-opus-4-8',
      runner: fakeRunner({
        run: (_s, _p, model) => {
          seen.push(model);
          return Promise.resolve(NEWS);
        },
      }),
    });
    await p.checkTopic('t', [], null);
    expect(seen[0]).toBe('claude-opus-4-8');
  });

  it('surfaces a runner failure rather than swallowing it', async () => {
    const p = createClaudeCliProvider({
      runner: fakeRunner({ run: () => Promise.reject(new Error('Claude CLI exited with code 1: not logged in')) }),
    });
    await expect(p.checkTopic('t', [], null)).rejects.toThrow(/not logged in/);
  });

  it('reports availability from the runner', async () => {
    expect(await createClaudeCliProvider({ runner: fakeRunner() }).isAvailable()).toBe(true);
    expect(
      await createClaudeCliProvider({ runner: fakeRunner({ available: () => Promise.resolve(false) }) }).isAvailable(),
    ).toBe(false);
  });

  it('sanitizes model output like every other provider', async () => {
    // The shared parseNewsResult strips citation markup (NEWS-25), so this
    // provider inherits it rather than reimplementing anything.
    const withCite = JSON.stringify({
      items: [
        {
          title: 'Headline',
          summary: 'Body. <cite index="1">Cited bit.</cite>',
          sources: [{ title: 'Example', url: 'https://example.test/a' }],
        },
      ],
    });
    const p = createClaudeCliProvider({ runner: fakeRunner({ run: () => Promise.resolve(withCite) }) });
    const result = await p.checkTopic('t', [], null);
    expect(result.items[0]?.summary).toBe('Body. Cited bit.');
  });
});

describe('spawned CLI agents get a neutral working directory (NEWS-219)', () => {
  it('is a real directory, and not one macOS protects', async () => {
    const { agentCwd } = await import('../../src/ai/providers/agent-cwd.js');
    const dir = agentCwd();
    expect(fs.existsSync(dir), 'the cwd must exist or spawn fails with ENOENT').toBe(true);
    expect(fs.statSync(dir).isDirectory()).toBe(true);

    // The bug: `claude` and `codex` read whatever directory they start in, and
    // macOS attributes that read to the responsible app — so the user got
    // "Newsmonger would like to access files in your Documents folder". Three
    // grants were recorded against com.smalltale.newsmonger before this was found.
    const home = os.homedir();
    for (const protectedDir of ['Documents', 'Downloads', 'Desktop', 'Music', 'Pictures', 'Movies']) {
      expect(dir, `must not start an agent in ~/${protectedDir}`).not.toContain(path.join(home, protectedDir));
    }
    // Nor the repo itself, which is what `tauri dev` used to inherit.
    expect(dir).not.toContain(process.cwd());
  });

  it('is stable across calls, so agents do not scatter directories', async () => {
    const { agentCwd } = await import('../../src/ai/providers/agent-cwd.js');
    expect(agentCwd()).toBe(agentCwd());
  });

  it('is passed to spawn rather than left inherited, in both CLI providers', () => {
    // The seam these tests inject means the real `spawn` options are never
    // exercised here — so the one line that actually fixes the bug is asserted
    // directly. Dropping `cwd` would restore the inherited directory and nothing
    // else would notice.
    for (const rel of ['src/ai/providers/claude-cli.ts', 'src/ai/providers/codex-cli.ts']) {
      const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
      expect(src, `${rel} should spawn with an explicit cwd`).toContain('cwd: agentCwd()');
    }
  });
});
