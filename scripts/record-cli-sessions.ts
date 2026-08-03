/**
 * Capture real Claude/Codex CLI sessions as replayable fixtures (NEWS-277).
 *
 *   npm run record:cli-sessions            # every scenario whose CLI is signed in
 *   npm run record:cli-sessions -- --only codex-check-success
 *
 * **Why record rather than write a mock.** The two bugs that reached a user were
 * both about the *shape* of what the vendor says: a flag it no longer accepts, and
 * a schema it rejects with a pretty-printed JSON error whose informative line is
 * four lines from the end. A hand-written fixture gets those shapes wrong in
 * exactly the way that hides the bug — the first attempt at NEWS-274's fixture did
 * (`}, "status": 400 }` renders differently once Markdown eats the whitespace).
 * A transcript cannot be wrong about what the tool said.
 *
 * **What this cannot buy.** Currency. A recording of a working `--search` would
 * have replayed success for weeks after the flag was removed. Re-record after a CLI
 * upgrade, and treat the fixture diff as the vendor's changelog; the live spec
 * (`npm run test:e2e:real`) is the thing that notices drift on its own.
 *
 * Runs outside the sandbox — it spawns the real tools and they reach the network.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildUserPrompt, NEWS_JSON_SCHEMA, searchingSystemPrompt } from '../src/ai/prompt.js';
import { codexExecArgs, combinePrompt, hasChatGptCredentials } from '../src/ai/providers/codex-cli.js';
import { buildSuggestPrompt, SUGGEST_JSON_SCHEMA, suggestSystemPrompt } from '../src/ai/suggest-prompt.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'tests/fixtures/cli-sessions');

/** A scenario: what to run, and what it is meant to demonstrate. */
interface Scenario {
  name: string;
  tool: 'claude' | 'codex';
  describes: string;
  /** Built fresh per run, because the argv carries per-run temp paths. */
  argv: (files: { schemaFile: string; outFile: string }) => string[];
  /** After the run, the last-message file if the tool writes one. */
  readsOutputFile?: boolean;
}

const TOPIC = 'semiconductor export controls';

const SCENARIOS: Scenario[] = [
  {
    name: 'codex-check-success',
    tool: 'codex',
    describes: 'A successful news check: web search on, strict output schema, effort unset.',
    argv: ({ schemaFile, outFile }) =>
      codexExecArgs({
        schemaFile,
        outFile,
        model: undefined,
        effort: undefined,
        prompt: combinePrompt(searchingSystemPrompt(), buildUserPrompt(TOPIC, [], null)),
      }),
    readsOutputFile: true,
  },
  {
    name: 'codex-check-effort-low',
    tool: 'codex',
    describes: 'The same check at effort=low, so the config override is in the transcript.',
    argv: ({ schemaFile, outFile }) =>
      codexExecArgs({
        schemaFile,
        outFile,
        model: undefined,
        effort: 'low',
        prompt: combinePrompt(searchingSystemPrompt(), buildUserPrompt(TOPIC, [], null)),
      }),
    readsOutputFile: true,
  },
  {
    name: 'codex-suggest-success',
    tool: 'codex',
    describes: 'A successful topic-discovery call, which uses the other JSON schema.',
    argv: ({ schemaFile, outFile }) =>
      codexExecArgs({
        schemaFile,
        outFile,
        model: undefined,
        effort: undefined,
        prompt: combinePrompt(suggestSystemPrompt(), buildSuggestPrompt({ scope: { kind: 'describe', query: 'cycling' }, exclude: [], limit: 4 })),
      }),
    readsOutputFile: true,
  },
  {
    name: 'codex-unknown-flag',
    tool: 'codex',
    describes:
      'The NEWS-272 failure verbatim: a flag the CLI no longer accepts, answered with exit 2 and a usage dump.',
    // `--search` on purpose — this is the removed flag, and its usage dump is what
    // `cliErrorDetail` has to turn into a sentence.
    argv: () => ['exec', '--search', '--skip-git-repo-check', '-s', 'read-only', 'say ok'],
  },
  {
    name: 'codex-invalid-schema',
    tool: 'codex',
    describes:
      "NEWS-272's second cause: a schema whose `required` omits a declared property, rejected with a pretty-printed 400.",
    // Deliberately the *old*, broken schema shape, so the transcript carries the
    // real `invalid_json_schema` payload rather than an imagined one.
    argv: ({ schemaFile, outFile }) =>
      codexExecArgs({ schemaFile, outFile, model: undefined, effort: undefined, prompt: 'Reply with {"items":[]}' }),
    readsOutputFile: false,
  },
];

/** The broken schema for the `codex-invalid-schema` scenario, restored on purpose. */
const SCHEMA_MISSING_REQUIRED = JSON.parse(JSON.stringify(NEWS_JSON_SCHEMA)) as {
  properties: { items: { items: { properties: { sources: { items: { required: string[] } } } } } };
  required: string[];
};
SCHEMA_MISSING_REQUIRED.properties.items.items.properties.sources.items.required = ['title', 'url'];
SCHEMA_MISSING_REQUIRED.required = ['items'];

function record(scenario: Scenario): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsmonger-record-'));
  const schemaFile = path.join(dir, 'schema.json');
  const outFile = path.join(dir, 'last-message.txt');
  const schema = scenario.name === 'codex-invalid-schema' ? SCHEMA_MISSING_REQUIRED : NEWS_JSON_SCHEMA;
  const useSuggest = scenario.name.includes('suggest');
  fs.writeFileSync(schemaFile, JSON.stringify(useSuggest ? SUGGEST_JSON_SCHEMA : schema));

  const argv = scenario.argv({ schemaFile, outFile });
  process.stdout.write(`[record] ${scenario.name} … `);
  const started = Date.now();
  const res = spawnSync(scenario.tool, argv, { encoding: 'utf8', timeout: 11 * 60 * 1000 });
  const version = spawnSync(scenario.tool, ['--version'], { encoding: 'utf8' }).stdout.trim();

  // Codex returns its answer in the `--output-last-message` file, not on stdout, so
  // the transcript has to carry it too — the replay helper writes it to whatever
  // path that run picked, which is exactly what the real tool does. Capturing only
  // stdout would replay a success the provider then reports as "returned no
  // result", correctly, from an empty file.
  const lastMessage = scenario.readsOutputFile === true && fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, `${scenario.name}.json`),
    `${JSON.stringify(
      {
        name: scenario.name,
        tool: scenario.tool,
        describes: scenario.describes,
        // Temp paths replaced, so the fixture is diffable across machines and runs.
        argv: argv.map((a) => a.replace(dir, '<TMP>')),
        code: res.status,
        stdout: res.stdout,
        stderr: res.stderr,
        lastMessage,
        recordedAt: new Date().toISOString(),
        toolVersion: version,
      },
      null,
      2,
    )}\n`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
  process.stdout.write(`exit ${String(res.status)} in ${String(Math.round((Date.now() - started) / 1000))}s\n`);
}

const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];

if (!hasChatGptCredentials()) {
  console.error('codex is not signed in with a ChatGPT subscription — nothing to record.');
  process.exit(1);
}

for (const scenario of SCENARIOS) {
  if (only !== null && scenario.name !== only) continue;
  record(scenario);
}
console.log(`\n✓ recordings in ${path.relative(ROOT, OUT_DIR)}`);
