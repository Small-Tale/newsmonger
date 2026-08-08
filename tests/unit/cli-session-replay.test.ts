import { describe, expect, it } from 'vitest';

import { createCodexCliProvider, spawnRunner } from '../../src/ai/providers/codex-cli.js';
import { classifierOptions } from '../../src/categories.js';
import { readSession, replayOne } from '../helpers/cli-session.js';

/**
 * The provider, run end to end against **recorded real sessions** (NEWS-277).
 *
 * Every other test of this provider injects `config.runner`, which replaces the
 * argv construction, the schema temp file, the spawn and the parsing in one go.
 * That is why all four of those had no coverage when three of them broke:
 *
 * - `codexExecArgs` sent `--search`, a flag the CLI had removed (NEWS-272).
 * - The schema in the temp file omitted declared properties from `required`,
 *   which strict structured outputs reject (NEWS-272, second cause).
 * - `cliErrorDetail` took the last three lines of that rejection and got its
 *   closing braces (NEWS-274).
 *
 * Here the seam is one level lower — `spawnRunner(name, exec)` — so all of it
 * runs for real, against a byte-exact transcript of what `codex-cli 0.145.0`
 * actually said. Captured by `npm run record:cli-sessions`; the fixtures are
 * committed and the failures among them were produced deliberately.
 *
 * **These tests cannot notice the vendor changing.** A recording of a working
 * `--search` would have replayed success for weeks. That is the live spec's job
 * (`npm run test:e2e:real`); this file's job is that our *handling* of what the
 * vendor says stays correct, forever, offline, in CI.
 */

/** A provider whose process boundary is one recorded session. */
function providerFor(sessionName: string, config: { effort?: 'low' } = {}) {
  const session = readSession(sessionName);
  const exec = replayOne(session);
  const provider = createCodexCliProvider({
    ...config,
    runner: spawnRunner('codex', exec),
  });
  return { provider, exec, session };
}

describe('a recorded successful check, replayed through the real provider', () => {
  it('parses the transcript into stories with usable sources', async () => {
    // The whole pipeline: build argv → write the schema → "run" → read the
    // last-message file → parse → sanitize. Nothing stubbed but the process.
    const { provider } = providerFor('codex-check-success');
    const result = await provider.checkTopic('semiconductor export controls', [], null);

    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.summary.length).toBeGreaterThan(0);
    }
    // At least one real link, which is what proves the recording came from a run
    // that actually searched rather than from training data.
    expect(result.items.some((i) => i.sources.some((s) => s.url.startsWith('http')))).toBe(true);
  });

  it('sends the argv the recording was made with — including web search', async () => {
    // The fixture is *evidence* here, not just input: the real CLI accepted this
    // argv and exited 0. If `codexExecArgs` drifts from it, the pair stops
    // agreeing and this fails.
    const { provider, exec, session } = providerFor('codex-check-success');
    await provider.checkTopic('semiconductor export controls', [], null);

    const sent = exec.calls.at(-1) ?? [];
    expect(sent).toContain('tools.web_search=true');
    expect(sent, 'the flag the CLI removed must never come back').not.toContain('--search');
    // Same shape as the transcript, ignoring the per-run temp paths it replaced.
    //
    // Both separators (NEWS-430): the recording was made on macOS, so its paths
    // carry `/`, while the argv built on Windows carries `\`. Filtering on `/`
    // alone left the two live temp paths in and compared 8 arguments against 6.
    const withoutPaths = (argv: readonly string[]): string[] =>
      argv.filter((a) => !a.includes('/') && !a.includes('\\'));
    expect(withoutPaths(sent)).toEqual(withoutPaths(session.argv));
  });

  it('carries the configured effort as a config override', async () => {
    const { provider, exec } = providerFor('codex-check-effort-low', { effort: 'low' });
    await provider.checkTopic('semiconductor export controls', [], null);
    expect(exec.calls.at(-1)).toContain('model_reasoning_effort=low');
  });
});

describe('a recorded classifying check, replayed (NEWS-420)', () => {
  it('reads the category and subcategory off a real answer', async () => {
    // The gap this ticket was filed for: none of the original five fixtures
    // carried `categoryOptions`, so the classifying path — the option list the
    // prompt builds and the category `parseNewsResult` reads back — was replayed
    // by nothing at all. It is also the path NEWS-272/274 broke.
    const { provider } = providerFor('codex-check-classify');
    const result = await provider.checkTopic('semiconductor export controls', [], null, {
      categoryOptions: classifierOptions(),
    });

    expect(result.classification?.category).toBe('technology');
    expect(result.classification?.subcategory).toBe('chips-hardware');
    // Still a normal check. A classifying call that returned a label and no
    // stories would be a regression the classification assertions cannot see.
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('puts the option list in the prompt, by slug, from the live taxonomy', () => {
    // The prompt is what the recording is evidence *about* — the real CLI
    // accepted this argv and answered with a slug from the list. Rebuilding the
    // list here from `classifierOptions()` rather than hardcoding it means
    // retiring or renaming a section shows up as a failure to have re-recorded,
    // which is exactly the staleness this file otherwise cannot detect.
    const { session } = providerFor('codex-check-classify');
    const prompt = session.argv.join('\n');
    for (const option of classifierOptions()) {
      expect(prompt, `the prompt must offer ${option.slug}`).toContain(`(${option.slug})`);
    }
    expect(prompt).toContain('Classify the TOPIC ITSELF');
  });
});

describe('a recorded off-list classification, replayed (NEWS-420)', () => {
  it('carries the slug through the provider unchanged rather than throwing', async () => {
    // The third deliberate failure fixture, and the only way to get an honest
    // one: a model cannot be made to answer off-list on demand, so the recording
    // was made against a *fictional* taxonomy. What came back is a real,
    // obedient answer to that prompt and an unknown slug to this app — the
    // FR-22.8 state, reached without editing a transcript by hand.
    //
    // The provider reports what the vendor said; deciding whether a slug is real
    // is the app's job, one layer up. A provider that "helpfully" nulled an
    // unrecognised slug would hide vendor drift from the live spec.
    const { provider } = providerFor('codex-classify-unknown-slug');
    const result = await provider.checkTopic('semiconductor export controls', [], null, {
      categoryOptions: [{ slug: 'quorum', label: 'Quorum', subcategories: [] }],
    });

    expect(result.classification?.category).toBe('quorum');
    expect(classifierOptions().some((o) => o.slug === 'quorum')).toBe(false);
  });
});

describe('a recorded discovery call, replayed', () => {
  it('parses suggestions out of the other schema', async () => {
    const { provider } = providerFor('codex-suggest-success');
    const result = await provider.suggestTopics({
      scope: { kind: 'describe', query: 'cycling' },
      exclude: [],
      limit: 4,
    });
    expect(result.suggestions.length).toBeGreaterThan(0);
    for (const s of result.suggestions) expect(s.name.length).toBeGreaterThan(0);
  });
});

describe('the recorded failures, which are the ones that reached a user', () => {
  it('turns a removed-flag usage dump into something a reader can act on', async () => {
    // NEWS-272's first cause, verbatim: exit 2 and codex's usage text. The message
    // has to name the problem — the old code sliced the last three lines and
    // produced the tail of a usage block.
    const { provider } = providerFor('codex-unknown-flag');
    await expect(provider.checkTopic('anything', [], null)).rejects.toThrow(/exited with code 2/);
    await expect(provider.checkTopic('anything', [], null)).rejects.toThrow(/--search|unexpected argument|--help/);
  });

  it('surfaces the invalid_json_schema message, not the closing braces', async () => {
    // **The test that would have caught both NEWS-272's second cause and
    // NEWS-274.** The recorded stderr ends `}, "status": 400 }` — which is exactly
    // what the old positional slice showed the user, and carries no information.
    const { provider, session } = providerFor('codex-invalid-schema');

    // The fixture really does end in braces, so this asserts against the true shape
    // rather than a convenient one.
    expect(session.stderr.trim().split('\n').slice(-3).join(' ')).toMatch(/^\s*}/);

    let message = '';
    try {
      await provider.checkTopic('anything', [], null);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('invalid_json_schema');
    expect(message).toMatch(/required/);
    expect(message, 'the message must not be the punctuation of the payload').not.toMatch(/^Codex CLI exited with code 1: \s*}/);
  });
});

describe('the recordings themselves', () => {
  it('say which tool version produced them, so staleness is visible', () => {
    // A fixture with no provenance is indistinguishable from an invented one, and
    // re-recording after a CLI upgrade is a deliberate act — it needs something to
    // compare against.
    for (const name of [
      'codex-check-success',
      'codex-check-effort-low',
      'codex-suggest-success',
      'codex-check-classify',
      'codex-classify-unknown-slug',
      'codex-unknown-flag',
      'codex-invalid-schema',
    ]) {
      const session = readSession(name);
      expect(session.toolVersion, `${name} must record the tool version`).toMatch(/codex-cli \d+\.\d+/);
      expect(session.recordedAt, `${name} must record when`).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(session.describes.length, `${name} must say what it demonstrates`).toBeGreaterThan(20);
    }
  });

  it('kept the temp paths out, so they diff cleanly across machines', () => {
    const session = readSession('codex-check-success');
    expect(session.argv.some((a) => a.includes('<TMP>'))).toBe(true);
    expect(session.argv.some((a) => a.includes('/var/folders') || a.includes('/tmp/'))).toBe(false);
  });
});
