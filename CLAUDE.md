# News

Topic-based news tracker. The user enters topics; on a configurable interval (default 1 day) the app asks Claude — with web search — for genuinely new news per topic, deduplicates against previously reported stories, and shows summaries with source links in a feed.

## Tech Stack

- Node 20+, TypeScript (strict), ESM
- [kerfjs](https://github.com/brianwestphal/kerf) 2.0 UI (JSX → HTML strings, signals + morph) — **read `.claude/skills/kerf-app/SKILL.md` before touching client code**
- Hono + `@hono/node-server` (localhost-only, default port 4187)
- Pluggable AI providers (`src/ai/providers/`, like `~/Documents/gitgist`) behind a `NewsProvider` interface with a `searchesWeb` capability; default `anthropic` uses `@anthropic-ai/sdk` (`claude-opus-4-8`, adaptive thinking, `web_search_20260209`, streamed). See `docs/6-providers.md`.
- Single zod-validated JSON file for storage (`~/.news/data.json`; `--data-dir` / `NEWS_DATA_DIR` override)
- Tauri v2 desktop shell (Node-sidecar architecture like glassbox; dev-mode only so far)
- esbuild + sass for client assets; tsup for the server bundle; eslint flat config with `strictTypeChecked` + `eslint-plugin-kerfjs`

## Architecture

`src/cli.ts` parses flags → constructs `Store` (JSON file), a `NewsService` (`ClaudeNewsService`, or `MockNewsService` with `--ai-test`), and a `CheckRunner` → starts the Hono server (`src/server.ts`, DI via middleware) and the minute-tick scheduler (`src/scheduler.ts`). The client (`src/client/app.tsx`) is a kerf app polling `/api/state` every 4 s.

**Start every fresh session by reading `docs/ai/code-summary.md` and `docs/ai/requirements-summary.md`.** Requirements docs are numbered `docs/N-topic.md` (1–5).

## Conventions

- **Type safety: validate, don't assert.** zod at every trust boundary (API request bodies, client-side state parsing, the data file, Claude's JSON output). No bare `as` casts to cross boundaries.
- **kerf client rules** (enforced by `eslint-plugin-kerfjs`, documented in `docs/3-ui.md`): state in `defineStore`/signals; events via `delegate()` with `data-*` attributes (never `addEventListener`/inline handlers); `data-key` on list rows; `.map()` not `each()` for static structural arrays. Plus two hard-won structural rules (see `docs/3-ui.md`; kerf bug KF-377): wrap conditional siblings (banners) in an always-present container — removing a conditional sibling before a keyed `each()` list permanently empties it in kerfjs 2.0.0 — and keep `each()` containers structurally stable (defensive).
- The server readiness line `news running at <url>` is watched by `src-tauri/src/lib.rs` — keep the `running at ` marker in sync.
- Tests must never touch `~/.news` — use `tests/helpers/tmp.ts` (unit) or the Playwright-managed temp dir (E2E).
- The mock news service keys off topic names: containing "fail" → throws, "empty" → no items; anything else → the same two deterministic stories every call (that's what makes dedup testable).

<!-- hotsheet:begin section=ticket-driven-work v=1 -->
## Ticket-Driven Work

When the user gives you work directly (not via the Hot Sheet channel or events), create Hot Sheet tickets before starting implementation — especially for substantial or multi-step work.

- **Do create tickets** for: features, bug fixes, refactoring, multi-step tasks, anything changing code. **Don't** for: simple questions, git commits, quick lookups, trivial one-liners. **When in doubt, create them.**
- Create via the Hot Sheet API (prefer the `hotsheet_*` MCP tools), mark Up Next, then work through them: set status `started` → implement → set `completed` with notes.
- **Always create follow-up tickets** for incomplete work (unfinished steps, open design questions, known gaps, designed-but-unbuilt features). If it's not in a ticket, it's forgotten.
- **Incomplete-work checklist** — before marking a ticket `completed`, file follow-ups for any: (1) UI placeholder text ("coming soon"), (2) TODO/FIXME comments, (3) documented-but-unimplemented requirements, (4) empty/stub functions returning mock data.
- **Use FEEDBACK NEEDED before deferring or asking about follow-ups.** When about to (a) defer a ticket needing more work, (b) ask whether to file follow-ups, or (c) close with a question buried in notes — DON'T. Leave the ticket `started`, add a `FEEDBACK NEEDED:` note (per `.hotsheet/worklist.md`), signal channel done, and wait. It's the only reliable way to surface a question.
<!-- hotsheet:end section=ticket-driven-work -->

<!-- hotsheet:begin section=testing-philosophy v=2 -->
## Testing Philosophy

- **Double coverage**: every feature covered by both unit tests AND E2E tests. Unit = logic in isolation; E2E = real user flows through the running app with minimal mocking.
- **Unit tests**: Mock external deps (filesystem, network), test real logic.
- **E2E tests**: As much as possible, use test automation tools to run realistic, user-facing flows. Minimize mocks.
- **Coverage**: Merge all test coverage (e.g. unit, E2E server, E2E browser) into one report. Low-coverage files should get more of both test types. Aim for 100% coverage of code lines, 100% coverage of branches, and 100% of features described in the requirements documentation.
- **Coverage is a floor, not a ceiling**: 100% line/branch coverage shows every line *ran*, not that every *behavior* — or every *sequence* of behaviors — is *asserted*. It is structurally blind to a **missing state transition**: a bug living in an untested interaction sails through a green 100% report because the individual lines still get hit by isolated, single-operation tests.
- **Transition-matrix testing for stateful modules**: for anything with modes / multiple code paths / a cache / a state machine, enumerate the states AND the transitions between them, then write tests that walk realistic multi-step sequences crossing state boundaries — not just each operation from a clean initial state.
- **Adversarial pass on stateful changes**: when adding or altering a stateful code path, deliberately try to break it with out-of-order / interleaved / repeated / empty-then-refill sequences; pin any that would have failed as permanent regression tests.
- **Manual test plan**: keep a manual test plan doc (e.g. `docs/manual-test-plan.md`) for features that can't be reliably automated. **Keep it up to date** — add such features there; when you add automated coverage for a previously-manual item, remove it and note it in an "Automated Coverage Summary".
- **Always fix lint and type errors before finishing**: Fix as you go, don't batch.

<!-- hotsheet:begin specifics=testing-philosophy v=1 -->
### This project's test setup

- **Unit tests** (`tests/unit/**/*.test.ts`, helpers in `tests/helpers/`): vitest, `globals: true`, v8 coverage over `src/**`. Always use `tests/helpers/tmp.ts` for data dirs — never write to `~/.news`. API tests go through `createApp(...)` + `app.request(...)` (no real server). The news service is mocked via `MockNewsService` or an inline `NewsService`.
- **E2E tests** (`tests/e2e/**/*.spec.ts`): Playwright, serial (`workers: 1`), one shared server started by `playwright.config.ts` on port 4189 with `--ai-test` and a pid-scoped temp data dir. Tests build on each other's state (documented at the top of the spec).
- **Commands**: unit `npm test` · E2E `npm run test:e2e` · everything `npm run test:all` (typecheck + lint + unit + E2E). Coverage report lands in `coverage/` (unit only for now — merged unit+E2E coverage is a known gap, see follow-up ticket).
- The real Claude request path and the Tauri shell are covered by `docs/manual-test-plan.md`.
<!-- hotsheet:end specifics=testing-philosophy -->
<!-- hotsheet:end section=testing-philosophy -->

<!-- hotsheet:begin section=requirements-documentation v=1 -->
## Requirements Documentation

Keep human-readable requirements documents as the source of truth for what the project does, and **keep them up to date in the same change as the code** (add/remove/modify a requirement → update its doc). Create new docs for major new functional areas. Cross-reference related docs with relative links.

### AI Summaries

Maintain two synthesis docs an AI assistant reads at the start of a fresh session — keep them in sync with reality (source doc/code wins on conflict), and prefer small targeted edits over rewrites:

- A **codebase map** — directory tree, entry points, data schema, build, tests, settings, and a "where do I look for X" index. Update it in the same change when you add a file or directory, add a route/endpoint, change the schema, add a client module, or add a setting key.
- A **requirements summary** — a synthesized view of every requirements doc with status markers (e.g. Shipped / Partial / Design only / Deferred). Update it in the same change when you add a requirements doc, ship a design-only feature, or defer/regress a shipped one.

<!-- hotsheet:begin specifics=requirements-documentation v=1 -->
### This project's docs layout

- Requirements docs: numbered `docs/N-topic.md` (currently 1–5), FR-N.M requirement ids, cross-referenced with relative links. New functional area → next number.
- Codebase map: `docs/ai/code-summary.md` · Requirements summary (with status markers): `docs/ai/requirements-summary.md` — update both in the same change as the code they describe.
- Manual test plan: `docs/manual-test-plan.md`.
<!-- hotsheet:end specifics=requirements-documentation -->
<!-- hotsheet:end section=requirements-documentation -->
