/**
 * The settings dialog: its tabs and all four panels (NEWS-297).
 *
 * The largest seam out of `app.tsx`, and the cleanest despite its size — every
 * symbol in here had exactly **one** caller, and every one of those callers was
 * also in here. `settingsDialogJsx` is the only thing the rest of the app asks
 * for. That is what made a 900-line move safe: it is a subsystem, not a slice.
 *
 * Includes the pieces only Settings renders — `sourceStatusJsx`,
 * `providerIsAttended`, `notifyBlockedNoteJsx`, `RETENTION_OPTIONS`. `INTERVAL_OPTIONS` is *not* here:
 * onboarding renders it too, so it lives in `stores.ts` with the other shared
 * client constants (NEWS-297). A thing moves to the view that owns it, or to a
 * shared home if two views own it — never to whichever view moved first.
 *
 * Rendering only. Every `data-action` written here is handled by one
 * `delegate()` in `app.tsx` (NEWS-126), and the four-tab machinery reads
 * `settingsTab` from the store.
 */

import type { SafeHtml } from 'kerfjs';

import type { ProviderName } from '../ai/types.js';
import {
  EFFORT_LABELS,
  isKeyedProvider,
  PROVIDER_INFO,
  PROVIDER_MODELS,
  PROVIDER_NAMES,
  providerTakesEffort,
} from '../ai/types.js';
import { relativeTime } from './dates.js';
import { effortAvailable, effortOptions } from './effort-options.js';
import { icon } from './icons.js';
import { keyRowJsx } from './key-row.js';
import { modelOptions } from './model-choice.js';
import { sourceStatus } from './source-status.js';
import type { AppState } from './stores.js';
import { appStore, INTERVAL_OPTIONS } from './stores.js';
import { isTauri } from './tauri.js';

/**
 * Theme choices (FR-3.74, NEWS-334).
 *
 * `auto` is first and is the default — it is a real choice rather than the
 * absence of one, and naming what it does ("Match system") is the difference
 * between a reader trusting it and pinning a mode to be sure.
 */
const THEME_OPTIONS: { label: string; value: 'auto' | 'light' | 'dark' }[] = [
  { label: 'Match system', value: 'auto' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
];

/** Story-retention choices (NEWS-87). 0 = keep everything. */
const RETENTION_OPTIONS: { label: string; days: number }[] = [
  { label: '3 months', days: 90 },
  { label: '6 months', days: 180 },
  { label: '1 year', days: 365 },
  { label: '2 years', days: 730 },
  { label: 'Forever', days: 0 },
];

/**
 * "Is the current source usable" line.
 *
 * Lives in the settings dialog beside the provider picker rather than in the
 * sidebar: the provider is chosen here, so this is where knowing whether it
 * actually works is useful. A provider that can't run still surfaces on the
 * page through the failed-check warning banner, so nothing is lost by not
 * repeating it in the sidebar.
 */
function sourceStatusJsx(): SafeHtml {
  const s = appStore.state.value;
  // The provider's name is not repeated here — the picker directly above says
  // it. This line carries only what the picker can't: whether it works.
  //
  // Every branch renders something (NEWS-308). It used to render nothing at all
  // on the default settings — `auto` is reported by the server with
  // `available: null`, which is correct and unprintable — leaving a blank row
  // that the design review read once as unexplained empty space and once as the
  // status line being missing. The rule for which provider `auto` resolves to
  // lives in `source-status.ts`; see there for why the client computes it.
  const status = sourceStatus(s.providers, s.settings.provider);
  const lastProvider = s.runs.find((r) => r.provider !== null)?.provider ?? null;

  return (
    <p class="source-status">
      <span class="source-state">
        {status.kind === 'unavailable' ? (
          <span class="state warn">
            {icon('warn', 12)}{' '}
            {/* "no API key" is only true of the keyed providers. A subscription
                provider needs none — saying it does contradicts the sentence
                directly below, which tells the reader checks use their
                subscription (NEWS-240). What is actually wrong there is that the
                CLI could not be run: in a Finder-launched macOS app the shell's
                PATH is not inherited, which is the bug the resolver now fixes. */}
            {isKeyedProvider(s.settings.provider) ? 'no API key' : 'CLI not found'}
          </span>
        ) : (
          ''
        )}
        {/* `auto` names what it resolved to. That is the single most useful
            thing this tab can say — "ready" alone, under a picker reading
            "Auto", leaves the reader not knowing which subscription or key the
            next check will spend. */}
        {status.kind === 'ready' ? (
          <span class="state ok">
            {icon('ok', 12)} ready{status.via !== null ? ` — via ${PROVIDER_INFO[status.via].label}` : ''}
          </span>
        ) : (
          ''
        )}
        {status.kind === 'none-usable' ? (
          <span class="state warn">{icon('warn', 12)} no provider is signed in or keyed</span>
        ) : (
          ''
        )}
        {/* A resting state, not a blank. "Not checked yet" is a fact; an empty
            row is a rendering fault as far as a reader can tell. */}
        {status.kind === 'unknown' ? <span class="state">not checked yet</span> : ''}
      </span>
      <span class="source-last">{lastProvider !== null ? `last check via ${lastProvider}` : ''}</span>
    </p>
  );
}

/**
 * Whether a provider spends a personal subscription rather than a metered key.
 *
 * Kept as a small client-side list rather than plumbed through `/api/providers`:
 * it's static metadata, and the dialog only needs it to decide what to explain.
 */
function providerIsAttended(provider: ProviderName): boolean {
  return provider === 'claude-cli' || provider === 'codex-cli';
}

/**
 * Why notifications are blocked, and where to actually fix it (NEWS-40).
 *
 * This used to say "blocked for this app in your browser or system settings",
 * which is true and useless: it names two places without saying which, and in a
 * browser it sends people to the wrong one. That is not hypothetical — it cost
 * a real search through macOS System Settings looking for a "Newsmonger" entry
 * that **cannot exist there**, because in a browser the notification permission
 * belongs to the *browser*, per site. macOS lists Chrome or Safari; it has
 * never heard of this app.
 *
 * So the note branches on where it is running, and names the origin, because
 * "this site" is ambiguous when the address is a bare loopback IP.
 */
function notifyBlockedNoteJsx(): SafeHtml {
  if (isTauri()) {
    // Reachable only if the desktop shell's own notification bridge fails —
    // it reports permission as granted without asking the OS, so there is no
    // "denied" to recover from in the way a browser has (NEWS-260). Notably it
    // must *not* send people to a System Settings entry for Newsmonger: that
    // entry does not exist until the app has delivered its first notification,
    // so the old copy pointed at a blank space and looked like a fault.
    return (
      <p class="note warn">
        Newsmonger couldn’t hand a notification to your system. The app only appears in{' '}
        <strong>System Settings → Notifications</strong> once it has delivered one, so there may be nothing to allow
        there yet — it should show up after the first new story arrives while this window is in the background.
      </p>
    );
  }
  return (
    <p class="note warn">
      Your browser is blocking notifications for <code>{location.origin}</code>. Fix it in the browser&rsquo;s own
      site settings for this page — the padlock or icon beside the address bar. <strong>Looking in macOS System
      Settings won&rsquo;t help</strong>: in a browser the permission belongs to the browser, so it lists Chrome or
      Safari and never Newsmonger.
    </p>
  );
}


/**
 * What leaves this machine, stated plainly (NEWS-91).
 *
 * Checking a topic means sending its name to a third party — the user asks for
 * that by using the app, but nowhere did the app actually say so. This is the
 * disclosure, written to be read rather than to be technically sufficient, and
 * it names the *unobvious* parts: the flagged titles and the already-reported
 * titles both go too, because that is how dedup and steering work.
 */

/**
 * Privacy, as its own dialog reached from the footer (NEWS-121).
 *
 * It was a section at the bottom of Settings, which is the wrong place twice
 * over: it isn't a setting — nothing on it can be changed — and burying "what
 * leaves this machine" under six screens of configuration is the opposite of
 * how a privacy note earns trust. A footer link is where people look for one.
 */

/**
 * Settings tabs (NEWS-118).
 *
 * The dialog had grown to roughly two screens of unrelated controls in one
 * column — scheduling next to API keys next to export links — so nothing was
 * findable except by scrolling past everything else. Four groups, each of which
 * answers a different question:
 *
 * | Tab | Answers |
 * |---|---|
 * | Schedule | *when* does it check |
 * | Source | *who* does it ask |
 * | Data | *what* is kept, and how do I get it out |
 * | App | everything about the app itself |
 *
 * Lucide icons, from the same set as the rest of the UI (`icons.tsx`) — a label
 * alone made the strip read as prose rather than as controls.
 */
const SETTINGS_TABS = [
  { id: 'schedule', label: 'Schedule', icon: 'clock' },
  { id: 'source', label: 'Source', icon: 'bot' },
  { id: 'data', label: 'Data', icon: 'database' },
  { id: 'app', label: 'App', icon: 'bell' },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];

function settingsTabsJsx(active: SettingsTab): SafeHtml {
  return (
    <div class="settings-tabs" role="tablist" aria-label="Settings sections">
      {SETTINGS_TABS.map((tab) => (
        <button
          class={`settings-tab${tab.id === active ? ' active' : ''}`}
          type="button"
          role="tab"
          id={`settings-tab-${tab.id}`}
          aria-selected={tab.id === active ? 'true' : 'false'}
          aria-controls="settings-panel"
          // Only the selected tab is in the tab order; the rest are reached with
          // the arrow keys, which is the WAI-ARIA tabs pattern.
          tabindex={tab.id === active ? '0' : '-1'}
          data-settings-tab={tab.id}
        >
          {icon(tab.icon, 14)}
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  );
}

function settingsPanelJsx(s: AppState): SafeHtml {
  // Effort narrows with the *model*, not just the provider (NEWS-254), and the
  // control, its title and its note all need the same answer.
  const effortChoice = { liveEffortLevels: s.liveEffortLevels, chosen: s.settings.effort };
  const effortUsable = providerTakesEffort(s.settings.provider) && effortAvailable(effortChoice);

  const provider = s.settings.provider;
  const info = PROVIDER_INFO[provider];
  switch (s.settingsTab) {
    case 'schedule':
      return (
        <div>
        {/* Every group on every tab carries an eyebrow (NEWS-307). Three tabs
            used to open with an anonymous cluster and only *start* labelling at
            the second group, which said "the first group is not a group" about a
            group — and left the controls most people touch as the one region of
            the dialog with no landmark to scan back to. Schedule had no eyebrows
            at all, so it was internally consistent and externally the odd one
            out; naming its two groups is what makes the rule a rule. */}
        <h3 class="eyebrow">Cadence</h3>
        <label class="field">
          <span class="field-label">Schedule</span>
          <select data-action="schedule-mode">
            <option value="interval" selected={s.settings.scheduleMode === 'interval' ? true : undefined}>
              Every so often
            </option>
            <option value="daily" selected={s.settings.scheduleMode === 'daily' ? true : undefined}>
              At set times of day
            </option>
          </select>
        </label>

        {/* Always-present container: swapping the two controls must not
            restructure the fields around them (kerf KF-377). */}
        <div id="schedule-slot">
          {s.settings.scheduleMode === 'daily' ? (
            <div>
              <label class="field">
                <span class="field-label">Check at</span>
                <input type="text" data-action="daily-times" value={s.settings.dailyTimes.join(', ')} placeholder="08:00, 18:00" />
              </label>
              <p class="note">
                Local times, 24-hour, comma separated. A slot missed while Newsmonger was closed is served when it
                next opens rather than skipped — so a morning briefing is still there at lunchtime.
              </p>
            </div>
          ) : (
            <label class="field">
              <span class="field-label">Check every</span>
              <select data-action="interval">
                {INTERVAL_OPTIONS.map((opt) => (
                  <option value={String(opt.ms)} selected={opt.ms === s.settings.checkIntervalMs ? true : undefined}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <label class="field">
          <span class="field-label">
            {/* Just "High-priority" (NEWS-117): the row sits directly under
                "Check every", so "topics every" was restating the column it is in —
                and it wrapped to a second line to do it. */}
            {icon('star', 13)} High-priority
          </span>
          <select data-action="hp-interval">
            {INTERVAL_OPTIONS.map((opt) => (
              <option value={String(opt.ms)} selected={opt.ms === s.settings.highPriorityIntervalMs ? true : undefined}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <p class="field-hint">
          Kept at or below the default interval — changing either adjusts the other to keep that true.
        </p>
        {/* Its own group, not a third row of Cadence: how *often* to check and
            how many to run *at once* are different questions, and naming the
            first group is what surfaced that. */}
        <h3 class="eyebrow">Concurrency</h3>
        <label class="field">
          <span class="field-label">Check at once</span>
          <select data-action="concurrency">
            {[1, 2, 3, 4, 6, 8].map((n) => (
              <option value={String(n)} selected={n === s.settings.checkConcurrency ? true : undefined}>
                {n === 1 ? 'One topic at a time' : `${String(n)} topics`}
              </option>
            ))}
          </select>
        </label>
        <p class="note">
          A real check takes minutes, so a sweep over many topics runs for a long time one at a time. Raising
          this finishes sooner — up to a point: too high and the provider starts refusing requests instead.
        </p>
        </div>
      );
    case 'source':
      return (
        <div>
        {/* Named for its lead control, which repeats the first field's label
            (NEWS-307). Considered and kept: every alternative was either a
            synonym this project does not use anywhere else — the vocabulary is
            "provider", in `PROVIDER_NAMES` and docs/6-providers.md — or a phrase
            too long for a mono eyebrow. A section named after the control it is
            built around is ordinary; inventing a word for it is not. */}
        <h3 class="eyebrow">Provider</h3>
        <label class="field">
          <span class="field-label">Provider</span>
          <select data-action="provider" title="Which AI finds and summarizes news">
            {PROVIDER_NAMES.map((name) => (
              <option value={name} selected={name === provider ? true : undefined}>
                {PROVIDER_INFO[name].label}
              </option>
            ))}
          </select>
        </label>

        {/* Order is provider → model → effort, with every note and status
            line gathered below them (NEWS-256). That is the order the
            settings are decided in and, since NEWS-253/254, the order they
            *depend* on each other: the provider decides which models are
            offered, and the model decides which effort levels are. Reading
            provider, then effort, then model asked someone to hold a
            dependency the layout was contradicting.

            Every conditional keeps its always-present wrapper — this is a
            reorder, not a flatten (docs/3-ui.md). */}
        {/* Always-present container: conditional fields must not appear and
            disappear as siblings (kerf KF-377 — see docs/3-ui.md). */}
        <div class="source-fields">
          {provider !== 'auto' && provider !== 'mock' ? (
            <label class="field">
              <span class="field-label">Model</span>
              {/* A `<select>`, not a combobox (NEWS-253). It offers what the
                  provider says it has — live from its catalogue (NEWS-248/249/
                  251) — so a model left over from a different provider can no
                  longer sit there waiting to fail on the next check.

                  This does take something away. The field was free text on
                  purpose (FR-6.14), because an OpenAI-compatible gateway may
                  serve models this app cannot enumerate. `modelOptions` keeps
                  a stored value the catalogue doesn't list, so such a setting
                  survives being looked at — but once changed away from, it
                  cannot be typed back. */}
              <select class="source-field" data-action="model">
                {modelOptions(s.liveModels.length > 0 ? s.liveModels : PROVIDER_MODELS[provider], s.settings.model).map(
                  (m) => (
                    <option value={m} selected={m === s.settings.model ? true : undefined} data-key={m}>
                      {m}
                    </option>
                  ),
                )}
              </select>
            </label>
          ) : (
            ''
          )}
          {info.endpointConfigurable ? (
            <label class="field">
              <span class="field-label">Endpoint</span>
              <input
                type="text"
                class="source-field"
                name="endpoint"
                value={s.settings.endpoint}
                placeholder="default"
                autocomplete="off"
                data-action="endpoint"
                data-morph-skip-children
              />
            </label>
          ) : (
            ''
          )}
        </div>
        {/* Which providers take one is `providerTakesEffort`. **All of them do
            now**, except the test-only `mock` — so the disabled state is nearly
            unreachable, and that is the point: this comment used to claim the
            CLI providers "take no such parameter at all", which was untrue three
            times over. Claude Code has `--effort <level>` (NEWS-239); Codex takes
            `-c model_reasoning_effort=<level>`, invisible in its `--help`
            because it rides the generic config override (NEWS-244); and the
            OpenAI Responses API has `reasoning.effort`, which we now send and
            drop again if the model says no (NEWS-245).

            Each time the evidence was an *absence* — a flag not in a help text,
            a parameter we had not wired. Check the tool before writing that a
            tool can't.

            Disabled rather than hidden — a control that vanishes reads as a bug
            (NEWS-189).

            **A `title` was not enough** (NEWS-240/239). It was the only
            explanation, and a tooltip on a *disabled* control is close to
            unreachable: it needs a hover held over something the pointer already
            treats as inert, it never appears on touch, and it is invisible to
            anyone who clicks rather than hovers. The report was "effort popup
            doesn't work — nothing pops up", which is exactly what a disabled
            select looks like when nothing says why. The reason is now on the
            page. */}
        <label class="field">
          <span class="field-label">Effort</span>
          <select
            data-action="effort"
            disabled={effortUsable ? undefined : true}
            title={
              effortUsable
                ? 'How hard the model works on a check. Higher is slower and costs more.'
                : 'This provider and model take no effort setting.'
            }
          >
            {/* Only levels this provider *and model* accept (NEWS-254). An
                unsupported one used to be listed and labelled; it is now
                corrected away instead, so the control never shows a choice a
                check would fail on. */}
            {effortOptions(effortChoice).map((level) => (
              <option value={level} selected={level === s.settings.effort ? true : undefined} data-key={level}>
                {EFFORT_LABELS[level]}
              </option>
            ))}
          </select>
        </label>
        {/* Always-present container, so the note appearing doesn't restructure
            its siblings (docs/3-ui.md). */}
        <div class="effort-note">
          {effortUsable ? (
            ''
          ) : (
            <p class="note">
              {s.settings.model !== '' && providerTakesEffort(s.settings.provider)
                ? `${s.settings.model} takes no effort setting, so this is switched off. Choosing a different model above may re-enable it.`
                : `${PROVIDER_INFO[s.settings.provider].label} takes no effort setting, so this is switched off.`}
            </p>
          )}
        </div>

        {sourceStatusJsx()}

        {/* Always-present slot: the note appears only for subscription-backed
            providers (kerf KF-377 — see docs/3-ui.md). */}
        <div class="source-note">
          {providerIsAttended(s.settings.provider) ? (
            <p class="note">
              Checks use your subscription, not an API key. Scheduled checks run only while Newsmonger is open; “Check now”
              always works.
            </p>
          ) : (
            ''
          )}
        </div>

        <h3 class="eyebrow">API keys</h3>
        <div class="keys">{s.keys.map((k) => keyRowJsx(k, s.keychainLabel, s.keychainAvailable, s.savingKey === k.provider))}</div>

        <div class="key-notes">
          {s.keyError !== null ? <p class="banner error">{s.keyError}</p> : ''}
          {s.keysLoaded && !s.keychainAvailable ? (
            <p class="note warn">
              No {s.keychainLabel} is available here, so keys can't be saved from the app. Set the environment
              variables above instead.
            </p>
          ) : (
            ''
          )}
        </div>
        <p class="note">
          Keys are stored in your {s.keychainLabel} — never in ~/.newsmonger/newsmonger.db, and never sent anywhere but the
          provider you chose.
        </p>
        </div>
      );
    case 'data':
      return (
        <div>
        {/* Three groups, and the names had to change to keep them honest
            (NEWS-327). NEWS-307 split retention out of export and called it
            `Stories` — right then, wrong once *both* halves of the tab grew an
            import: the group that moves stories in and out is the one a reader
            looks for under "Stories", and retention answers a different question
            entirely. So retention becomes `Retention`, which is what it is, and
            `Export` becomes `Stories`, which is what it holds now that it
            imports too. */}
        <h3 class="eyebrow">Retention</h3>
        <label class="field">
          <span>Keep stories for</span>
          <select data-action="retention">
            {RETENTION_OPTIONS.map((o) => (
              <option value={String(o.days)} selected={o.days === s.settings.itemRetentionDays ? true : undefined}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {/* One line at hint scale, not a paragraph at note scale (NEWS-306).
            The tab was four controls and twenty lines of prose, and the prose
            won — the eye could not move control to control because an
            explanation sat between every pair. Every hint here answers the one
            question its control raises and stops; the reasoning behind them
            lives in docs/4-cli-server-storage.md and docs/27-data-location.md,
            which is where it was already written down. */}
        <p class="field-hint">Bookmarked and flagged stories are kept whatever you choose here.</p>
        {/* Topics **above** stories (NEWS-327). A topic is the thing you own
            here and a story is what a topic produced, so the list you would hand
            to someone else comes first.

            The export is a plain link rather than a button: it is a `GET` that
            returns a file, so the browser's own download is the whole mechanism
            and an anchor gets right-click → Save As for free. `data-external` so
            the desktop shell hands it to the system browser like every other
            outbound link (FR-3.8). */}
        <h3 class="eyebrow">Topics</h3>
        <div class="io-row">
          <a class="btn" href="/api/export-topics.json" download data-external="1">
            {icon('download', 15)} Export topics…
          </a>
          {/* A `<label>` wrapping a hidden input, not a button that opens one:
              the file picker can only be opened by a real user gesture on a real
              file input, and a label *is* that gesture. It also gets keyboard
              focus and the accessible name for free.

              No confirmation anywhere near it (FR-30.16). This adds, skips and
              reports — it cannot destroy anything — and putting a safe action
              behind the ceremony the Reset group uses would dilute the ceremony. */}
          <label class="btn file-btn">
            {icon('upload', 15)} Import topics…
            <input type="file" accept="application/json,.json" data-action="import-topics" />
          </label>
        </div>
        {/* One line, and it earns its place by answering the question the file
            raises rather than by describing the button (FR-3.69). "No stories,
            no keys" is FR-30.4: the file looks like a config file and someone
            will assume otherwise. Two sentences here pushed the Data tab past
            NEWS-306's prose-density ceiling — the tab has six groups to
            Schedule's two, so each one's hint has to be genuinely one line. */}
        <p class="field-hint">Names, guidance and categories — no stories, no keys.</p>
        {/* One button, one dialog (NEWS-158). Three fixed buttons covered three
            of the four scope × format combinations — "Saved only (.json)" simply
            had no way to be asked for — and adding the fourth would have made a
            row of four buttons naming a two-part choice. */}
        <h3 class="eyebrow">Stories</h3>
        <div class="io-row">
          {/* `download`, not `share` (NEWS-161): this writes a file to disk, it
              does not hand anything to another person or app — the share graph
              named the wrong action. */}
          <button class="btn primary" type="button" data-action="open-export">
            {icon('download', 15)} Export stories…
          </button>
          {/* Beside the button whose output it reads (FR-30.15, NEWS-319) — an
              export nothing could read was the whole complaint, and putting the
              two anywhere but together would leave that half-answered. */}
          <label class="btn file-btn">
            {icon('upload', 15)} Import stories…
            <input type="file" accept="application/json,.json" data-action="import-stories" />
          </label>
        </div>
        <p class="field-hint">Markdown to paste into notes, JSON as the escape hatch.</p>
        {/* Backups (NEWS-192, FR-27.6). The path is typed rather than picked:
            a browser cannot hand a Node server a real filesystem path, and the
            desktop shell has no dialog plugin yet — see docs/27-data-location.md. */}
        <h3 class="eyebrow">Backup</h3>
        {/* Stacked, not beside its label (NEWS-331): a backup path is long
            enough that half a dialog cannot show it, so the one value this field
            exists to display was always scrolled out of view. */}
        <label class="field stacked">
          <span>Backup folder</span>
          <input
            type="text"
            data-action="backup-dir"
            value={s.settings.backupDir}
            placeholder="e.g. ~/Library/Mobile Documents/com~apple~CloudDocs/Newsmonger"
            spellCheck="false"
            autocorrect="off"
          />
        </label>
        {/* Its own class, not `io-row`: that one is the import/export pair, and
            this is a single button with different spacing needs. Two rows under
            one class also makes every selector naming it ambiguous. */}
        <div class="backup-row">
          <button class="btn" type="button" data-action="backup-now" disabled={s.settings.backupDir === ''}>
            {icon('database', 15)} Back up now
          </button>
        </div>
        {/* Why it is disabled, said where it is disabled (NEWS-309 §4). The
            state was correct and the reason was nowhere — a disabled control
            with no adjacent explanation is a dead end, which is the NEWS-40 /
            NEWS-260 failure mode. */}
        <p class="field-hint">
          Point this at an iCloud Drive, OneDrive or Google Drive folder; empty turns backups off.
          {s.settings.backupDir === '' ? ' Name a folder and “Back up now” turns on.' : ''}
        </p>
        {/* The trust statement keeps note weight while the explanations around
            it drop to hints (NEWS-306). It is not an explanation — it is the
            answer to "what am I about to sync to someone else's computer", and
            it was the one line on this tab doing real work. Demoting it with
            everything else would have been the wrong half of the fix. */}
        <p class="note">
          <strong>Your API keys are never included</strong> — they stay in your {s.keychainLabel}. A snapshot holds
          your topics, settings and stories, written after a check at most once an hour.
        </p>
        {/* Restore (NEWS-252). Always-present container so the panel doesn't
            restructure when a backup is found (docs/3-ui.md). Offered only when
            there is something to restore — an empty folder needs no button, and
            a disabled one would raise a question it can't answer. */}
        <div class="restore-slot">
          {s.backupPreview !== null ? (
            <div class="restore-row">
              <div class="restore-found">
                <strong>Backup found</strong> — {s.backupPreview.topics} topic
                {s.backupPreview.topics === 1 ? '' : 's'} and {s.backupPreview.items} stor
                {s.backupPreview.items === 1 ? 'y' : 'ies'}, saved {relativeTime(s.backupPreview.savedAt)}.
              </div>
              <button class="btn danger" type="button" data-action="restore-backup">
                {icon('database', 15)} Restore from backup
              </button>
              <p class="note">
                Replaces everything on this device with that snapshot. What you have now is saved to your data folder
                first. <strong>API keys aren’t in a backup</strong>, so you’ll re-enter them after — that’s expected,
                not a failed restore.
              </p>
            </div>
          ) : (
            ''
          )}
        </div>
        {/* Recovering a set-aside database (FR-33.2, NEWS-342). Always-present
            container so the panel doesn't restructure when one is found
            (docs/3-ui.md), and the eyebrow is *inside* the conditional
            (NEWS-307) — a "Recovery" heading over nothing is a question with no
            answer, and on essentially every install there is nothing here.

            Its own group rather than part of Backup: a backup is a snapshot the
            user asked for, and this is the database the app took away from
            them. Reading them as one thing would suggest the second is as
            routine as the first. */}
        <div class="recover-slot">
          {s.setAsideDatabases.length > 0 ? (
            <div>
              <h3 class="eyebrow">Recovery</h3>
              <p class="note">
                <strong>Newsmonger set {s.setAsideDatabases.length === 1 ? 'a database' : 'databases'} aside</strong>{' '}
                after failing to read {s.setAsideDatabases.length === 1 ? 'it' : 'them'} at startup. Nothing was
                deleted.
              </p>
              {s.setAsideDatabases.map((db) => (
                <div class="recover-row" data-key={db.file}>
                  <div class="recover-found">
                    <strong>Set aside {relativeTime(db.setAsideAt)}</strong>
                    {db.contents !== null
                      ? ` — ${String(db.contents.topics)} topic${db.contents.topics === 1 ? '' : 's'} and ${String(db.contents.items)} stor${db.contents.items === 1 ? 'y' : 'ies'} readable.`
                      : ' — still unreadable.'}
                    <br />
                    <code class="recover-path">{db.file}</code>
                  </div>
                  {db.contents !== null ? (
                    <button class="btn danger" type="button" data-action="recover-db" data-file={db.file}>
                      {icon('database', 15)} Recover this database
                    </button>
                  ) : (
                    /* No button, and the reason beside where it would be
                       (NEWS-309): a disabled control whose explanation is
                       elsewhere is the dead end this app keeps re-learning. */
                    <p class="field-hint">{db.error ?? 'It cannot be opened.'}</p>
                  )}
                </div>
              ))}
              <p class="note">
                Recovering replaces everything on this device with that database. What you have now is saved to your
                data folder first, and the set-aside file is left where it is.
              </p>
            </div>
          ) : (
            ''
          )}
        </div>
        {/* Progressive disclosure for the longest paragraph on the tab
            (NEWS-306). It answers a question most readers never ask — why the
            snapshot is a JSON file rather than the database — and answering it
            unprompted, at full width, between a control and the next section is
            what made this tab read as documentation.

            Its own class rather than `.advanced`, whose rule and margins are
            tuned for the Diagnostics block at the foot of a tab; sharing one is
            the splice NEWS-161's test exists to catch.

            **The old wording pointed at a dead end** (NEWS-309 §3). It said to
            put `newsmonger-backup.json` in an empty data folder as `data.json`
            and start the app. That is the legacy importer (FR-4.8a), and it runs
            **only into an empty database** — verified: dropping the file into a
            folder the app has already opened imports nothing at all, silently.
            Which is everyone doing a restore, since you have to run the app to
            discover you need one.

            It is also the exact trap FR-27.10 identified and replaced with a
            real Restore workflow, so the copy was still advertising the path
            that ticket exists to retire. It now points at the button. */}
        <details class="why">
          <summary>
            {icon('chevron', 12)}
            <span>Why isn’t the database itself backed up?</span>
          </summary>
          <p class="note">
            A live SQLite file inside a folder a sync client rewrites is a known way to corrupt it, so the database
            stays on this machine and the snapshot is a single JSON file instead. To restore one, point the folder
            above at it — <strong>Restore from backup</strong> appears here when a snapshot is found.
          </p>
        </details>

        {/* The feed URL as a field you can copy, not prose to select by hand
            (NEWS-309 §2). This group had no control at all — a heading over a
            paragraph containing the one string the whole section exists to hand
            over, which the reader was expected to drag-select out of a sentence.
            The dialog already had the clipboard pattern (`Copy diagnostics`).

            Read-only rather than disabled: a disabled input is unfocusable and
            unselectable, so keyboard and screen-reader users would lose the very
            thing this section is for. Read-only still takes focus, still selects,
            and `select()` on focus makes one click enough without the button. */}
        <h3 class="eyebrow">Feed</h3>
        <div class="feed-url">
          <input
            type="text"
            class="feed-url-input"
            data-action="feed-url"
            readOnly={true}
            value={`${location.origin}/feed.xml`}
            aria-label="Atom feed URL"
            spellCheck="false"
          />
          <button class="btn subtle" type="button" data-action="copy-feed-url">
            Copy
          </button>
        </div>
        <p class="field-hint">
          Subscribe in any feed reader; add <code>?scope=saved</code> for bookmarks only. It works from this
          machine — the app listens on localhost, so a reader on another device can’t reach it.
        </p>

        {/* Clear all stories (NEWS-255). Stories only — topics, settings and
            keys all stay, which is what the label has to convey, because
            "clear data" beside a backup control reads like a factory reset.

            Its own group at the foot of the tab (NEWS-304). It used to sit
            *inside* Backup, between the "point this at an iCloud Drive…"
            paragraph and the "the database stays on this machine" one — two
            paragraphs about backup with an irreversible delete wedged between
            them. That cost both directions at once: nobody scans a BACKUP
            heading looking for how to wipe their stories, and anyone reading
            about backup met a destructive button whose meaning had to come
            entirely from its own four words.

            "Reset" rather than "Danger zone": the group holds one action, and
            that action explicitly keeps your topics, settings and keys. Reset
            is what someone hunting for it would scan for, and the `danger`
            variant on the button carries the warning the eyebrow would be
            overstating. */}
        <h3 class="eyebrow">Reset</h3>
        {/* Two buttons, side by side and equal halves (NEWS-328), like every
            other pair on this tab (FR-3.72). They are the two things you can
            throw away, and a reader deciding between them wants to see both. */}
        <div class="io-row">
          <button class="btn danger" type="button" data-action="clear-stories" disabled={s.feedTotal === 0}>
            {icon('clear', 15)} Delete all stories
          </button>
          {/* **Delete**, not Clear (NEWS-328). "Clear all stories" reads as
              tidying — emptying a view — and this removes them from the
              database. The two controls also had to agree with each other: one
              called Clear beside one called Delete would imply a difference in
              severity that does not exist. */}
          <button class="btn danger" type="button" data-action="clear-topics" disabled={s.topics.length === 0}>
            {icon('delete', 15)} Delete all topics
          </button>
        </div>
        {/* Note weight, not hint (NEWS-306): the bold clause answers the fear
            both controls raise — "does this take my settings and keys too" —
            and it is the promise both confirm dialogs make.

            One sentence for two buttons, not two. The Data tab has six groups to
            Schedule's two, so its prose budget is tight (NEWS-306's ratio), and
            the detail each control needs is in the dialog it opens, where the
            decision is actually made. */}
        <p class="note">
          {s.feedTotal === 0 && s.topics.length === 0 ? 'Nothing to delete yet.' : ''} Deleting topics takes their
          stories with them. <strong>Your settings and API keys stay</strong>, and neither can be undone.
        </p>

        </div>
      );
    case 'app':
      return (
        <div>
        <h3 class="eyebrow">Notifications</h3>
        <label class="field checkbox-field">
          <input
            type="checkbox"
            data-action="notify-toggle"
            checked={s.settings.notifyOnNewItems ? true : undefined}
          />
          <span>Notify me when new stories arrive while Newsmonger isn’t focused</span>
        </label>
        {/* Always-present slot for the permission note (KF-377). */}
        <div class="notify-note">
          {s.notifyPermissionDenied ? notifyBlockedNoteJsx() : ''}
        </div>
        {/* Appearance (FR-3.74, NEWS-334). Its own group rather than a line in
            Notifications: it is the only thing on this tab about how the app
            *looks*, and folding it under a heading about alerts is how the
            anonymous clusters NEWS-307 unpicked came about in the first place. */}
        <h3 class="eyebrow">Appearance</h3>
        <label class="field">
          <span>Theme</span>
          <select data-action="theme">
            {THEME_OPTIONS.map((o) => (
              <option value={o.value} selected={o.value === s.settings.theme ? true : undefined}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <p class="field-hint">Auto follows your system, and keeps following it as it changes.</p>
        {/* "Show the setup guide again" was inside the notifications cluster
            with nothing to do with it (NEWS-307). Its own group, because the
            alternative — folding it under Notifications — is what made the
            anonymous cluster look deliberate in the first place. */}
        <h3 class="eyebrow">Setup</h3>
        <p class="note">
          <button class="btn subtle" type="button" data-action="rerun-onboarding">
            Show the setup guide again
          </button>
        </p>
        {/* Updates (NEWS-89). Desktop-only: the browser build is served by a
            server the user already controls, so there is no app binary here to
            replace and the button would be a lie. Always-present slot so the
            result line is announced when it arrives (see #banners, NEWS-99).

            The eyebrow is *inside* the conditional (NEWS-307): a heading left
            outside it would render over nothing in the browser build, which is
            the same defect NEWS-309 reports for DIAGNOSTICS. */}
        {isTauri() ? (
          <div class="update-check">
            <h3 class="eyebrow">Updates</h3>
            <button
              class="btn subtle"
              type="button"
              data-action="check-updates"
              disabled={s.updateChecking}
            >
              {s.updateChecking ? 'Checking…' : 'Check for updates'}
            </button>
            <div class="update-check-note" role="status" aria-live="polite">
              {s.updateCheckMessage !== null ? <p class="note">{s.updateCheckMessage}</p> : ''}
            </div>
          </div>
        ) : (
          ''
        )}
        {/* Collapsed by default (NEWS-120): a bug-report bundle is an advanced,
            rarely-used tool, and an always-open run log is the loudest thing on
            a settings screen while being the least often wanted. Inside the App
            tab *and* collapsed, so it takes two deliberate steps — but it stays
            nameable in support ("open Settings → App and expand Diagnostics")
            rather than hidden behind a gesture nobody can be talked through. */}
        </div>
      );
  }
}

export function settingsDialogJsx(): SafeHtml {
  const s = appStore.state.value;

  return (
    <div class="dialog-backdrop" data-action="settings-backdrop">
      {/* `settings-dialog`, its own class (NEWS-309): this is the one dialog
          whose content can outgrow the viewport — Data measures 982px against a
          900px window — and it needs a bounded height with the *panel* scrolling
          inside it. Scoped rather than added to `.dialog`, which every other
          dialog shares and none of which needs this (docs/3-ui.md on preferring
          a new block; NEWS-161's test exists because a shared selector once gave
          the export button a box's padding). */}
      <div class="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div class="dialog-head">
          <h2 id="settings-title">Settings</h2>
          <button class="btn icon" type="button" data-action="close-settings" aria-label="Close settings">
            {icon('clear', 17)}
          </button>
        </div>

        {settingsTabsJsx(s.settingsTab)}
        <div class="settings-panel" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${s.settingsTab}`}>
          {settingsPanelJsx(s)}
        </div>
      </div>
    </div>
  );
}
