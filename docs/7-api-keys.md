# 7 — API Keys and Settings Dialog

Providers need credentials. Keys can be entered in the app and are stored in the operating system's credential store — never in the app's own data file.

See also: [6 — AI Providers](6-providers.md), [3 — UI](3-ui.md), [4 — CLI, Server, and Storage](4-cli-server-storage.md).

## Status: shipped, verified on macOS, Linux and Windows

## Where a key comes from

- **FR-7.1** *(Shipped)* Each keyed provider resolves its API key from two sources, in order: the **environment variable**, then the **OS keychain**. `src/ai/api-keys.ts` is the single place that decides.

  | Provider | Environment variable | Keychain account |
  |---|---|---|
  | Anthropic | `ANTHROPIC_API_KEY` | `anthropic-api-key` |
  | OpenAI | `OPENAI_API_KEY` | `openai-api-key` |

  The environment wins so `ANTHROPIC_API_KEY=… npm run dev` overrides a stored key without the user clearing it first, and so CI and the E2E suite never depend on a developer's keychain. An exported-but-empty variable counts as unset and falls through to the keychain.

- **FR-7.2** *(Shipped)* **There is no third source.** A key is never written to `~/.newsmongermonger/newsmonger.db`, so the data file stays safe to copy, sync, or attach to a bug report. Where the keychain is unavailable, the environment is the only way to supply a key and the dialog says so — the app does not quietly fall back to disk.

- **FR-7.3** *(Shipped)* Keys are resolved **per request**, not at construction. A key saved in Settings takes effect on the next check with no restart. Each provider caches its SDK client but keys that cache on the credential it was built with, so replacing a key can't keep authenticating as the old one.

## Storage (`src/keychain.ts`)

- **FR-7.4** *(Shipped)* The keychain is reached by shelling out to the platform's own tool rather than binding a native module (`keytar`, `@napi-rs/keyring`). No `node-gyp`, no per-architecture prebuilds, and it behaves identically in the Tauri sidecar and under `npm run dev` — which matters because the desktop bundle stages a plain `node_modules` (see [5 — Desktop App](5-desktop-app.md)) where a native module would have to match the bundled Node's ABI.

  | OS | Store | Tool | Verified |
  |---|---|---|---|
  | macOS | Keychain | `security` | ✅ |
  | Linux | Secret Service | `secret-tool` | ✅ (Docker, both with and without a daemon) |
  | Windows | Credential Manager | PowerShell P/Invoke over `advapi32` | ✅ (Windows 11 VM) |

  Service name is `newsmonger`; the account is the varying part. On Windows the credential target is `newsmonger-<account>`.

- **FR-7.5** *(Shipped)* Availability is **probed once per process**. On Linux the probe is a real store → lookup → clear round-trip on a throwaway entry, because `which secret-tool` passes on a headless box with the binary installed and no Secret Service daemon running — and the failure would otherwise surface as a mystifying write error. On macOS it checks `security default-keychain` first, which fails when no user keychain exists (a temp `HOME` in tests) and would otherwise pop a system dialog.

- **FR-7.6** *(Shipped)* **Every write is read back before it is reported as saved.** A credential tool that exits 0 having stored nothing — or something truncated — would otherwise be shown to the user as success and only surface later as an authentication failure.

### Three more, found by actually running Windows

Verified on a Windows 11 VM. Every one of these exited 0 while doing the wrong thing, and all three were caught by the read-back check in FR-7.6 rather than by any error.

**A multi-line script piped to `powershell -Command -` silently does nothing.** The `Add-Type` here-string defining the `CredRead` shim never took effect, so reads returned empty with no stderr and a zero exit. Scripts now go through `-EncodedCommand` (base64 UTF-16LE), which also sidesteps every quoting question.

**`cmdkey /pass:$env:SECRET` truncates at the first space.** PowerShell splits the expanded value into separate arguments, so a secret containing a space was stored incomplete. Writes and deletes now use `CredWrite`/`CredDelete` through the same P/Invoke shim as the read — the value is marshalled as a blob, so nothing parses it. `cmdkey` survives only as the fast existence gate, where it handles no secret.

**PowerShell's stdout mangles non-ASCII.** `sk-ümlaut-🔑` came back as `sk-?mlaut-??`, because output crosses the console code page. The value reaches PowerShell intact — verified byte-for-byte through the environment — so only the return trip was corrupt. The read now asks for base64 of UTF-16 and decodes it in Node.

### Two measured findings worth keeping

**macOS truncates a stdin-fed password at 128 characters.** Passing the secret on stdin (`security add-generic-password -w` with no value, which prompts and reads the password plus a confirmation) keeps it out of `ps` output, and was the original implementation. It silently truncates at 128 characters. Anthropic keys are ~108 and would squeak by; OpenAI project keys are longer and would have been stored corrupted. The write therefore passes the value in argv, where it is visible to `ps` for a few milliseconds — the lesser problem on a machine already running the app. Linux (stdin) and Windows (environment) have no such limit and don't put the secret in argv.

**macOS returns non-ASCII passwords as bare hex.** `find-generic-password -w` prints the password literally when it is printable ASCII and as unmarked lowercase hex when it isn't — indistinguishable from a key that merely *looks* like hex, which some providers do issue. Decoding on appearance alone would silently corrupt those. `-g` disambiguates, printing `password: 0x…` only for the genuinely encoded case, so it is consulted exactly when the value is ambiguous.

## HTTP surface

- **FR-7.7** *(Shipped)* Key values are **write-only**. They go in on `PUT` and are returned by nothing.

  | Route | Behaviour |
  |---|---|
  | `GET /api/keys` | Per-provider `{ provider, label, configured, source, envVar }` plus `keychainAvailable` and `keychainLabel` |
  | `PUT /api/keys/:provider` | `{ key }` → `{ ok: true }`. Trims whitespace; 400 on blank, 404 on an unknown or keyless provider, 503 when no keychain is available |
  | `DELETE /api/keys/:provider` | Clears the stored key. Idempotent. Cannot unset an environment variable |

- **FR-7.8** *(Shipped)* Status carries **no trace of the key** — not the value, and deliberately not a masked tail like `sk-…9f2c`. A mask still leaks length and a distinguishing suffix while buying nothing the user can't get from `source`: they know which key they saved. `configured` + `source` is the whole contract, enforced in `KeyStatusSchema` rather than left to each route.

## Settings dialog

- **FR-7.9** *(Shipped)* A single dialog holds everything configurable: check interval, provider, model, endpoint, and the API keys. The header keeps only a gear button and **Check all now**; the topics panel keeps a one-line source status that points at Settings when the provider has no key.

- **FR-7.10** *(Shipped)* Each key row renders one of three states, because they call for different controls:

  | State | Shown |
  |---|---|
  | From the environment | `✓ from ANTHROPIC_API_KEY` and a note that it's set outside the app. **No Remove** — nothing here can unset a variable it didn't set |
  | Stored in the keychain | `✓ stored in Keychain` and **Remove** |
  | Not configured | `<input type="password">` that saves itself |

  When a key exists there is **no input at all** — the value is never rendered, so there is nothing for a screenshot or password manager to pick up. The input is cleared after a save attempt either way.

- **FR-7.10a** *(Shipped, NEWS-156)* **There is no Save button.** The field commits on `change` — blur or Enter — the same rule the interval and budget fields follow, and for a costlier reason: a save **verifies the key with its vendor** (FR-20.9), so committing on `input` would probe once per keystroke and report every prefix of a key being typed as invalid. Blurring a field nobody touched saves nothing; an empty `PUT` would read as "clear my key".

  Enter fires **both** `submit` (a single-input form submits on Enter) and `change`, so one keypress reaches the handler twice. The field is therefore emptied *before* the save is awaited rather than after, so the second call finds it blank and stops. Measured: with the clear after the await, one Enter sends **two** `PUT`s and two vendor verifications. The E2E counts the requests rather than checking the key ended up stored — it ends up stored either way, so the obvious assertion passes on the bug.

  Losing the button also loses the only sign the app heard you, and the vendor round-trip is not instant, so a `.key-saving` note reads **Checking…** while a save is in flight. Its own class rather than a `.key-state` variant: `.key-state` means "this provider's key status", and a test asserting an unconfigured row has none of those is right to.

- **FR-7.11** *(Shipped)* Where no credential store is available, the inputs are disabled and the dialog names the environment variable to set instead.

### Structural note

The dialog is a conditional sibling and so lives inside an always-present `#settings-slot` container, per the kerf rule in [3 — UI](3-ui.md) (KF-377).

The backdrop and the ✕ deliberately use **different** actions (`settings-backdrop` vs `close-settings`). Delegation matches against the target's ancestors, and the backdrop wraps the whole dialog — so when both shared one action, every click inside the dialog (including the then-present **Save**) matched a `close-settings` ancestor and dismissed the dialog mid-submit, producing a "form is not connected" warning and a save that never happened. Backdrop click-away now fires only when the click landed on the backdrop itself.

## Testing

- **FR-7.12** *(Shipped)* `NEWSMONGER_FAKE_KEYCHAIN=1` swaps in an in-memory store. The E2E suite drives real save/remove flows through the UI, and those must not reach into the keychain of whoever runs the tests — leaving entries behind, or blocking a headless run on an OS authorization prompt. Same idea as `--ai-test` for the AI provider. `playwright.config.ts` sets it for the shared server; the unit tests set it per-file.

## What leaves the machine (FR-7.13) — NEWS-91

The app sends the user's topic names to a third party on a schedule. That is what they asked for by using it, but nothing said so anywhere, and "assume it's obvious" is not a disclosure.

- **FR-7.13** *(Shipped, moved NEWS-121)* A **Privacy dialog**, opened from a footer link at the bottom of the main page — mirrored in the README and summarised on the onboarding welcome step. It states three things:
  1. **Sent on every check**, to the active provider: the topic's name, its guidance, the titles already reported for that topic (how repeats are avoided), and the titles flagged off-topic (how intent is inferred). Nothing else — not the feed, not other topics, not bookmarks.
  2. **Stored locally only**, under `~/.newsmonger`: topics, stories, cached images. **Keys are not there** — they are in the OS keychain (FR-7.2).
  3. **No servers, no telemetry.** The only other outbound traffic is image fetching (proxied — see [8 — Article Images](8-article-images.md)) and opening links the user clicks.

  A unit test pins claim (1) to `buildUserPrompt` — it asserts the prompt carries the disclosed fields and **no URLs, bookmarks, or other topics' stories** — so a future change that starts sending more fails the test rather than silently making the note untrue.
