/**
 * One provider's API-key row (NEWS-297).
 *
 * Its own module because **two views render it**: Settings → Source, and
 * onboarding's Source step, which embeds the real key rows rather than a reduced
 * copy of them (FR-24.18's reasoning, applied to keys). It belongs to neither,
 * so it lives beside both — the same call `relativeTime` prompted when the feed
 * moved out.
 *
 * Rendering only. `submit`/`change`/`data-remove-key` are handled by
 * `delegate()` in `app.tsx` (NEWS-126).
 */

import type { SafeHtml } from 'kerfjs';

import { icon } from './icons.js';
import type { AppState } from './stores.js';

/**
 * One provider's key row.
 *
 * Three states, because they call for different controls: supplied by the
 * environment (nothing to do here — the app can't unset a variable it didn't
 * set), stored in the keychain (offer removal), or absent (offer an input).
 * The stored key is never rendered; when one exists there is no field at all,
 * so there's nothing for a screenshot or a password manager to pick up.
 */
export function keyRowJsx(
  key: AppState['keys'][number],
  keychainLabel: string,
  keychainAvailable: boolean,
  saving: boolean,
): SafeHtml {
  const inputId = `key-input-${key.provider}`;

  if (key.source === 'env') {
    return (
      <div class="key-row" data-key={`key-${key.provider}`}>
        <span class="key-provider">{key.label}</span>
        <span class="key-state ok">
          {icon('ok', 13)} from {key.envVar}
        </span>
        <span class="key-hint">Set in the environment — unset the variable to change it.</span>
      </div>
    );
  }

  if (key.source === 'keychain') {
    return (
      <div class="key-row" data-key={`key-${key.provider}`}>
        <span class="key-provider">{key.label}</span>
        <span class="key-state ok">
          {icon('ok', 13)} stored in {keychainLabel}
        </span>
        <button class="btn subtle" type="button" data-remove-key={key.provider}>
          Remove
        </button>
      </div>
    );
  }

  return (
    <div class="key-row" data-key={`key-${key.provider}`}>
      {/* A real `<label for>`, not a `<span>` (NEWS-270). Chromium reported both
          rows' accessible name as "Paste API key" — sourced from the
          `placeholder`, and therefore identical for Anthropic and OpenAI, so a
          screen reader gave no way to tell the two fields apart. Clicking the
          visible text focused nothing either.

          Only this branch: the `env` and `keychain` rows above have no input, and
          a label pointing at an id that isn't rendered is worse than a span.

          axe stayed green throughout, because the field *had* a name — the same
          blind spot NEWS-267 hit from the other side. */}
      <label class="key-provider" for={inputId}>
        {key.label}
      </label>
      {/* No Save button (NEWS-156). The field commits on `change` — blur or
          Enter — which is the same rule the interval and budget fields follow,
          and for a stronger reason: saving verifies the key with its vendor
          (FR-20.9), so committing per keystroke would probe the vendor once per
          character and report every prefix of a key as invalid. */}
      <form class="key-form" data-save-key={key.provider}>
        <input
          type="password"
          id={inputId}
          name="api-key"
          class="key-input"
          placeholder={keychainAvailable ? 'Paste API key' : `Set ${key.envVar} instead`}
          autocomplete="off"
          spellcheck="false"
          disabled={keychainAvailable ? undefined : true}
          data-morph-skip-children
        />
      </form>
      {/* Losing the button also loses the only sign the app is doing something,
          and the vendor round-trip is not instant. This is the replacement. */}
      <span class="key-saving">{saving ? 'Checking…' : ''}</span>
    </div>
  );
}
