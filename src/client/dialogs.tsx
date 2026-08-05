/**
 * The export and privacy dialogs (NEWS-297).
 *
 * Second seam out of `app.tsx`. Grouped because they are the two dialogs with no
 * state machine behind them — each renders from what it is handed and owns
 * nothing — which is what makes them the cheapest to move. The dialogs that
 * carry behaviour (`confirm()` and its promise, the discovery tuner, the rename
 * dialog's fetched story count) stay in `app.tsx` until they can move with it.
 *
 * Rendering only: `data-action=export-backdrop`, `data-export-scope`,
 * `data-export-format`, `data-export` and `open-privacy`/`close-privacy` are all
 * still handled by `delegate()` in `app.tsx` (NEWS-126).
 *
 * `privacyNoteJsx` is exported separately from the dialog that wraps it because
 * the disclosure is the reusable part — FR-3.47 put it in its own dialog rather
 * than in Settings precisely because "what leaves this machine" is not a setting.
 */

import type { SafeHtml } from 'kerfjs';

import { PROVIDER_INFO } from '../ai/types.js';
import type { BackupLocation } from '../backup-locations.js';
import type { Topic } from '../db/schemas.js';
import { MAX_GUIDANCE_LENGTH } from '../db/schemas.js';
import { exportHref } from './export-url.js';
import { icon } from './icons.js';
import type { AppState } from './stores.js';

/**
 * The export dialog (NEWS-158).
 *
 * Replaces three fixed buttons — All (.md), All (.json), Saved (.md) — that
 * between them covered three of the four scope × format combinations. There was
 * no reason "Saved only (.json)" was missing beyond nobody having added a fourth
 * button, and a fourth button is the wrong answer: the choice is two questions,
 * not one list, and naming the two makes every combination reachable and the
 * shape of the thing obvious.
 *
 * The Export control stays an `<a>` with a real `href` rather than becoming a
 * button with a click handler, so the NEWS-157 Tauri routing keeps working
 * unchanged — `data-export` hands it to the system browser there, and a plain
 * browser uses the `download` attribute.
 */
export function exportDialogJsx(state: NonNullable<AppState['export']>, topics: Topic[]): SafeHtml {
  const { scope, topicId, format } = state;
  const href = exportHref(state);
  return (
    <div class="dialog-backdrop" data-action="export-backdrop">
      <div class="dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <div class="dialog-head">
          <h2 id="export-title">Export stories</h2>
          <button class="btn icon" type="button" data-action="close-export" aria-label="Close export">
            {icon('clear', 17)}
          </button>
        </div>

        <fieldset class="export-choice">
          <legend>What</legend>
          {[
            { value: 'all', label: 'All stories', hint: 'Everything kept, newest first' },
            { value: 'saved', label: 'Saved only', hint: 'Just your bookmarks' },
            { value: 'topic', label: 'One topic', hint: 'Everything found for a single subject' },
          ].map((option) => (
            <label class={`export-option ${scope === option.value ? 'on' : ''}`}>
              <input
                type="radio"
                name="export-scope"
                value={option.value}
                checked={scope === option.value ? true : undefined}
                // Nothing to narrow to, so the option would only ever produce an
                // empty file (NEWS-160).
                disabled={option.value === 'topic' && topics.length === 0 ? true : undefined}
                data-export-scope={option.value}
              />
              <span class="export-option-label">{option.label}</span>
              <span class="export-option-hint">
                {option.value === 'topic' && topics.length === 0 ? 'No topics to export yet' : option.hint}
              </span>
              {/* Inside the label it belongs to, and always present rather than
                  a conditional sibling of the other options — see docs/3-ui.md.
                  Empty when this is not the chosen scope. */}
              <span class="export-topic-slot">
                {option.value === 'topic' && scope === 'topic' ? (
                  <select data-action="export-topic" aria-label="Topic to export">
                    {topics.map((topic) => (
                      <option value={topic.id} selected={topic.id === topicId ? true : undefined}>
                        {topic.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  ''
                )}
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset class="export-choice">
          <legend>Format</legend>
          {[
            { value: 'md', label: 'Markdown', hint: 'Grouped by topic, for pasting into notes' },
            { value: 'json', label: 'JSON', hint: 'The escape hatch — every field, topic names not ids' },
          ].map((option) => (
            <label class={`export-option ${format === option.value ? 'on' : ''}`}>
              <input
                type="radio"
                name="export-format"
                value={option.value}
                checked={format === option.value ? true : undefined}
                data-export-format={option.value}
              />
              <span class="export-option-label">{option.label}</span>
              <span class="export-option-hint">{option.hint}</span>
            </label>
          ))}
        </fieldset>

        <p class="note">Off-topic stories are left out, as they are in the feed. Up to 2000 stories.</p>

        {/* `.confirm-actions` is what every other dialog's footer uses — a new
            class here would be a second name for the same row. */}
        <div class="confirm-actions">
          <button class="btn" type="button" data-action="close-export">
            Cancel
          </button>
          {/* One attribute, one delegate. Adding `close-export` here as well
              close the dialog synchronously on click, removing this anchor
              before the browser had processed its default action. The
              `data-export` handler closes it on the next tick instead — see the
              note there for how much that is worth. */}
          {/* `exportHref` returns null when the choice cannot be exported —
              "one topic" with none picked. A disabled-looking anchor that still
              navigates is worse than no anchor, so the control becomes a real
              disabled button in that state rather than a styled link. */}
          {href === null ? (
            <button class="btn primary" type="button" disabled>
              Export
            </button>
          ) : (
            <a class="btn primary" href={href} download="" data-export>
              Export
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export function privacyDialogJsx(s: AppState): SafeHtml {
  return (
    <div class="dialog-backdrop" data-action="privacy-backdrop">
      <div class="dialog privacy-dialog" role="dialog" aria-modal="true" aria-labelledby="privacy-title">
        <div class="dialog-head">
          <h2 id="privacy-title">Privacy</h2>
          <button class="btn icon" type="button" data-action="close-privacy" aria-label="Close privacy">
            {icon('clear', 17)}
          </button>
        </div>
        {privacyNoteJsx(s)}
      </div>
    </div>
  );
}

export function privacyNoteJsx(s: AppState): SafeHtml {
  const provider = PROVIDER_INFO[s.settings.provider].label;
  return (
    <div class="privacy">
      <p class="note">
        <strong>Sent on every check</strong>, to {s.settings.provider === 'auto' ? 'whichever provider is active' : provider}:
        the topic’s name, its guidance if you wrote any, the titles of stories already reported for it (that is
        how repeats are avoided), and the titles of stories you flagged off-topic (that is how it learns what
        you meant). Nothing else — not the feed, not your other topics, not anything you bookmarked.
      </p>
      <p class="note">
        <strong>Stored on this machine only</strong>, in ~/.newsmonger: your topics, the stories found, and cached
        article images. <strong>API keys are not stored there</strong> — they live in your {s.keychainLabel}.
      </p>
      <p class="note">
        <strong>Newsmonger has no servers and collects no telemetry.</strong> The only outbound traffic is the check
        itself, fetching article images, and opening links you click.
      </p>
    </div>
  );
}

/**
 * Editor for a topic's guidance (NEWS-80).
 *
 * The textarea is uncontrolled — its JSX children seed it from server state and
 * nothing re-renders it while the user types. Binding it to a signal would fight
 * the 4 s state poll for the cursor, and there is nothing to derive from the
 * draft until it's saved.
 */
export function guidanceDialogJsx(topic: Topic): SafeHtml {
  return (
    <div class="dialog-backdrop" data-action="guidance-backdrop">
      <div class="dialog guidance" role="dialog" aria-modal="true" aria-label={`Guidance for ${topic.name}`}>
        <form data-save-guidance={topic.id}>
          <h2>Guidance for “{topic.name}”</h2>
          <p class="dialog-hint">
            Say what you want from this topic — and what you don’t. It’s sent with every check, so the
            model narrows to your sense of the topic instead of guessing from the name alone.
          </p>
          <textarea
            name="guidance"
            rows={5}
            maxLength={MAX_GUIDANCE_LENGTH}
            placeholder="e.g. Regulatory and safety news only — not stock price moves or product rumours."
          >
            {topic.guidance}
          </textarea>
          <div class="confirm-actions">
            <button class="btn" type="button" data-action="close-guidance">
              Cancel
            </button>
            <button class="btn primary" type="submit">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}


/**
 * Edit a topic's name (NEWS-139; relabelled NEWS-162).
 *
 * Still a rename in the API and in this code — `PATCH /api/topics/:id { name }`
 * is exactly what it does — but the *user-facing* verb is "edit", because
 * "rename" undersells it: the name is the question put to the model, which the
 * hint below has always said and the menu item used to contradict.
 *
 * The clear-results choice is offered **only when there are results to clear**,
 * and it is off by default: renaming is usually a correction — a typo, a better
 * wording — and discarding a topic's history should never be something that
 * happens because a checkbox was already ticked.
 */
export function renameDialogJsx(topic: Topic, itemCount: number | null): SafeHtml {
  return (
    <div class="dialog-backdrop" data-action="rename-backdrop">
      <div class="dialog rename" role="dialog" aria-modal="true" aria-label={`Edit topic ${topic.name}`}>
        <form data-save-rename={topic.id}>
          <h2>Edit “{topic.name}”</h2>
          <p class="dialog-hint">
            The name is what the model is asked about, so changing it changes what gets found from the next
            check onwards.
          </p>
          <input
            type="text"
            name="topic-name"
            class="rename-input"
            maxLength={200}
            autocomplete="off"
            value={topic.name}
            data-morph-skip-children
          />
          {/* Always-present container so the checkbox appearing can't restructure
              the form around it (docs/3-ui.md). */}
          <div class="rename-clear">
            {/* `null` means the count hasn't arrived yet — showing the option
                before then would mean rendering "clear the 0 stories". */}
            {itemCount !== null && itemCount > 0 ? (
              <label class="checkbox">
                <input type="checkbox" name="clear-items" />
                <span>
                  Also clear the {String(itemCount)} {itemCount === 1 ? 'story' : 'stories'} already found for
                  this topic
                </span>
              </label>
            ) : (
              ''
            )}
          </div>
          <div class="confirm-actions">
            <button class="btn" type="button" data-action="close-rename">
              Cancel
            </button>
            <button class="btn primary" type="submit">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}




/**
 * The backup offer (NEWS-230, FR-27.2-27.5).
 *
 * **No backdrop `data-action`, deliberately** (FR-27.3). Every other dialog in
 * the app closes on an outside click, and this one must not: a stray click
 * outside would count as an answer to a question the user never read, and the
 * two real answers have different consequences -- one re-asks tomorrow, one
 * never does. A decision needs a decision, not a dismissal. There is no close
 * button for the same reason; the three buttons *are* the exits.
 *
 * The copy is **"keep a backup here"**, never "move your data here". The live
 * database stays local on purpose (`docs/27-data-location.md`), and promising
 * otherwise would be promising the one thing this design refuses to do.
 */
export function backupOfferJsx(locations: BackupLocation[]): SafeHtml {
  return (
    <div class="dialog-backdrop onboarding-backdrop">
      <div class="dialog backup-offer" role="dialog" aria-modal="true" aria-labelledby="backup-offer-title">
        <div class="dialog-head">
          <h2 id="backup-offer-title">Keep a backup of your topics?</h2>
        </div>
        <p class="onboarding-lead">
          You&rsquo;re watching a few topics now. Newsmonger can write a copy of them &mdash; your topics, your
          settings and the stories it has found &mdash; into a folder your computer already syncs, so a lost laptop
          doesn&rsquo;t mean starting over.
        </p>
        <div class="backup-suggestions">
          {locations.length > 0 ? (
            <div>
              <p class="note">Found on this machine:</p>
              {locations.map((l) => (
                <button class="btn suggestion-btn" type="button" data-backup-suggestion={l.path}>
                  <span class="backup-suggestion-label">{l.label}</span>
                  <span class="backup-suggestion-path">{l.path}</span>
                </button>
              ))}
            </div>
          ) : (
            <p class="note">
              No iCloud Drive, OneDrive, Google Drive or Dropbox folder was found here &mdash; type any folder you
              like below, including one on an external disk.
            </p>
          )}
        </div>
        <label class="field">
          <span>Backup folder</span>
          <input
            type="text"
            data-action="backup-offer-input"
            placeholder="/path/to/a/folder"
            spellCheck="false"
            autocorrect="off"
          />
        </label>
        <p class="note">
          <strong>Your API keys are never included</strong> &mdash; they stay in your keychain. The database itself
          stays on this machine on purpose: a live SQLite file inside a folder a sync client rewrites is a known way
          to corrupt it. You can change this or turn it off later in Settings &rarr; Data.
        </p>
        <div class="dialog-actions">
          <button class="btn subtle" type="button" data-action="backup-offer-never">
            Don&rsquo;t ask again
          </button>
          <button class="btn subtle" type="button" data-action="backup-offer-later">
            Not now
          </button>
          <button class="btn primary" type="button" data-action="backup-offer-save">
            Keep backups here
          </button>
        </div>
      </div>
    </div>
  );
}
