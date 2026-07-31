# Contributing

Everything for working *on* Newsmonger. The [README](README.md) is deliberately
for people **using** it, so the development material lives here instead.

## From source

```sh
git clone https://github.com/Small-Tale/newsmonger.git && cd newsmonger
npm install
npm run dev
```

Needs **Node 22.5+** — the server stores its data through the built-in
`node:sqlite`, which is not available earlier.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Build client assets and run the server from source |
| `npm test` | Unit tests (vitest, with coverage) |
| `npm run test:e2e` | Browser E2E tests (Playwright, mock AI) |
| `npm run test:all` | Everything: typecheck + lint + Rust + unit + E2E |
| `npm run gates:rust` | Just the Rust gates (fmt, both clippy profiles, tests) |
| `npm run build` | Bundle the server CLI to `dist/` |
| `npm run tauri:dev` | Desktop app in dev mode (needs Rust) |
| `npm run tauri:build:local` | Local production desktop build (`--sign`, `--release`) |
| `npm run demo:capture` | Regenerate the README hero (`assets/demo.svg`) from the live app |
| `npm run release` / `release:beta` | Cut a release (see `docs/5-desktop-app.md`) |

`npm run test:all` is the gate to run before committing — it includes the Rust
checks, which is the point: they were once missing from it, and a `cargo fmt`
violation reached `main` as a result.

## Running without an AI provider

`--ai-test` swaps in a deterministic mock, which is what the test suites use — no
API key, no network, and the same two stories every call, which is what makes
deduplication assertable.

`--demo` uses a separate fixture provider with realistic-looking stories, for
capturing the README hero. See `src/demo.ts` for why the two are not the same
thing.

## Docs

- **Requirements** live in numbered `docs/N-topic.md` files and are the source of
  truth for what the project does. Keep them updated in the *same change* as the
  code.
- **`docs/ai/code-summary.md`** — codebase map, including a "where do I look for
  X" index.
- **`docs/ai/requirements-summary.md`** — every requirement with a status marker.
- **`docs/manual-test-plan.md`** — what can't be automated, and why.

Read the two `docs/ai/` summaries first; they are maintained for exactly that.

## Conventions

The short version, with the full reasoning in `CLAUDE.md` and `docs/3-ui.md`:

- **Validate, don't assert.** zod at every trust boundary — API bodies, the
  database, the client's view of state, anything a model produced. No bare `as`
  casts to cross a boundary.
- **kerf client rules** are enforced by `eslint-plugin-kerfjs`: state in
  `defineStore`/signals, events via `delegate()` with `data-*` attributes,
  `data-key` on list rows.
- **Conditional siblings go inside an always-present container.** The E2E suite
  runs with `invariants: 'throw'`, so getting this wrong fails the render — and
  the symptom is the whole surrounding region going blank, not one missing node.
- **Double coverage**: unit tests for logic in isolation, E2E for real flows.
  For anything stateful, test *sequences* of operations rather than each one from
  a clean start — 100% line coverage is structurally blind to a missing state
  transition.
- **Never commit red.** If the gates don't pass, the work isn't done.
