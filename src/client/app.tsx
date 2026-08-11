import type { SafeHtml } from 'kerfjs';
import { delegate, each, effect, mount } from 'kerfjs';

import type { Effort,ProviderName  } from '../ai/types.js';
import { PROVIDER_MODELS } from '../ai/types.js';
import type { NewsItem } from '../db/schemas.js';
import { topicsForProfiles } from '../profile-topics.js';
import { PROFILE_PAGE_COUNT } from '../profiles.js';
import {
  addSuggestedTopic,
  addTopic,
  backupNow,
  clearAllStories,
  countItemsForTopic,
  deleteAllTopics,
  deleteKey,
  deleteTopic,
  discoverTopics,
  dismissBackupPrompt,
  dismissQuarantine,
  fetchBackupLocations,
  importStories,
  importTopics,
  loadPulseDetail,
  loadThread,
  recoverSetAside,
  refreshBackupPreview,
  refreshFeed,
  refreshKeys,
  refreshModels,
  refreshProviders,
  refreshPulseSurfaces,
  refreshSetAside,
  refreshState,
  renameTopic,
  reportForeground,
  restoreBackup,
  restoreClearedItems,
  saveKey,
  setItemOffTopic,
  setItemSaved,
  setNotifyOnNewItems,
  setTopicGuidance,
  setTopicHighPriority,
  setTopicPaused,
  startCheck,
  updateBackupDir,
  updateConcurrency,
  updateDailyTimes,
  updateHighPriorityInterval,
  updateInterval,
  updateLocation,
  updateProfiles,
  updateProviderSettings,
  updateRetention,
  updateScheduleMode,
  updateTheme,
} from './api.js';
import { shouldOfferBackup, snoozeUntil } from './backup-prompt.js';
import { relativeTime } from './dates.js';
import { backupOfferJsx, exportDialogJsx, guidanceDialogJsx, privacyDialogJsx, renameDialogJsx } from './dialogs.js';
import type { TunerState } from './discover.js';
import {
  judgeCandidate,
  mergeKept,
  nextRound,
  startTuner,
} from './discover.js';
import {
  recordDuration,
} from './discover-progress.js';
import { discoverDialogJsx } from './discover-view.js';
import { correctedEffort } from './effort-options.js';
import { currentFailure } from './failure.js';
import { feedJsx, itemMenuJsx } from './feed.js';
import { filterBarJsx } from './filter-bar.js';
import { icon } from './icons.js';
import { correctedModel } from './model-choice.js';
import { ensureNotificationPermission } from './notifications.js';
import { nextProfilePage, shouldOpenOnboarding } from './onboarding.js';
import { onboardingJsx } from './onboarding-view.js';
import { browserPollDeps, startPolling as startStatePolling } from './poll.js';
import { compactTopicPulseJsx, pulseDialogJsx } from './pulse-view.js';
import { trackRailTop } from './rail.js';
import { activeBehindWarnings } from './schedule.js';
import { itemMatchesQuery } from './search.js';
import { syncSelects } from './select-sync.js';
import { settingsDialogJsx } from './settings.js';
import { shareItem } from './share.js';
import { toggleSolo, transferSingleSolo } from './solo.js';
import type { AppState, DiscoverSource, OnboardingStep, ToastState } from './stores.js';
import {
  appStore,
  FEED_PAGE,
  ONBOARDING_STEPS,
  readOnboardingSeen,
  STARTER_TOPICS,
  TOPIC_SORT_LABELS,
  TOPIC_SORTS,
  writeOnboardingSeen,
} from './stores.js';
import { getTauriInvoke, openExternalUrl } from './tauri.js';
import type { TopicRow } from './topic-sort.js';
import { isHeading, sortTopics, topicRowCacheKey, topicRows } from './topic-sort.js';
import { contextMenuJsx, topicRowJsx } from './topics-view.js';
import { updateCheckFailure } from './update.js';


/** How long a toast stays up before it fades out on its own. */
const TOAST_MS = 2600;
/**
 * How long a toast that offers an **undo** stays up (NEWS-145).
 *
 * Longer than a plain one, because the two ask different things of the reader.
 * A plain toast only has to be *noticed*; this one has to be read, understood as
 * reversible, and acted on with the mouse. 2.6s is enough for the first and not
 * the second, and a window that expires mid-reach is worse than no undo at all —
 * it teaches that the affordance is unreliable.
 *
 * Comfortably inside the server's `UNDO_TTL_MS`, so the button is never on
 * screen after the snapshot behind it has gone.
 */
const UNDO_TOAST_MS = 9000;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Delays before each poll of `get_pending_update` at startup (NEWS-89).
 *
 * The shell's update check is spawned, not awaited, so at the moment the client
 * loads the answer usually isn't in yet. Poll a few times with growing gaps
 * instead of a fixed interval: if the check already finished the first read
 * catches it for free, and a slow network gets ~13s to answer before we stop
 * asking. Giving up is fine — the Settings check is always there, and the next
 * launch checks again.
 */
const UPDATE_POLL_DELAYS_MS = [0, 3000, 10_000];

/** Debounce for the server-side feed search refetch (NEWS-76). */
const SEARCH_DEBOUNCE_MS = 250;
let searchDebounce: ReturnType<typeof setTimeout> | undefined;

/** Show a transient bottom-of-screen notice, replacing any current one. */
/**
 * Show a message that dismisses itself.
 *
 * The **only** sanctioned way to raise a toast: the store's `setToastRaw` has
 * no timer, so anything calling it directly leaves the message on screen for
 * good — which is exactly what shipped in NEWS-141.
 */
function showToast(message: string): void {
  raiseToast({ message, undoTopicId: null }, TOAST_MS);
}

/** Show a message with an Undo for a topic's just-cleared stories (NEWS-145). */
function showUndoToast(message: string, topicId: string): void {
  raiseToast({ message, undoTopicId: topicId }, UNDO_TOAST_MS);
}

function raiseToast(toast: ToastState, ms: number): void {
  appStore.actions.setToastRaw(toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    appStore.actions.setToastRaw(null);
  }, ms);
}





/**
 * In-app confirmation dialog. Replaces `window.confirm`, which is a silent
 * no-op in the Tauri WKWebView — a native confirm returns falsy without ever
 * showing, so every guarded action (delete a topic, remove a key) quietly did
 * nothing in the desktop app. This works identically in a browser and in Tauri.
 */
function confirmDialogJsx(c: NonNullable<AppState['confirm']>): SafeHtml {
  return (
    <div class="dialog-backdrop" data-action="confirm-backdrop">
      <div class="dialog confirm" role="alertdialog" aria-modal="true" aria-label="Confirm">
        <p class="confirm-message">{c.message}</p>
        <div class="confirm-actions">
          <button class="btn" type="button" data-action="confirm-cancel">
            Cancel
          </button>
          <button class={`btn ${c.danger ? 'danger-solid' : 'primary'}`} type="button" data-action="confirm-ok">
            {c.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Show the confirmation dialog and resolve with the user's choice.
 *
 * The resolver lives at module scope rather than in the store: it's a callback,
 * not renderable state, and only ever one dialog is open. Opening a second
 * before the first resolves cancels the first, so no promise is left dangling.
 */
let confirmResolver: ((ok: boolean) => void) | null = null;

function confirm(message: string, opts: { confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  confirmResolver?.(false);
  appStore.actions.openConfirm({
    message,
    confirmLabel: opts.confirmLabel ?? 'OK',
    danger: opts.danger ?? false,
  });
  return new Promise<boolean>((resolve) => {
    confirmResolver = resolve;
  });
}

function resolveConfirm(ok: boolean): void {
  appStore.actions.closeConfirm();
  const resolve = confirmResolver;
  confirmResolver = null;
  resolve?.(ok);
}

/**
 * What fills the feed panel when there is nothing to show (NEWS-433).
 *
 * The feed used to render *nothing at all* here — a bare dark panel beside a
 * sidebar that carried the only message. Someone who skipped setup landed on a
 * screen that looked broken and gave them no way back in.
 *
 * Four shapes, and the split matters:
 *  - **No topics** — the welcome hero: what the app does, the setup guide (which
 *    was otherwise reachable only through Settings), and a row of popular topics
 *    as one-click adds. This is the "I skipped setup, now what?" case the ticket
 *    is about, so it does the most.
 *  - **Topics but no stories** — reassurance that a check will fill the panel,
 *    the button to run one now, and the setup guide still within reach.
 *  - **A sub-filter that matched nothing** (search / saved / review) — the plain
 *    line it always had. A hero here would shout at a routine empty result and
 *    bury the one fact that matters (nothing matched *this* filter).
 *
 * Every action here is already wired at the root: `rerun-onboarding`,
 * `check-all`, `open-discover`, and `data-foryou-topic` (a plain `addTopic`).
 */
function feedEmptyStateJsx(s: AppState, reviewMode: boolean, searching: boolean): SafeHtml {
  if (reviewMode) return <p class="empty">No flagged stories for these topics.</p>;
  if (searching) return <p class="empty">No stories match your search.</p>;
  if (s.savedFilter) {
    return <p class="empty">No saved stories yet. Use the bookmark button on a story to keep it here.</p>;
  }

  const setupGuide = (
    <button class="btn subtle" type="button" data-action="rerun-onboarding">
      {icon('guidance', 15)} Show the setup guide
    </button>
  );

  if (s.topics.length > 0) {
    return (
      <div class="feed-empty">
        <div class="feed-empty-badge">{icon('bell', 26)}</div>
        <h2>No stories yet</h2>
        <p class="feed-empty-lead">
          Your topics are set. The next scheduled check lands new stories here — only what is genuinely new,
          never a repeat. You can also check now to look right away.
        </p>
        <div class="feed-empty-actions">
          <button class="btn primary" type="button" data-action="check-all">
            Check all now
          </button>
          {setupGuide}
        </div>
      </div>
    );
  }

  return (
    <div class="feed-empty">
      <div class="feed-empty-badge">{icon('search', 26)}</div>
      <h2>Nothing to watch yet</h2>
      <p class="feed-empty-lead">
        Name a topic and Newsmonger keeps up with it for you — asking an AI with live web search, on your
        schedule, and showing only what has genuinely changed. Add one from the sidebar, or start from the
        setup guide.
      </p>
      <div class="feed-empty-actions">
        {setupGuide}
        <button class="btn subtle" type="button" data-action="open-discover">
          {icon('grid', 15)} Discover topics
        </button>
      </div>
      <div class="feed-empty-suggest">
        <span class="eyebrow">Popular topics</span>
        <div class="feed-empty-chips">
          {STARTER_TOPICS.map((name) => (
            <button class="chip starter" type="button" data-foryou-topic={name}>
              {name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}


function appJsx(): SafeHtml {
  const s = appStore.state.value;
  const topicNames = new Map(s.topics.map((t) => [t.id, t.name]));
  const solo = new Set(s.soloTopicIds);
  const selected = new Set(s.selectedTopicIds);
  // The feed page is filtered + sorted + paginated by the server for the active
  // view (NEWS-76). Review mode shows ONLY the flagged stories for its topics.
  const reviewMode = s.reviewTopicIds.length > 0;
  const searching = s.searchQuery.trim() !== '';
  const feedVariant: 'normal' | 'review' = reviewMode ? 'review' : 'normal';
  // In the normal view the server excludes off-topic stories, so merge in any
  // flagged *this session* — collapsed, and only if they match the active
  // Solo/Saved/Search — so a misclick stays undoable until reload (NEWS-61).
  let feedItems = s.feedItems;
  if (!reviewMode && s.recentlyFlaggedItems.length > 0) {
    const seen = new Set(s.feedItems.map((i) => i.id));
    const overlay = s.recentlyFlaggedItems.filter(
      (it) =>
        !seen.has(it.id) &&
        (solo.size === 0 || solo.has(it.topicId)) &&
        (!s.savedFilter || it.saved) &&
        itemMatchesQuery(it, topicNames.get(it.topicId) ?? '', s.searchQuery),
    );
    if (overlay.length > 0) {
      feedItems = [...s.feedItems, ...overlay].sort((a, b) => b.foundAt.localeCompare(a.foundAt));
    }
  }
  // "Show more" reflects what the *server* still holds for this view (the
  // session overlay is separate and always shown).
  const moreCount = Math.max(0, s.feedTotal - s.feedItems.length);
  const savedCount = s.feedTotal; // meaningful only while the Saved filter is on
  // Resolved from server state, so a topic deleted while its dialog is open
  // simply closes it rather than rendering a stale name.
  const guidanceTarget = s.topics.find((t) => t.id === s.guidanceTopicId);
  const renameTarget = s.topics.find((t) => t.id === s.renameTopicId);
  const anyChecking = s.checking.length > 0;
  // Only warn about a topic whose *latest* run failed — not a stale failure from
  // one that has since recovered (NEWS-41).
  const lastFailure = currentFailure(s.runs);
  // Topics whose real cadence has fallen well behind the interval the user set
  // (NEWS-59). Informational only — the scheduler already cycles as fast as it
  // can; this just explains why freshness may lag.
  const behind = activeBehindWarnings(
    s.topics,
    s.settings,
    Date.now(),
    s.behindGraceUntil,
    Date.parse(s.checksPossibleSince),
  );

  return (
    <div class={`shell${s.sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <header class="app-header">
        <div class="header-left">
          <button
            class="btn icon"
            data-action="toggle-sidebar"
            aria-expanded={s.sidebarCollapsed ? 'false' : 'true'}
            aria-controls="topics-panel"
            aria-label={s.sidebarCollapsed ? 'Show topics' : 'Hide topics'}
            title={s.sidebarCollapsed ? 'Show topics' : 'Hide topics'}
          >
            {icon('panel', 17)}
          </button>
          {/* The wordmark is the brand asset, not styled text (NEWS-175).
              Both marks ship and CSS shows one (NEWS-377).

              This was a `<picture>` swapping on `prefers-color-scheme`, whose
              comment said the app "has no manual theme toggle" — true when it
              was written, and untrue from NEWS-334. A `media` attribute can
              only ask the *system* preference, so pinning the app to light on a
              dark OS kept serving the white-ink mark onto porcelain, where the
              word "News" simply vanished.

              The resolved theme is a CSS fact — `prefers-color-scheme` unless
              `data-theme` overrides it — so the choice belongs in the
              stylesheet beside the other `dark-*` mixins that already encode
              it, not in an attribute that cannot see the override. Still no JS
              and still no flash: both are static and one is hidden.

              Both images are decorative; the accessible name is on the <h1>, so
              it survives whichever mark is display:none. */}
          <h1 class="wordmark" aria-label="Newsmonger">
            <img class="mark-light" src="/static/wordmark-light.svg" alt="" width="480" height="100" />
            <img class="mark-dark" src="/static/wordmark-dark.svg" alt="" width="480" height="100" />
          </h1>
        </div>
        <div class="header-controls">
          {/* Small by design; grows on focus or when it has a query (NEWS-60).
              Clear button is always rendered and shown via CSS so the input's
              siblings never restructure (kerf morph safety). */}
          {/* The icon is a `<label>` so that clicking it focuses the input
              natively (NEWS-267). Below 860px the field collapses to just this
              icon, and a collapsed pill has to be clickable to be usable —
              `for=` does that with no delegate, no handler, and no kerf rule to
              get wrong. */}
          <div class={`search${searching ? ' has-query' : ''}`}>
            <label class="search-icon" for="search-input">
              {icon('search', 16)}
            </label>
            <input
              id="search-input"
              type="text"
              class="search-input"
              placeholder="Search stories"
              aria-label="Search stories"
              data-action="search"
            />
            <button class="search-clear" type="button" data-action="clear-search" aria-label="Clear search">
              {icon('clear', 14)}
            </button>
          </div>
          <button
            class={`btn icon${s.savedFilter ? ' active' : ''}`}
            data-action="toggle-saved-filter"
            aria-pressed={s.savedFilter ? 'true' : 'false'}
            aria-label={s.savedFilter ? 'Show all stories' : 'Show saved stories'}
            title={s.savedFilter ? 'Showing saved — click to show all' : 'Show saved only'}
          >
            {icon('bookmark', 17)}
          </button>
          <button class="btn icon" data-action="open-settings" aria-label="Settings" title="Settings">
            {icon('settings', 17)}
          </button>
          <button
            class="btn primary"
            data-action="check-all"
            disabled={anyChecking ? true : undefined}
            aria-live="polite"
          >
            {anyChecking ? 'Checking…' : 'Check all now'}
          </button>
        </div>
      </header>

      {/* Always-present container — the dialog appearing must not restructure
          its siblings (kerf KF-377 — see docs/3-ui.md). */}
      <div id="onboarding-slot">{s.onboarding !== null && s.onboarding !== 'auto' ? onboardingJsx(s.onboarding) : ''}</div>
      {/* Always-present container, like the other dialog slots (docs/3-ui.md). */}
      <div id="backup-offer-slot">{s.backupOffer !== null ? backupOfferJsx(s.backupOffer) : ''}</div>
      <div id="settings-slot">{s.settingsOpen ? settingsDialogJsx() : ''}</div>
      <div id="menu-slot">{s.contextMenu !== null ? contextMenuJsx(s.contextMenu, s.topics) : ''}</div>
      <div id="item-menu-slot">{s.itemMenu !== null ? itemMenuJsx(s.itemMenu, feedAndFlagged()) : ''}</div>
      <div id="confirm-slot">{s.confirm !== null ? confirmDialogJsx(s.confirm) : ''}</div>
      <div id="guidance-slot">{guidanceTarget !== undefined ? guidanceDialogJsx(guidanceTarget) : ''}</div>
      <div id="rename-slot">
        {renameTarget === undefined
          ? ''
          : renameDialogJsx(renameTarget, s.renameItemCount, s.renameCategory, s.renameSubcategory)}
      </div>
      <div id="privacy-slot">{s.privacyOpen ? privacyDialogJsx(s) : ''}</div>
      <div id="pulse-slot">{s.pulseDetailOpen ? pulseDialogJsx(s.pulseDetail, s.pulseLoading, s.pulseDays) : ''}</div>
      <div id="export-slot">{s.export !== null ? exportDialogJsx(s.export, sortTopics(s.topics, s.topicSort, s.newestItemAtByTopic)) : ''}</div>
      <div id="discover-slot">{s.discover !== null ? discoverDialogJsx(s.discover) : ''}</div>
      {/* Always present because it is a **live region**: assistive technology
          announces mutations to a region it is already observing, so a slot
          created in the same render as its own text has nothing watching it and
          the announcement is lost. (It also predates kerf 3.0.0, where it
          doubled as a KF-377 workaround — that reason is gone; this one isn't.
          See docs/3-ui.md, NEWS-99.) */}
      <div id="toast-slot" aria-live="polite">
        {s.toast !== null ? (
          <div class={`toast ${s.toast.undoTopicId !== null ? 'actionable' : ''}`}>
            <span>{s.toast.message}</span>
            {/* One attribute, one delegate — the id rides on the attribute rather
                than being read back out of the store, so a toast replaced mid-click
                cannot undo the wrong topic (see docs/3-ui.md). */}
            {s.toast.undoTopicId !== null ? (
              <button class="toast-undo" type="button" data-undo-clear={s.toast.undoTopicId}>
                Undo
              </button>
            ) : (
              ''
            )}
          </div>
        ) : (
          ''
        )}
      </div>

      {/* Section navigation sits directly under the masthead, as a newspaper's
          does — above the banners and above the sidebar+feed area (FR-22.10). */}
      <div id="filter-slot">{filterBarJsx(s.categoryFilter, s.topics, s.categoryPulse)}</div>

      {/* Banners appear in response to background events (a failed check, a
          a failing topic), so they have to announce rather than wait to be found —
          which is why the container is always present. A live region has to
          exist *before* its content for the announcement to happen at all.
          (Also a KF-377 workaround once; that reason expired in kerf 3.0.0 and
          this one did not. See docs/3-ui.md, NEWS-99.) */}
      <div id="banners" role="status" aria-live="polite">
        {/* First, and above every other banner: it is the only account the user
            gets of why their topics are missing (NEWS-340). A notice about
            possible data loss outranks a filter chip. */}
        {s.quarantine !== null ? (
          <div class="banner error">
            <span class="banner-text">
              This app's database could not be read on {new Date(s.quarantine.at).toLocaleDateString()}, so it
              started with an empty one. <strong>Nothing was deleted</strong> — a copy of the old database is
              saved at <code class="banner-path">{s.quarantine.backupPath}</code>. You can try to get it back in
              Settings → Data → Recovery.
            </span>
            <button class="banner-dismiss" type="button" data-action="dismiss-quarantine" aria-label="Dismiss">
              {icon('clear', 15)}
            </button>
          </div>
        ) : (
          ''
        )}
        {s.savedFilter ? (
          <div class="banner saved">
            {icon('bookmark', 14)}
            <span class="banner-text">
              Showing {String(savedCount)} saved {savedCount === 1 ? 'story' : 'stories'}
            </span>
            {/* `btn` for the same reason as the review and tuner exits
                (NEWS-266) — this is a mode exit, and promoting only some of them
                would leave the app less coherent than leaving them all alone. */}
            <button class="btn" type="button" data-action="clear-saved-filter">
              Show all
            </button>
          </div>
        ) : (
          ''
        )}
        {solo.size > 0 ? (
          <div class="banner solo">
            {icon('solo', 14)}
            <span>
              Showing {String(solo.size)} of {String(s.topics.length)} topics
            </span>
            <button class="btn" type="button" data-action="clear-solo">
              Show all
            </button>
          </div>
        ) : (
          ''
        )}
        {s.error !== null ? (
          <div class="banner error">
            <span class="banner-text">{s.error}</span>
            <button class="banner-dismiss" type="button" data-action="dismiss-error" aria-label="Dismiss">
              {icon('clear', 15)}
            </button>
          </div>
        ) : (
          ''
        )}
        {lastFailure !== null && s.error === null && lastFailure.id !== s.dismissedRunId ? (
          <div class="banner warn">
            <span class="banner-text">
              Last check for “{topicNames.get(lastFailure.topicId) ?? 'deleted topic'}” failed:{' '}
              {lastFailure.error ?? 'unknown error'}
            </span>
            <button
              class="banner-dismiss"
              type="button"
              data-action="dismiss-warn"
              data-run-id={lastFailure.id}
              aria-label="Dismiss"
            >
              {icon('clear', 15)}
            </button>
          </div>
        ) : (
          ''
        )}
        {s.updateVersion !== null && !s.updateDismissed ? (
          <div class="banner update">
            {icon('download', 14)}
            <span class="banner-text">
              {s.updateInstall === 'installed'
                ? `Newsmonger ${s.updateVersion} is installed — restart to start using it.`
                : `Newsmonger ${s.updateVersion} is available.`}
            </span>
            {/* Always-present slot: the Install button goes away once the update
                is on disk, and a conditional element *between* siblings is the
                shape docs/3-ui.md rules out — the E2E suite runs with
                `invariants: 'throw'`, so it fails the render outright. */}
            <div class="update-actions">
              {s.updateInstall === 'installed' ? (
                ''
              ) : (
                <button
                  class="btn subtle"
                  type="button"
                  data-action="install-update"
                  disabled={s.updateInstall === 'installing'}
                >
                  {s.updateInstall === 'installing'
                    ? 'Installing…'
                    : s.updateInstall === 'failed'
                      ? 'Install failed — retry'
                      : 'Install'}
                </button>
              )}
            </div>
            <button class="banner-dismiss" type="button" data-action="dismiss-update" aria-label="Dismiss">
              {icon('clear', 15)}
            </button>
          </div>
        ) : (
          ''
        )}
        {behind.length > 0 && !s.dismissedBehind ? (
          <div class="banner warn">
            <span class="banner-text">
              Checks are falling behind your schedule — {String(behind.length)}{' '}
              {behind.length === 1 ? 'topic is' : 'topics are'} refreshing slower than the interval you picked. Try
              fewer topics, a longer interval, or a faster provider.
            </span>
            <button class="banner-dismiss" type="button" data-action="dismiss-behind" aria-label="Dismiss">
              {icon('clear', 15)}
            </button>
          </div>
        ) : (
          ''
        )}
        {reviewMode ? (
          <div class="banner review">
            {icon('flag', 14)}
            <span class="banner-text">
              Reviewing {String(s.feedTotal)} flagged {s.feedTotal === 1 ? 'story' : 'stories'}
              {s.reviewTopicIds.length === 1
                ? ` for ${topicNames.get(s.reviewTopicIds[0] ?? '') ?? 'a topic'}`
                : ''}
            </span>
            {/* `btn`, not `btn subtle` (NEWS-266). `.btn.subtle` was then
                `background: none; border-color: transparent`, so at rest it was
                indistinguishable from the sentence beside it and only grew a
                border on hover. That is the wrong weight for the **only way out
                of a mode that filters the whole feed**: the reversible in-mode
                actions looked pressable and the consequential exit looked like a
                caption. NEWS-305 fixed the variant, but the weight argument is
                unchanged — an exit outranks the quiet variant. */}
            <button class="btn" type="button" data-action="exit-review">
              Exit review
            </button>
          </div>
        ) : (
          ''
        )}
      </div>

      {/* Always rendered, hidden via CSS when collapsed. The header's toggle
          carries aria-controls="topics-panel", so unmounting this would leave
          that attribute pointing at nothing — verified: doing so fails
          a11y.spec.ts on an axe `aria-valid-attr-value` violation. Collapsing
          also sets aria-hidden here, which a removed element cannot express.
          (Originally the KF-377 workaround too; see docs/3-ui.md, NEWS-99.) */}
      <section id="topics-panel" class="topics-panel" aria-hidden={s.sidebarCollapsed ? 'true' : undefined}>
        <div class="topics-head">
          <h2 class="eyebrow">Watching</h2>
          {s.topics.length > 1 ? (
            <select class="sort-select" data-action="topic-sort" aria-label="Sort topics">
              {TOPIC_SORTS.map((opt) => (
                <option value={opt} selected={opt === s.topicSort ? true : undefined}>
                  {TOPIC_SORT_LABELS[opt]}
                </option>
              ))}
            </select>
          ) : (
            ''
          )}
        </div>
        {/* A multi-select listbox: rows are the options, so a screen reader
            announces selection state and roving focus works (NEWS-90). */}
        <ul class="topics" role="listbox" aria-multiselectable="true" aria-label="Topics">
          {each(
            topicRows(s.topics, s.topicSort, s.newestItemAtByTopic),
            (row) =>
              isHeading(row) ? (
                // `role="presentation"` because a listbox may only contain
                // options: a heading that claimed to be one would be selectable
                // to a screen reader and would fail the axe suite.
                <li class="topic-section" role="presentation" data-key={row.key}>
                  {row.label}
                </li>
              ) : (
                topicRowJsx(
                  row,
                  s.checking.includes(row.id),
                  row.highPriority ? s.settings.highPriorityIntervalMs : s.settings.checkIntervalMs,
                  selected.has(row.id),
                  solo.has(row.id),
                  solo.size > 0 && !solo.has(row.id),
                  selected.size === 1 && selected.has(row.id),
                  s.todayByTopic[row.id] ?? 0,
                  // `Object.hasOwn`, not `!== undefined`: the record is typed
                  // `Record<string, string>` (no `noUncheckedIndexedAccess`), so
                  // the comparison reads as impossible to the linter while being
                  // exactly the question. Same trap as NEWS-264.
                  Object.hasOwn(s.newestItemAtByTopic, row.id),
                  s.pulseSparklines[row.id],
                )
              ),
            {
              // `each()` memoizes per row, and everything a row renders that
              // does not live on the topic object has to be in this key —
              // selection, solo, checking, today's count. So does the row's own
              // identity, which is the half that was missing (NEWS-238): see
              // `topicRowCacheKey`, where the rule and the bug are written down
              // and the uniqueness property is a unit test.
              cacheKey: (row: TopicRow) =>
                topicRowCacheKey(row, {
                  selected,
                  solo,
                  checking: s.checking,
                  todayByTopic: s.todayByTopic,
                  newestItemAtByTopic: s.newestItemAtByTopic,
                  pulseSparklines: s.pulseSparklines,
                }),
              // A stable list identity (kerf 3.x). Unkeyed lists are identified by
              // their position among a render's `each()` calls, so a conditional
              // list appearing above this one would rebuild it and cost the rows
              // their focus and scroll. This is the only `each()` in the app today
              // — the feed uses `.map()` — so the position can't currently shift;
              // the key means adding a second list later can't silently break this
              // one either.
              key: 'topics',
            },
          )}
        </ul>
        <div class="empty-slot">
          {s.loaded && s.topics.length === 0 ? (
            <p class="empty">Nothing is being watched yet. Add a topic below — Newsmonger checks it on your schedule and reports only what's new.</p>
          ) : (
            ''
          )}
        </div>
        <form class="add-topic" data-action="add-topic-form">
          <input
            type="text"
            name="topic-name"
            placeholder="Watch a topic — “solid-state batteries”"
            autocomplete="off"
            data-morph-skip-children
          />
          <button class="btn" type="submit">
            Add
          </button>
          <button
            class="btn icon discover-open"
            type="button"
            data-action="open-discover"
            aria-label="Discover topics"
            title="Discover topics"
          >
            {icon('grid')}
          </button>
        </form>
        {/* Privacy sits at the foot of the rail rather than the foot of the page
            (NEWS-138). The rail is sticky, so it stays in reach; the page footer
            meant scrolling past the entire feed to find it. */}
        <div class="rail-foot">
          <button class="btn link" type="button" data-action="open-privacy">
            {icon('shield', 13)}
            <span>Privacy</span>
          </button>
        </div>
      </section>

      <section id="feed" class="feed">
        <div class="compact-pulse-slot">{solo.size === 1 && s.topicPulse !== null ? compactTopicPulseJsx(s.topicPulse) : ''}</div>
        {feedJsx(feedItems, topicNames, feedVariant, s.expandedItemId, {
          summaries: s.threads,
          panes: s.threadPanes,
          showAll: s.threadShowAll,
        })}
        <div class="empty-slot">
          {s.loaded && feedItems.length === 0 ? feedEmptyStateJsx(s, reviewMode, searching) : ''}
        </div>
        {/* Always-present slot so the button appearing can't shift a keyed list
            above it (kerf KF-377). */}
        <div class="show-more-slot">
          {moreCount > 0 ? (
            <button class="btn show-more" type="button" data-action="show-more">
              Show {String(Math.min(moreCount, FEED_PAGE))} more
              {moreCount > FEED_PAGE ? ` (${String(moreCount)} left)` : ''}
            </button>
          ) : (
            ''
          )}
        </div>
      </section>

      {/* Privacy normally lives at the foot of the sidebar (NEWS-138). The
          sidebar is `display: none` when collapsed, so the page footer remains
          as the fallback for that one state — always present as a container so
          it can't restructure its siblings, but only filled when it is the only
          way to reach the dialog. */}
      <footer class="app-footer">
        {s.sidebarCollapsed ? (
          <button class="btn link" type="button" data-action="open-privacy">
            {icon('shield', 13)}
            <span>Privacy</span>
          </button>
        ) : (
          ''
        )}
      </footer>
    </div>
  );
}


/** Anchor for shift-range selection — the last row clicked without shift. */
let anchorId: string | null = null;

/** Preserve double-click's additive toggle when its first click transferred solo. */
let clickSoloTransfer: { id: string; prior: string[] } | null = null;

function selectTopic(id: string, mods: { toggle: boolean; range: boolean }): void {
  const { topics, selectedTopicIds, topicSort } = appStore.state.value;
  if (mods.range && anchorId !== null) {
    // Range is over the *displayed* order, which the sort determines (NEWS-63).
    const ids = sortTopics(topics, topicSort, appStore.state.value.newestItemAtByTopic).map((t) => t.id);
    const from = ids.indexOf(anchorId);
    const to = ids.indexOf(id);
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      appStore.actions.setSelection(ids.slice(lo, hi + 1));
      return;
    }
  }
  if (mods.toggle) {
    const next = selectedTopicIds.includes(id)
      ? selectedTopicIds.filter((x) => x !== id)
      : [...selectedTopicIds, id];
    appStore.actions.setSelection(next);
    anchorId = id;
    return;
  }
  appStore.actions.setSelection([id]);
  anchorId = id;
}

/** Prompt for and delete `ids`, naming what's about to go. */
function confirmDelete(ids: string[]): void {
  const { topics } = appStore.state.value;
  const names = topics.filter((t) => ids.includes(t.id)).map((t) => t.name);
  if (names.length === 0) return;
  const what =
    names.length === 1 ? `\u201c${names[0] ?? ''}\u201d` : `${String(names.length)} topics`;
  void (async () => {
    if (!(await confirm(`Delete ${what} and all of their stories?`, { confirmLabel: 'Delete', danger: true }))) return;
    appStore.actions.setSelection([]);
    for (const id of ids) await deleteTopic(id);
  })();
}

/** Every story the client currently holds: the server feed page plus the
 *  just-flagged session overlay (NEWS-76) — the pool for id lookups. */
function feedAndFlagged(): NewsItem[] {
  const s = appStore.state.value;
  return [...s.feedItems, ...s.recentlyFlaggedItems];
}

/** Share one story, toasting only when it fell back to the clipboard/failed. */
async function shareOne(item: NewsItem): Promise<void> {
  const result = await shareItem(item);
  // The OS share sheet is its own feedback, and a cancelled share needs none.
  if (result === 'copied') showToast('Copied to clipboard');
  else if (result === 'failed') showToast("Couldn't share this story");
}

/** Flag/unflag a story off-topic (NEWS-61). Flagging holds the item this session
 *  (via `recentlyFlaggedItems`) so it stays visible-but-collapsed after the
 *  server drops it from the normal page; unflagging releases it (NEWS-76). */
function flagItem(item: NewsItem, offTopic: boolean): void {
  if (offTopic) appStore.actions.addRecentlyFlagged(item);
  else appStore.actions.removeRecentlyFlagged(item.id);
  void setItemOffTopic(item.id, offTopic).then(refreshFeed);
}

/**
 * Open the topic menu anchored to a row rather than to a pointer (NEWS-90).
 *
 * The mouse path positions the menu at the cursor; a keyboard has no cursor, so
 * it is anchored to the row's own box. Shared with the mouse handler's
 * selection rules so the two can't drift apart.
 */
function openTopicMenuFor(id: string, row: Element): void {
  const current = appStore.state.value.selectedTopicIds;
  const topicIds = current.includes(id) ? current : [id];
  if (!current.includes(id)) appStore.actions.setSelection([id]);
  const box = row.getBoundingClientRect();
  appStore.actions.openContextMenu({ x: box.left + 24, y: box.bottom - 4, topicIds });
}

/** Dismiss the first-run flow and remember that it has been seen. */
function closeOnboarding(): void {
  appStore.actions.setOnboarding(null);
  writeOnboardingSeen(appStore.state.value.installId);
}

/**
 * Move to a step, doing whatever that step needs on the way in.
 *
 * One place rather than one branch per caller: the profile picker and the
 * ordinary Continue both arrive here, and a second copy of the source-step
 * refresh is how one of them would eventually stop doing it.
 */
function advanceOnboardingTo(next: OnboardingStep): void {
  appStore.actions.setOnboarding(next);
  // Entering the source step, re-read what's actually configured: a key may
  // have been added in another window since load.
  if (next === 'source') {
    void refreshKeys();
    void refreshProviders();
  }
  // Seed the picker from what is already saved, so reopening the guide from
  // Settings shows previous picks ticked rather than a blank grid (NEWS-383).
  if (next === 'profiles') {
    appStore.actions.seedOnboardingProfiles(appStore.state.value.settings.profiles);
  }
}

/**
 * Save the ticked profiles, then leave the picker.
 *
 * Saves **before** advancing, and advances regardless of whether the write
 * succeeded: a failed PATCH here should not trap the user in setup. The value is
 * a preference, not a precondition for anything later in the flow.
 */
async function saveProfilesAndAdvance(): Promise<void> {
  const { onboardingProfiles } = appStore.state.value;
  // Bound checked rather than trusted: indexing a readonly tuple past its length
  // is typed as never-undefined, so the type would not catch a reorder that left
  // `profiles` last. Same reason the Continue handler checks it explicitly.
  const at = ONBOARDING_STEPS.indexOf('profiles') + 1;
  try {
    await updateProfiles(onboardingProfiles);
  } finally {
    if (at >= ONBOARDING_STEPS.length) closeOnboarding();
    else advanceOnboardingTo(ONBOARDING_STEPS[at]);
  }
}

/**
 * Open the first-run flow for someone who has not set the app up yet.
 *
 * **Having no topics is the whole test** (NEWS-421). It used to also require no
 * usable provider, on the reasoning that someone who had either was an existing
 * user who must not be interrupted. The topic count alone already says that —
 * an existing user has topics — and the provider half was actively harmful: a
 * signed-in `claude-cli` is a fact about the *machine*, established before this
 * app was ever installed, and says nothing about whether Newsmonger is set up.
 *
 * So anyone who already used Claude Code or Codex — which FR-20.5 treats as the
 * *best* case, presenting a detected subscription first — got no setup guide at
 * all, ever. The condition excluded exactly the audience the flow was written
 * for.
 *
 * Still gated on `/api/state` having answered, and still on the provider list:
 * `topics` is empty before the first load too, so `loaded` is what stops the
 * wizard flashing at every existing user on every reload. The provider wait
 * costs nothing to keep and the Source step needs the list anyway — and this is
 * a decision that has flashed at users before.
 *
 * Once dismissed it is remembered per-device (FR-20.3) and only Settings
 * reopens it. The flag names the install it was dismissed for (NEWS-423), so
 * deleting the data directory brings the guide back the way people expect,
 * without the dismissal becoming shared between two browsers.
 */
function maybeOpenOnboarding(): void {
  const s = appStore.state.value;
  if (s.onboarding !== 'auto') return;
  if (!s.loaded || s.providers.length === 0) return;
  const open = shouldOpenOnboarding({
    loaded: s.loaded,
    providerCount: s.providers.length,
    topicCount: s.topics.length,
    seen: readOnboardingSeen(s.installId),
  });
  appStore.actions.setOnboarding(open ? 'welcome' : null);
}

/**
 * Offer the backup folder once there is something worth backing up (NEWS-230).
 *
 * Runs off every `/api/state`, which is how it notices the third topic arriving
 * without needing the add-topic path to know about backups. Cheap to re-ask:
 * `shouldOfferBackup` is pure and the guards below stop it doing any work once
 * the answer is no.
 */
let offerFetchInFlight = false;
function maybeOfferBackup(): void {
  const s = appStore.state.value;
  if (s.backupOffer !== null || offerFetchInFlight) return; // already asking
  if (!s.loaded) return;
  // Never two modals at once. Onboarding is the more important conversation and
  // it also creates topics, so it can be the very thing that crosses the
  // threshold -- stacking a second dialog on top of it would be absurd.
  if (s.onboarding !== null) return;
  if (
    !shouldOfferBackup({
      topicCount: s.topics.length,
      backupDir: s.settings.backupDir,
      never: s.settings.backupPromptNever,
      snoozedUntil: s.settings.backupPromptSnoozedUntil,
      now: Date.now(),
    })
  ) {
    return;
  }
  offerFetchInFlight = true;
  // The suggestions are a nicety, not a precondition -- a probe that fails still
  // gets the dialog, just with nothing pre-filled and a note saying so.
  void fetchBackupLocations().then(
    (locations) => {
      offerFetchInFlight = false;
      appStore.actions.setBackupOffer(locations);
    },
    () => {
      offerFetchInFlight = false;
      appStore.actions.setBackupOffer([]);
    },
  );
}

/** Close the offer, recording the answer so it is not asked again today (FR-27.4). */
function answerBackupOffer(answer: 'never' | 'later'): void {
  appStore.actions.setBackupOffer(null);
  void dismissBackupPrompt(
    answer === 'never'
      ? { backupPromptNever: true }
      : { backupPromptSnoozedUntil: snoozeUntil(Date.now()) },
  );
}

/** Apply a context-menu action to every targeted topic. */
function runTopicAction(action: string, ids: string[]): void {
  const { topics, soloTopicIds } = appStore.state.value;
  const targets = topics.filter((t) => ids.includes(t.id));
  switch (action) {
    case 'check':
      for (const t of targets) void startCheck(t.id);
      break;
    case 'pause': {
      // Mixed selections resolve toward the action that changes the most rows,
      // matching the label the menu showed.
      const pause = targets.some((t) => !t.paused);
      for (const t of targets) {
        if (t.paused === pause) continue;
        void setTopicPaused(t.id, pause);
      }
      break;
    }
    case 'priority': {
      // Mixed selections resolve toward high-priority (the label the menu showed).
      const high = targets.some((t) => !t.highPriority);
      for (const t of targets) {
        if (t.highPriority === high) continue;
        void setTopicHighPriority(t.id, high);
      }
      break;
    }
    case 'solo':
      appStore.actions.setSolo(toggleSolo(soloTopicIds, targets.map((t) => t.id)));
      void refreshFeed();
      void refreshPulseSurfaces();
      break;
    case 'guidance': {
      // Single-target only; the menu item is disabled for a multi-selection.
      const only = targets.length === 1 ? targets[0] : undefined;
      if (only !== undefined) appStore.actions.openGuidance(only.id);
      break;
    }
    case 'rename': {
      // Single-target only, for the same reason guidance is: there is one name.
      const only = targets.length === 1 ? targets[0] : undefined;
      if (only !== undefined) {
        appStore.actions.openRename(only.id);
        // The count is what decides whether clearing is even offered, and it is
        // fetched per dialog rather than polled for every topic (NEWS-139).
        void countItemsForTopic(only.id).then((count) => {
          if (appStore.state.value.renameTopicId === only.id) {
            appStore.actions.setRenameItemCount(count);
          }
        });
      }
      break;
    }
    case 'review-flagged':
      // Enter review mode for the targeted topics (the menu item is disabled
      // when none of them have flagged stories).
      appStore.actions.setReviewTopicIds(ids);
      void refreshFeed();
      break;
    case 'delete':
      confirmDelete(ids);
      break;
    default:
      break;
  }
}

/**
 * Issue-order guard for discovery responses (NEWS-324) — see `runDiscovery`.
 *
 * Module-scoped like `refreshState`'s counters, and for the same reason: there
 * is one dialog per page, so one pair of counters describes it.
 */
let discoverSeq = 0;
let discoverApplied = 0;

/**
 * Run one discovery request and fold the answer into the pane (NEWS-126).
 *
 * The `discover === null` guards are the point of doing this in one place: the
 * user can close the dialog while a request is in flight, and a response that
 * reopened it — or wrote into a fresh session's state — is the kind of bug that
 * only shows up on a slow provider.
 */
async function runDiscovery(source: DiscoverSource): Promise<void> {
  // Discovery answers apply in **issue** order, not arrival order (NEWS-324).
  //
  // The same guard `refreshState` and `refreshFeed` carry (NEWS-104), and
  // **defence in depth rather than a live bug**: measured, the UI already
  // serialises these. While `loading` is true the submit button is disabled and
  // `discoverPaneJsx` replaces the whole body with the waiting state, so there
  // is no control on screen that can issue a second request. An attempt to
  // demonstrate the race through the UI could not — the second search never
  // fired, which is what `discoverWaitingJsx` is asserted to guarantee in
  // `discover.spec.ts`.
  //
  // Kept because that protection is *incidental*: it falls out of a rendering
  // decision, not a stated invariant. Keeping results on screen during a
  // re-search — a reasonable future change, and the sort of thing a design pass
  // asks for — would expose the race immediately, and the failure would be a
  // list of results for a query the heading no longer names, plus `source` and
  // `suggestions` disagreeing about which search they came from. Four lines to
  // make that impossible ahead of time is worth it; four lines pretending to fix
  // something reachable today would not be.
  //
  // `loadMoreSuggestions` guards itself by comparing `source`; that works for
  // *append* and cannot work here, because re-searching the same source is a
  // legitimate thing to do twice.
  const seq = ++discoverSeq;
  appStore.actions.patchDiscover({
    loading: true,
    error: null,
    view: 'results',
    source,
    // A new search is a fresh seam — clear whatever the previous one ended on.
    exhausted: false,
    loadingMore: false,
  });
  const startedAt = Date.now();
  try {
    const { suggestions, cached } = await discoverTopics(source);
    // Only a real call informs the estimate — a cache hit returns instantly and
    // would drag the next bar's target down to nothing (NEWS-137).
    if (!cached) recordDuration(Date.now() - startedAt);
    if (appStore.state.value.discover === null || seq < discoverApplied) return;
    discoverApplied = seq;
    appStore.actions.patchDiscover({ loading: false, suggestions, cached, view: 'results' });
  } catch (err) {
    // Gated too: a stale *failure* must not raise an error over results a newer,
    // successful request already applied.
    if (appStore.state.value.discover === null || seq < discoverApplied) return;
    discoverApplied = seq;
    // Shown inside the dialog next to a retry, not in the global banner: the
    // user is mid-task here, and the message is about this request.
    appStore.actions.patchDiscover({
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fetch one tuner round and install it (NEWS-127).
 *
 * Every round is a billable call, so the server-side bound (FR-24.9) is the
 * backstop; this stops asking on its own once `judgeCandidate` says exhausted.
 */
async function fetchTunerRound(tuner: TunerState, advance: boolean): Promise<void> {
  appStore.actions.patchDiscover({ tuner: { ...tuner, loading: true, error: null } });
  try {
    const { suggestions } = await discoverTopics({
      kind: 'tune',
      anchor: tuner.anchor,
      direction: tuner.direction,
      kept: tuner.kept.map((s) => s.name),
      skipped: tuner.skipped,
      round: advance ? tuner.round + 1 : tuner.round,
    });
    // The user can close the dialog or end the session while a round is in
    // flight; installing it then would resurrect a tuner they walked away from.
    if (appStore.state.value.discover?.tuner === null) return;
    appStore.actions.patchDiscover({
      tuner: advance ? nextRound(tuner, suggestions) : { ...tuner, queue: suggestions, index: 0, loading: false },
    });
  } catch (err) {
    if (appStore.state.value.discover?.tuner === null) return;
    appStore.actions.patchDiscover({
      tuner: { ...tuner, loading: false, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** Enter the tuner, scoped to a card or to the whole result set (FR-24.5). */
async function enterTuner(anchor: string, direction: 'narrower' | 'similar'): Promise<void> {
  const tuner = startTuner(anchor, direction);
  appStore.actions.patchDiscover({ tuner });
  await fetchTunerRound(tuner, false);
}

/** Record a verdict and do whatever the state machine says comes next. */
async function judgeTunerCandidate(verdict: 'keep' | 'skip'): Promise<void> {
  const tuner = appStore.state.value.discover?.tuner;
  if (tuner === undefined || tuner === null || tuner.loading) return;
  const { tuner: updated, next } = judgeCandidate(tuner, verdict);
  appStore.actions.patchDiscover({ tuner: updated });
  if (next === 'fetch-round') await fetchTunerRound(updated, true);
}

/**
 * End the session and return to the list (FR-24.7).
 *
 * Kept suggestions are merged into the list, **not** created — nothing in
 * discovery creates a topic without an explicit Add, inside the tuner or out.
 */
function finishTuner(): void {
  const current = appStore.state.value.discover;
  if (current?.tuner == null) return;
  appStore.actions.patchDiscover({
    tuner: null,
    view: 'results',
    suggestions: mergeKept(current.suggestions, current.tuner.kept),
  });
}

/**
 * Append another batch of suggestions to the list (NEWS-136).
 *
 * The names already on screen go up as `seen`, so the model is asked for ideas
 * it hasn't given yet rather than being left to repeat itself — and because the
 * cache key includes the exclusions, "More" is genuinely a new call rather than
 * a replay of the one that filled the list.
 */
async function loadMoreSuggestions(): Promise<void> {
  const current = appStore.state.value.discover;
  if (current?.source == null || current.loadingMore || current.exhausted) return;
  const seen = current.suggestions.map((s) => s.name);
  appStore.actions.patchDiscover({ loadingMore: true, error: null });
  try {
    const { suggestions } = await discoverTopics(current.source, undefined, seen);
    const latest = appStore.state.value.discover;
    // The user can close the dialog or start a different search mid-flight;
    // appending then would splice this batch onto a list it doesn't belong to.
    if (latest === null || latest.source !== current.source) return;
    const merged = mergeKept(latest.suggestions, suggestions);
    appStore.actions.patchDiscover({
      loadingMore: false,
      suggestions: merged,
      // Nothing new survived the merge, so there is no point offering again.
      exhausted: merged.length === latest.suggestions.length,
    });
  } catch (err) {
    if (appStore.state.value.discover === null) return;
    appStore.actions.patchDiscover({
      loadingMore: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Rename a topic, and say plainly what happened (NEWS-139).
 *
 * The dialog stays open on failure — a duplicate name is something to correct
 * in the field the user is already looking at, not a banner behind a closed
 * dialog. It closes only once the rename has actually landed.
 */
async function saveRename(
  id: string,
  name: string,
  clearItems: boolean,
  category?: { category: string | null; subcategory: string | null },
): Promise<void> {
  try {
    // Before the request, not after (NEWS-303, following NEWS-291's rule for the
    // app-wide clear): `renameTopic` refreshes state and feed itself, so
    // clearing afterwards leaves a frame in which the emptied feed renders with
    // the stale overlay still merged into it.
    if (clearItems) appStore.actions.clearStoryOverlaysForTopic(id);
    await renameTopic(id, name, clearItems, category);
    const cleared = clearItems ? (appStore.state.value.renameItemCount ?? 0) : 0;
    appStore.actions.closeRename();
    // The count is the one the dialog already fetched when it opened (FR-25.5a),
    // so the toast names what was actually lost rather than "some stories".
    if (cleared > 0) {
      showUndoToast(`Renamed to “${name}” — cleared ${String(cleared)} ${cleared === 1 ? 'story' : 'stories'}`, id);
    } else {
      showToast(
        clearItems
          ? `Renamed to “${name}” — previous stories cleared, next check starts fresh`
          : `Renamed to “${name}” — applies from the next check`,
      );
    }
  } catch (err) {
    appStore.actions.setError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Restore a topic's just-cleared stories (NEWS-145).
 *
 * An expired window is **not** an error: the user pressed a button the app was
 * still showing them, and answering with the red banner reserved for real
 * failures would read as "something broke" rather than "you were too slow". It
 * replaces the toast with a plain one saying so.
 *
 * **A restored story that is still flagged does not come back into view, and
 * that is correct** (NEWS-303). The clear now drops that topic's flagged-story
 * overlay, so an undo puts the rows back in the database but not on the normal
 * feed, which excludes off-topic stories everywhere else in the app.
 *
 * The alternative — having the undo re-seed the overlay — was rejected on both
 * counts. It restores the wrong thing: this undoes the *clear*, not the *flag*,
 * and a story that is still flagged belongs where flagged stories live. Review
 * mode shows it and the sidebar badge counts it, so nothing is lost, only filed.
 * And it is not free: `POST /api/topics/:id/restore-cleared` answers with a
 * count, so the client would need the route to return the items — a server-shape
 * change to re-show rows the user has since acted on twice.
 *
 * What the overlay promises is that the row you *just* flagged stays put so a
 * misclick is reversible (NEWS-61). It has never promised to survive arbitrary
 * later actions on the topic.
 */
async function undoClear(id: string): Promise<void> {
  try {
    await restoreClearedItems(id);
    showToast('Stories restored');
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
  }
}

/** Create a topic from a suggestion, keeping its card in place (FR-24.12/24.13). */
async function addSuggestion(name: string): Promise<void> {
  const current = appStore.state.value.discover;
  if (current === null) return; // The dialog closed under the click; nothing to say.
  if (current.added.includes(name)) return; // Already done, and the card says so.
  const suggestion = current.suggestions.find((s) => s.name === name);
  if (suggestion === undefined) {
    // The list was replaced between the render and the click — a slower earlier
    // search landing late used to do this (NEWS-324, now guarded), and a
    // re-search still can. Silence was the bug worth fixing here: the button
    // did nothing, said nothing, and left the card looking un-added forever,
    // which is indistinguishable from a broken button.
    showToast(`“${name}” is no longer in these results — search again to add it`);
    return;
  }
  try {
    await addSuggestedTopic(suggestion);
    if (appStore.state.value.discover === null) return;
    appStore.actions.patchDiscover({ added: [...appStore.state.value.discover.added, name] });
    // `showToast`, never `setToast` directly — the store action has no timer,
    // so a direct call leaves the toast on screen forever (NEWS-141).
    showToast(`Added “${name}” — checking now`);
  } catch (err) {
    if (appStore.state.value.discover === null) return;
    appStore.actions.patchDiscover({ error: err instanceof Error ? err.message : String(err) });
  }
}

function wireEvents(root: HTMLElement): void {
  void delegate(root, 'submit', '[data-action=add-topic-form]', (e, form) => {
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>('input[name=topic-name]');
    if (!input) return;
    const name = input.value.trim();
    if (name === '') return;
    input.value = '';
    void addTopic(name);
  });

  // --- Topic discovery (NEWS-126) -----------------------------------------

  void delegate(root, 'click', '[data-action=open-discover]', () => {
    appStore.actions.openDiscover();
  });

  void delegate(root, 'click', '[data-action=close-discover]', () => {
    appStore.actions.closeDiscover();
  });

  void delegate(root, 'click', '[data-action=discover-backdrop]', (e, el) => {
    // Only a click on the backdrop itself, never one that bubbled out of the
    // dialog — the same rule the settings dialog needed (see keys.spec.ts).
    if (e.target === el) appStore.actions.closeDiscover();
  });

  void delegate(root, 'submit', '[data-action=discover-search]', (e, form) => {
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>('input[name=discover-query]');
    // An empty query is a real request — "surprise me" (FR-24.3) — so this
    // deliberately does not bail out on a blank field the way add-topic does.
    void runDiscovery({ kind: 'describe', query: input?.value.trim() ?? '' });
  });

  /**
   * One delegate for both browse steps, on one attribute — deliberately not two.
   *
   * The section tiles and the subcategory chips are both `<button>`s in the same
   * position of the same container, so the morph **reuses the node** and merely
   * rewrites its attributes when the pane switches. Two delegates keyed on two
   * different attributes then both match the *same* click: the first handler
   * re-renders synchronously, the tile becomes a chip, and the second handler —
   * still walking up from that very node — sees the chip's attribute and fires
   * too. One physical click ran two different actions, jumping the user from
   * "Sports" straight into results for whichever subcategory landed under the
   * cursor. Caught by the E2E suite; see `docs/3-ui.md`.
   */
  void delegate(root, 'click', '[data-discover-nav]', (_e, el) => {
    const value = el.getAttribute('data-discover-nav');
    if (value === null) return;
    if (value.startsWith('section:')) {
      appStore.actions.patchDiscover({ section: value.slice('section:'.length), view: 'browse' });
      return;
    }
    if (!value.startsWith('sub:')) return;
    // "sub:category/subcategory", with an empty tail meaning the whole section.
    const [category, sub] = value.slice('sub:'.length).split('/');
    void runDiscovery({ kind: 'section', category, subcategory: sub === '' ? null : sub });
  });

  void delegate(root, 'click', '[data-action=discover-back]', () => {
    const current = appStore.state.value.discover;
    if (current === null) return;
    // From results, step back to wherever they came from; from a section's
    // subcategories, back to the grid.
    if (current.view === 'results' && current.source?.kind === 'section') {
      appStore.actions.patchDiscover({ view: 'browse', section: current.source.category, error: null });
      return;
    }
    appStore.actions.patchDiscover({ view: 'browse', section: null, error: null });
  });

  void delegate(root, 'click', '[data-action=discover-more]', () => {
    void loadMoreSuggestions();
  });

  void delegate(root, 'click', '[data-action=discover-retry]', () => {
    const source = appStore.state.value.discover?.source;
    if (source) void runDiscovery(source);
    else appStore.actions.patchDiscover({ error: null, view: 'browse', section: null });
  });

  /**
   * Enter the tuner from a card or from the whole set (FR-24.5).
   *
   * One attribute, one delegate — see the delegate/morph rule in `docs/3-ui.md`.
   */
  void delegate(root, 'click', '[data-tune]', (_e, el) => {
    const value = el.getAttribute('data-tune');
    if (value === null) return;
    const separator = value.indexOf(':');
    const direction = value.slice(0, separator);
    const anchor = value.slice(separator + 1);
    if (direction !== 'narrower' && direction !== 'similar') return;
    void enterTuner(anchor, direction);
  });

  /** Keep / skip / done, all on one attribute for the same reason. */
  void delegate(root, 'click', '[data-tuner]', (_e, el) => {
    const action = el.getAttribute('data-tuner');
    if (action === 'done') {
      finishTuner();
      return;
    }
    if (action === 'keep' || action === 'skip') void judgeTunerCandidate(action);
  });

  void delegate(root, 'click', '[data-add-suggestion]', (_e, el) => {
    const name = el.getAttribute('data-add-suggestion');
    if (name !== null) void addSuggestion(name);
  });

  // The profile strip (NEWS-406). Plain `addTopic`, not `addSuggestion`: these
  // are names from a static table with no reason, kind or classification behind
  // them, so there is no suggestion to mark as added — the chip disappears on
  // the next render because the topic now excludes itself (FR-24.11).
  void delegate(root, 'click', '[data-foryou-topic]', (_e, el) => {
    const name = el.getAttribute('data-foryou-topic');
    if (name !== null) void addTopic(name);
  });

  void delegate(root, 'change', '[data-action=interval]', (_e, el) => {
    const ms = Number.parseInt((el as HTMLSelectElement).value, 10);
    if (Number.isNaN(ms)) return;
    // Give the scheduler a grace before the falling-behind banner may fire —
    // a just-shortened interval otherwise flags topics that are merely awaiting
    // their next check (NEWS-67).
    appStore.actions.bumpBehindGrace();
    void updateInterval(ms);
  });

  void delegate(root, 'change', '[data-action=hp-interval]', (_e, el) => {
    const ms = Number.parseInt((el as HTMLSelectElement).value, 10);
    if (Number.isNaN(ms)) return;
    appStore.actions.bumpBehindGrace();
    void updateHighPriorityInterval(ms);
  });

  void delegate(root, 'change', '[data-action=topic-sort]', (_e, el) => {
    const value = (el as HTMLSelectElement).value;
    if (TOPIC_SORTS.includes(value as (typeof TOPIC_SORTS)[number])) {
      appStore.actions.setTopicSort(value as (typeof TOPIC_SORTS)[number]);
    }
  });

  void delegate(root, 'change', '[data-action=provider]', (_e, el) => {
    // The stored model may belong to the provider being left, so the new
    // provider's catalogue is fetched and the model corrected if it no longer
    // fits (NEWS-253). `updateProviderSettings` refreshes the catalogue itself,
    // so by the time it resolves the store holds the right list to judge by.
    void updateProviderSettings({ provider: (el as HTMLSelectElement).value as ProviderName }).then(
      applyModelCorrection,
    );
  });

  void delegate(root, 'change', '[data-action=model]', (_e, el) => {
    void updateProviderSettings({ model: (el as HTMLSelectElement).value });
  });
  void delegate(root, 'change', '[data-action=endpoint]', (_e, el) => {
    void updateProviderSettings({ endpoint: (el as HTMLInputElement).value.trim() });
  });
  void delegate(root, 'change', '[data-action=effort]', (_e, el) => {
    void updateProviderSettings({ effort: (el as HTMLSelectElement).value as Effort });
  });

  void delegate(root, 'click', '[data-action=check-all]', () => {
    void startCheck();
  });

  void delegate(root, 'click', '[data-action=toggle-sidebar]', () => {
    appStore.actions.setSidebarCollapsed(!appStore.state.value.sidebarCollapsed);
  });

  void delegate(root, 'click', '[data-action=rerun-onboarding]', () => {
    appStore.actions.setSettingsOpen(false);
    appStore.actions.setOnboarding('welcome');
    void refreshKeys();
    void refreshProviders();
  });

  void delegate(root, 'click', '[data-action=open-settings]', () => {
    // Always reopen on the first tab: wherever you left off is rarely where you
    // want to be next time, and a dialog that remembers is a dialog that opens
    // somewhere surprising.
    appStore.actions.setSettingsTab('schedule');
    appStore.actions.setSettingsOpen(true);
    // Status can go stale while the dialog is closed — a key added in another
    // window, or an environment variable set since load.
    void refreshKeys();
    void refreshProviders();
  });

  void delegate(root, 'click', '[data-settings-tab]', (_e, el) => {
    const tab = el.getAttribute('data-settings-tab');
    if (tab === null) return;
    appStore.actions.setSettingsTab(tab as AppState['settingsTab']);
    // The model catalogue costs a vendor round trip, so it is fetched when
    // someone actually opens the tab that shows it (NEWS-248) rather than on
    // the 4-second poll.
    if (tab === 'source') void refreshModels().then(applyModelCorrection);
    // The backup folder's contents can change under us — another device syncing,
    // or a backup written since the dialog last opened (NEWS-252).
    if (tab === 'data') {
      void refreshBackupPreview();
      // Loaded here rather than on the poll: inspecting a candidate means
      // copying and opening a database, and the list is empty on essentially
      // every install (NEWS-342).
      void refreshSetAside();
    }
  });

  // Arrow keys move between tabs, which the WAI-ARIA tabs pattern requires:
  // only the selected tab is in the tab order, so without this the others are
  // unreachable from the keyboard entirely.
  void delegate(root, 'keydown', '[data-settings-tab]', (e, el) => {
    if (!(e instanceof KeyboardEvent)) return;
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const tabs = [...root.querySelectorAll<HTMLElement>('[data-settings-tab]')];
    const here = tabs.indexOf(el as HTMLElement);
    // Wraps at both ends, as the pattern specifies.
    const next = tabs[(here + step + tabs.length) % tabs.length];
    const id = next.getAttribute('data-settings-tab');
    if (id !== null) {
      appStore.actions.setSettingsTab(id as AppState['settingsTab']);
      // Focus follows selection here; the panel is rendered fresh, so the tab
      // element is replaced and has to be re-found after the render.
      queueMicrotask(() => root.querySelector<HTMLElement>(`[data-settings-tab="${id}"]`)?.focus());
    }
  });

  void delegate(root, 'click', '[data-action=open-privacy]', () => {
    appStore.actions.setPrivacyOpen(true);
  });

  void delegate(root, 'click', '[data-action=close-privacy]', () => {
    appStore.actions.setPrivacyOpen(false);
  });

  // Only a click on the backdrop itself dismisses — the backdrop wraps the
  // dialog, so matching descendants would close it before any inner control
  // could act (docs/3-ui.md).
  void delegate(root, 'click', '[data-action=privacy-backdrop]', (e, el) => {
    if (e.target === el) appStore.actions.setPrivacyOpen(false);
  });

  void delegate(root, 'click', '[data-action=close-settings]', () => {
    appStore.actions.setSettingsOpen(false);
  });

  // Backdrop click-away. This deliberately does NOT share the close action:
  // delegation matches against the target's ancestors, and the backdrop wraps
  // the whole dialog — so every click inside it, including Save, would match a
  // `[data-action=close-settings]` backdrop and dismiss the dialog mid-submit.
  // Only a click that landed on the backdrop itself should close.
  void delegate(root, 'click', '[data-action=settings-backdrop]', (e, el) => {
    if (e.target === el) appStore.actions.setSettingsOpen(false);
  });

  // No Save button any more (NEWS-156): the field commits on `change`, which
  // fires on blur and on Enter. `submit` stays because Enter in a single-input
  // form submits it as well — the two can both fire for one Enter, which is
  // exactly why `commitKey` empties the field *before* awaiting rather than
  // after. The second call then sees a blank field and stops.
  //
  // `change`, never `input`: saving verifies the key with its vendor (FR-20.9),
  // so committing per keystroke would probe once per character and report every
  // prefix of a key as invalid. Same rule the interval and budget fields follow,
  // for a costlier reason.
  const commitKey = (form: Element): void => {
    const provider = form.getAttribute('data-save-key');
    const input = form.querySelector<HTMLInputElement>('input[name=api-key]');
    if (provider === null || !input) return;
    const key = input.value.trim();
    if (key === '') return;
    // Cleared either way: on success it's in the keychain, and on failure
    // leaving a key sitting in the DOM serves no purpose.
    input.value = '';
    appStore.actions.setSavingKey(provider);
    void saveKey(provider, key).finally(() => {
      appStore.actions.setSavingKey(null);
    });
  };

  void delegate(root, 'submit', '[data-save-key]', (e, form) => {
    e.preventDefault();
    commitKey(form);
  });

  void delegate(root, 'change', '[data-save-key] input[name=api-key]', (_e, input) => {
    const form = input.closest('[data-save-key]');
    if (form !== null) commitKey(form);
  });

  void delegate(root, 'click', '[data-remove-key]', (_e, el) => {
    const provider = el.getAttribute('data-remove-key');
    if (provider === null) return;
    const label = appStore.state.value.keys.find((k) => k.provider === provider)?.label ?? provider;
    void (async () => {
      if (await confirm(`Remove the stored ${label} API key?`, { confirmLabel: 'Remove', danger: true })) {
        await deleteKey(provider);
      }
    })();
  });

  // Budget is committed on `change` (blur / Enter), not `input` — a PATCH per
  // keystroke would round-trip "1", "12", "125" and fight the 4 s state poll
  // for the field. Blank means no limit.

  void delegate(root, 'change', '[data-action=schedule-mode]', (_e, el) => {
    if (el instanceof HTMLSelectElement && (el.value === 'interval' || el.value === 'daily')) {
      void updateScheduleMode(el.value);
    }
  });

  // Committed on `change`, not per keystroke: "08:0" is not a time, and a PATCH
  // per character would fight the 4 s poll for the field.
  void delegate(root, 'change', '[data-action=daily-times]', (_e, el) => {
    if (!(el instanceof HTMLInputElement)) return;
    const times = el.value
      .split(',')
      .map((t) => t.trim())
      .filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
    if (times.length === 0) {
      // Nothing parseable — put the saved value back rather than silently
      // clearing the schedule out from under the user.
      el.value = appStore.state.value.settings.dailyTimes.join(', ');
      showToast('Times must look like 08:00 — nothing changed');
      return;
    }
    void updateDailyTimes(times);
  });


  void delegate(root, 'change', '[data-action=concurrency]', (_e, el) => {
    if (el instanceof HTMLSelectElement) void updateConcurrency(Number(el.value));
  });

  // `change`, not `input`: a PATCH per keystroke would write a dozen invalid
  // half-typed paths on the way to a good one.
  void delegate(root, 'change', '[data-action=backup-dir]', (_e, el) => {
    if (el instanceof HTMLInputElement) void updateBackupDir(el.value.trim()).then(refreshBackupPreview);
  });

  // `change`, not `input`, for the same reason as the row above — and here it
  // also matters for IME input: a composing keystroke in a CJK script is not a
  // finished word, and `input` would PATCH each intermediate candidate.
  void delegate(root, 'change', '[data-action=location]', (_e, el) => {
    if (el instanceof HTMLInputElement) void updateLocation(el.value.trim());
  });

  void delegate(root, 'click', '[data-action=clear-stories]', () => {
    void (async () => {
      const total = appStore.state.value.feedTotal;
      const running = appStore.state.value.checking.length;
      // Named, not "are you sure?" — and it says what *survives*, because the
      // fear this dialog has to answer is "am I about to lose my topics too".
      //
      // The running-check sentence appears only when one is running (NEWS-271).
      // Clearing now stops them rather than refusing, and stopping a check the
      // user is waiting on is a consequence they should hear about *before* they
      // agree, not afterwards in a toast.
      const ok = await confirm(
        `Delete ${total > 0 ? String(total) : 'all'} stor${total === 1 ? 'y' : 'ies'} from every topic? ` +
          (running > 0
            ? `${running === 1 ? 'The check' : `All ${String(running)} checks`} running now will be stopped. `
            : '') +
          `Your topics, settings and API keys are not touched. This cannot be undone.`,
        { confirmLabel: 'Delete stories', danger: true },
      );
      if (!ok) return;
      try {
        // Before the request, so there is no window in which the refreshed
        // (empty) feed renders with the stale overlay still merged into it.
        appStore.actions.clearStoryOverlays();
        const { cleared, cancelledChecks } = await clearAllStories();
        showToast(
          `Deleted ${String(cleared)} stor${cleared === 1 ? 'y' : 'ies'}` +
            (cancelledChecks > 0
              ? `, stopped ${String(cancelledChecks)} check${cancelledChecks === 1 ? '' : 's'}`
              : ''),
        );
      } catch (err) {
        showToast(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });

  /**
   * Read a shared topic list back in (FR-30.5–30.9, NEWS-318).
   *
   * `change`, not `click`: the interesting moment is a file being *chosen*, and
   * the same file chosen twice must work — so the input is cleared afterwards,
   * or the second pick fires no event at all and the control looks broken.
   *
   * The outcome is a toast, never silence (FR-30.7). A bulk action whose result
   * you cannot see invites running it twice, and "skipped 3 you already follow"
   * is the difference between "it did nothing" and "it did exactly what it
   * should have".
   */
  void delegate(root, 'change', '[data-action=import-topics]', (_e, el) => {
    const input = el as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) return;
    void (async () => {
      try {
        const { added, skipped } = await importTopics(await file.text());
        const parts = [`Added ${String(added.length)} topic${added.length === 1 ? '' : 's'}`];
        if (skipped.length > 0) parts.push(`skipped ${String(skipped.length)} you already follow`);
        showToast(parts.join(' · '));
      } catch (err) {
        showToast(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        // So picking the same file again is still a `change`.
        input.value = '';
      }
    })();
  });

  /**
   * Read an exported story archive back in (FR-30.10–30.14, NEWS-319).
   *
   * The report names the topics it had to create, because story import is also
   * a **topic**-creating action (FR-30.12) and that should not be a surprise
   * discovered later in the sidebar.
   */
  void delegate(root, 'change', '[data-action=import-stories]', (_e, el) => {
    const input = el as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) return;
    void (async () => {
      try {
        const { added, skipped, topicsCreated } = await importStories(await file.text());
        const parts = [`Added ${String(added)} stor${added === 1 ? 'y' : 'ies'}`];
        if (skipped > 0) parts.push(`skipped ${String(skipped)} already here`);
        if (topicsCreated.length > 0) {
          parts.push(`created ${String(topicsCreated.length)} topic${topicsCreated.length === 1 ? '' : 's'}`);
        }
        showToast(parts.join(' · '));
      } catch (err) {
        showToast(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        input.value = '';
      }
    })();
  });

  /**
   * Delete every topic (FR-31.1, NEWS-328).
   *
   * The confirm names the count and says what **survives**, like its neighbour —
   * "delete all topics" is exactly the phrase that raises the fear it means the
   * whole app, and the answer is that settings and keys are untouched.
   *
   * It also names the stories going with them, which is the part someone might
   * not have thought through: a topic owns its stories, so this is strictly more
   * destructive than the button beside it.
   */
  void delegate(root, 'click', '[data-action=clear-topics]', () => {
    void (async () => {
      const { topics, feedTotal, checking } = appStore.state.value;
      const running = checking.length;
      const ok = await confirm(
        `Delete ${topics.length > 0 ? String(topics.length) : 'all'} topic${topics.length === 1 ? '' : 's'}? ` +
          `Every story filed under ${topics.length === 1 ? 'it' : 'them'} goes too` +
          (feedTotal > 0 ? ` — ${String(feedTotal)} of them` : '') +
          '. ' +
          (running > 0
            ? `${running === 1 ? 'The check' : `All ${String(running)} checks`} running now will be stopped. `
            : '') +
          'Your settings and API keys are not touched. This cannot be undone.',
        { confirmLabel: 'Delete topics', danger: true },
      );
      if (!ok) return;
      try {
        // Before the request, for the same reason the story clear does it: no
        // window in which a refreshed, empty rail renders with a stale overlay.
        appStore.actions.clearStoryOverlays();
        const { deleted, cancelledChecks } = await deleteAllTopics();
        showToast(
          `Deleted ${String(deleted)} topic${deleted === 1 ? '' : 's'}` +
            (cancelledChecks > 0
              ? `, stopped ${String(cancelledChecks)} check${cancelledChecks === 1 ? '' : 's'}`
              : ''),
        );
      } catch (err) {
        showToast(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });

  void delegate(root, 'click', '[data-action=restore-backup]', () => {
    void (async () => {
      const preview = appStore.state.value.backupPreview;
      if (preview === null) return;
      // Named quantities, not "are you sure?" — the decision is only makeable
      // if you can see what replaces what.
      const ok = await confirm(
        `Replace everything on this device with the backup from ${relativeTime(preview.savedAt)}? ` +
          `That snapshot has ${String(preview.topics)} topic${preview.topics === 1 ? '' : 's'} and ` +
          `${String(preview.items)} stor${preview.items === 1 ? 'y' : 'ies'}. ` +
          `Your current data is saved to the data folder first.`,
        { confirmLabel: 'Restore', danger: true },
      );
      if (!ok) return;
      try {
        const { preview: done, safetyCopy } = await restoreBackup();
        // The whole UI is now showing restored data, so refresh the things the
        // 4-second poll doesn't cover: the provider probe reflects restored
        // settings, and the backup folder is unchanged but its contents aren't.
        await Promise.all([refreshProviders(), refreshKeys(), refreshBackupPreview()]);
        showToast(`Restored ${String(done.topics)} topics. Previous data saved to ${safetyCopy}`);
      } catch (err) {
        showToast(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });

  void delegate(root, 'click', '[data-action=recover-db]', (_e, el) => {
    void (async () => {
      const file = el.getAttribute('data-file');
      if (file === null) return;
      const db = appStore.state.value.setAsideDatabases.find((d) => d.file === file);
      if (db?.contents == null) return;
      // Named quantities and what survives, the FR-31.3 shape: the decision is
      // only makeable if you can see what replaces what. This one especially —
      // whoever is reading it has already lost data once today.
      const ok = await confirm(
        `Replace everything on this device with the database set aside ${relativeTime(db.setAsideAt)}? ` +
          `It has ${String(db.contents.topics)} topic${db.contents.topics === 1 ? '' : 's'} and ` +
          `${String(db.contents.items)} stor${db.contents.items === 1 ? 'y' : 'ies'}. ` +
          `Your current data is saved to the data folder first, and the set-aside file is left where it is. ` +
          `This cannot be undone.`,
        { confirmLabel: 'Recover', danger: true },
      );
      if (!ok) return;
      try {
        const done = await recoverSetAside(file);
        // Everything on screen is now different data. Refresh what the poll
        // does not cover — the provider probe reads restored settings, and the
        // candidate list's own contents have not changed but the app's have.
        await Promise.all([refreshState(), refreshProviders(), refreshKeys(), refreshSetAside()]);
        showToast(`Recovered ${String(done.topics)} topics. Previous data saved to ${done.safetyCopy}`);
      } catch (err) {
        showToast(`Recovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });

  void delegate(root, 'click', '[data-action=backup-now]', () => {
    void backupNow().then(
      (at) => {
        showToast(`Backed up to ${at}`);
        // The folder now has something to restore from, so the panel below
        // should say so without waiting for the dialog to be reopened.
        void refreshBackupPreview();
      },
      (err: unknown) => {
        showToast(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
  });

  // Clicking a suggestion fills the field rather than saving immediately: the
  // path is a guess about where they keep things, and committing on one click
  // would make a misread suggestion into a decision.
  void delegate(root, 'click', '[data-backup-suggestion]', (_e, el) => {
    const path = el.getAttribute('data-backup-suggestion');
    const input = root.querySelector<HTMLInputElement>('[data-action=backup-offer-input]');
    if (path !== null && input) {
      input.value = path;
      input.focus();
    }
  });

  void delegate(root, 'click', '[data-action=backup-offer-save]', () => {
    const input = root.querySelector<HTMLInputElement>('[data-action=backup-offer-input]');
    const dir = (input?.value ?? '').trim();
    // Saving nothing is not an answer -- it would close the dialog having
    // changed nothing and never ask again, which is the worst of both exits.
    if (dir === '') {
      showToast('Choose a folder, or use “Not now”.');
      input?.focus();
      return;
    }
    appStore.actions.setBackupOffer(null);
    // Two failures, two messages, and **both handled** (NEWS-312).
    //
    // The second argument to `.then()` catches rejections of
    // `updateBackupDir` — not of the promise its success handler returns. So
    // `backupNow()` failing was an **unhandled rejection**, and the toast this
    // code plainly intends never appeared.
    //
    // Not a theoretical gap. The two calls fail independently: a folder can
    // save fine and then refuse the write — an unmounted drive, a sync client
    // that owns the directory, a full disk — and the server answers 500 with
    // "backup failed; see the server log". A user saw nothing at all.
    //
    // It surfaced as an E2E flake, which is how it was found: an uncaught page
    // error is asserted in the fixture teardown, so it failed whichever test was
    // running when the rejection landed rather than the one that caused it.
    void updateBackupDir(dir).then(
      () =>
        backupNow().then(
          (at) => { showToast(`Backing up to ${at}`); },
          (err: unknown) => {
            showToast(`Folder saved, but the first backup failed: ${err instanceof Error ? err.message : String(err)}`);
          },
        ),
      (err: unknown) => { showToast(`Couldn’t save that folder: ${err instanceof Error ? err.message : String(err)}`); },
    );
  });

  void delegate(root, 'click', '[data-action=backup-offer-later]', () => {
    answerBackupOffer('later');
  });

  void delegate(root, 'click', '[data-action=backup-offer-never]', () => {
    answerBackupOffer('never');
  });

  /**
   * Theme (FR-3.75, NEWS-334).
   *
   * **The store is the only writer**, and the handler deliberately does not
   * apply the theme itself. Writing it here optimistically *and* from the
   * `settings.theme` effect below means two writers disagreeing for as long as
   * the PATCH is in flight: any unrelated store change in that window — a poll,
   * a check starting — re-runs the effect with the old value and puts the
   * previous palette back. Measured: pinning dark reverted to light before the
   * request landed.
   *
   * `updateTheme` refreshes state as soon as the PATCH returns, and this server
   * is on loopback, so the round trip costs a few milliseconds rather than a
   * visible beat.
   */
  void delegate(root, 'change', '[data-action=theme]', (_e, el) => {
    const value = (el as HTMLSelectElement).value;
    if (value !== 'auto' && value !== 'light' && value !== 'dark') return;
    void updateTheme(value);
  });

  void delegate(root, 'change', '[data-action=retention]', (_e, el) => {
    if (el instanceof HTMLSelectElement) void updateRetention(Number(el.value));
  });

  // The feed URL, copied rather than drag-selected out of a sentence
  // (NEWS-309). Reads the field rather than rebuilding the string, so the button
  // cannot copy something different from what is on screen.
  void delegate(root, 'click', '[data-action=copy-feed-url]', () => {
    const field = root.querySelector<HTMLInputElement>('[data-action=feed-url]');
    if (field === null) return;
    field.select();
    void navigator.clipboard.writeText(field.value).then(
      () => { showToast('Feed URL copied'); },
      () => { showToast('Could not copy — select the field and copy it manually.'); },
    );
  });

  // One click is enough without reaching for the button.
  void delegate(root, 'focus', '[data-action=feed-url]', (_e, el) => {
    if (el instanceof HTMLInputElement) el.select();
  });

  // --- first-run flow (NEWS-78) ---------------------------------------------

  void delegate(root, 'click', '[data-undo-clear]', (_e, el) => {
    const id = el.getAttribute('data-undo-clear');
    if (id !== null) void undoClear(id);
  });

  void delegate(root, 'click', '[data-starter-topic]', (_e, el) => {
    const name = el.getAttribute('data-starter-topic');
    if (name !== null) appStore.actions.toggleOnboardingTopic(name);
  });

  void delegate(root, 'click', '[data-profile]', (_e, el) => {
    const id = el.getAttribute('data-profile');
    if (id !== null) appStore.actions.toggleOnboardingProfile(id);
  });

  // Skips the remaining profile *pages*, not the wizard. Saves what is already
  // ticked on the way out — a user who picked six things on page one and then
  // skipped meant to keep the six.
  void delegate(root, 'click', '[data-action=profiles-skip]', () => {
    void saveProfilesAndAdvance();
  });

  void delegate(root, 'change', '[data-action=onboarding-location]', (_e, el) => {
    if (el instanceof HTMLInputElement) void updateLocation(el.value.trim());
  });

  void delegate(root, 'click', '[data-location-pick]', (_e, el) => {
    const name = el.getAttribute('data-location-pick');
    // Re-clicking the chosen continent clears it, so the row is a toggle rather
    // than a one-way door — there is no other way back to "no location" here.
    if (name !== null) void updateLocation(appStore.state.value.settings.location === name ? '' : name);
  });

  void delegate(root, 'click', '[data-action=onboarding-skip]', () => {
    closeOnboarding();
  });

  void delegate(root, 'click', '[data-action=onboarding-next]', () => {
    const current = appStore.state.value.onboarding;
    if (current === null || current === 'auto') return;
    // The profile picker holds three pages behind one step, so Continue pages
    // through them before it advances the wizard (NEWS-383).
    if (current === 'profiles') {
      const { page, advanceStep } = nextProfilePage(appStore.state.value.onboardingProfilePage, PROFILE_PAGE_COUNT);
      if (!advanceStep) {
        appStore.actions.setOnboardingProfilePage(page);
        return;
      }
      void saveProfilesAndAdvance();
      return;
    }
    // Past the end means "done" — indexing a readonly tuple past its length is
    // typed as never-undefined, so the bound is checked explicitly.
    const at = ONBOARDING_STEPS.indexOf(current) + 1;
    if (at >= ONBOARDING_STEPS.length) {
      // Last step: create whatever was chosen, then get out of the way. Topics
      // are added one at a time because each POST fires its own first check.
      //
      // Only the starter chips reach here. Anything from discovery was created at
      // the moment it was added, with its guidance and classification (NEWS-146) —
      // which is also how it gets a narrowed first check, something a name-only
      // create could never do.
      const state = appStore.state.value;
      // Profiles contribute topics too (NEWS-382), and the ticked chips win any
      // overlap: a name the user typed or picked themselves is a stronger signal
      // than one derived from "you said you like food". `exclude` also carries
      // what already exists, so reopening the guide for an existing user cannot
      // propose something they are already watching.
      const fromProfiles = topicsForProfiles(state.settings.profiles, {
        exclude: [...state.onboardingTopics, ...state.topics.map((t) => t.name)],
      });
      const chosen = [...state.onboardingTopics, ...fromProfiles];
      closeOnboarding();
      void (async () => {
        for (const name of chosen) {
          await addTopic(name);
        }
      })();
      return;
    }
    advanceOnboardingTo(ONBOARDING_STEPS[at]);
  });

  // --- topic guidance (NEWS-80) --------------------------------------------

  void delegate(root, 'submit', '[data-save-rename]', (e, form) => {
    e.preventDefault();
    const id = form.getAttribute('data-save-rename');
    const field = form.querySelector<HTMLInputElement>('input[name=topic-name]');
    const clearBox = form.querySelector<HTMLInputElement>('input[name=clear-items]');
    if (id === null || !field) return;
    const name = field.value.trim();
    if (name === '') return;
    const catSel = form.querySelector<HTMLSelectElement>('select[name=topic-category]');
    const subSel = form.querySelector<HTMLSelectElement>('select[name=topic-subcategory]');
    // Absent select means the dialog predates this field; `''` means "let
    // Newsmonger decide", which is a real instruction (clear it *and* make the
    // topic eligible for automatic classification again) and not the same as
    // "leave it alone" (FR-22.7).
    const category =
      catSel === null
        ? undefined
        : {
            category: catSel.value === '' ? null : catSel.value,
            subcategory: catSel.value === '' || !subSel || subSel.value === '' ? null : subSel.value,
          };
    void saveRename(id, name, clearBox?.checked === true, category);
  });

  // Re-render only the subcategory container, not the form: the section decides
  // which subjects exist, and re-rendering the whole dialog would discard a
  // half-typed name (NEWS-407).
  void delegate(root, 'change', '[data-action=rename-category]', (_e, el) => {
    if (!(el instanceof HTMLSelectElement)) return;
    appStore.actions.setRenameCategory(el.value === '' ? null : el.value);
  });

  void delegate(root, 'change', '[data-action=rename-subcategory]', (_e, el) => {
    if (el instanceof HTMLSelectElement) appStore.actions.setRenameSubcategory(el.value === '' ? null : el.value);
  });

  void delegate(root, 'click', '[data-action=close-rename]', () => {
    appStore.actions.closeRename();
  });

  void delegate(root, 'click', '[data-action=rename-backdrop]', (e, el) => {
    if (e.target === el) appStore.actions.closeRename();
  });

  void delegate(root, 'submit', '[data-save-guidance]', (e, form) => {
    e.preventDefault();
    const id = form.getAttribute('data-save-guidance');
    const field = form.querySelector<HTMLTextAreaElement>('textarea[name=guidance]');
    if (id === null || !field) return;
    const guidance = field.value.trim();
    appStore.actions.closeGuidance();
    void setTopicGuidance(id, guidance).then(() => {
      // Guidance only takes effect on the *next* check, so say so — otherwise
      // saving looks like it did nothing until tomorrow's sweep.
      showToast(guidance === '' ? 'Guidance cleared' : 'Guidance saved — applies from the next check');
    });
  });

  void delegate(root, 'click', '[data-action=close-guidance]', () => {
    appStore.actions.closeGuidance();
  });

  // Only a click that landed on the backdrop itself closes — matching
  // descendants would dismiss the dialog on the way to Save (see docs/3-ui.md).
  void delegate(root, 'click', '[data-action=guidance-backdrop]', (e, el) => {
    if (e.target === el) appStore.actions.closeGuidance();
  });

  // --- topic selection -----------------------------------------------------

  void delegate(root, 'click', '[data-topic-row]', (e, el) => {
    const id = el.getAttribute('data-topic-row');
    if (id === null || !(e instanceof MouseEvent)) return;
    // Cmd on macOS, Ctrl elsewhere — reading both is simpler and more forgiving
    // than sniffing the platform, and no OS uses them for conflicting meanings.
    const toggle = e.metaKey || e.ctrlKey;
    const range = e.shiftKey;
    selectTopic(id, { toggle, range });
    if (!toggle && !range && e.detail === 1) {
      const prior = appStore.state.value.soloTopicIds;
      const next = transferSingleSolo(prior, id);
      clickSoloTransfer = next.length === 1 && next[0] === id && prior[0] !== id
        ? { id, prior: [...prior] }
        : null;
      if (next[0] !== prior[0]) {
        appStore.actions.setSolo(next);
        void refreshFeed();
        void refreshPulseSurfaces();
      }
    }
  });

  // --- section filter bar (NEWS-97) ----------------------------------------

  void delegate(root, 'click', '[data-filter-category]', (_e, el) => {
    const slug = el.getAttribute('data-filter-category') ?? '';
    // Selecting a category always resets the sub-row: the previous subcategory
    // belongs to a different parent and would match nothing.
    appStore.actions.setCategoryFilter(slug === '' ? null : { category: slug, subcategory: null });
    void refreshFeed();
    void refreshPulseSurfaces();
  });

  void delegate(root, 'click', '[data-filter-subcategory]', (_e, el) => {
    const current = appStore.state.value.categoryFilter;
    if (current === null) return;
    const slug = el.getAttribute('data-filter-subcategory') ?? '';
    appStore.actions.setCategoryFilter({ category: current.category, subcategory: slug === '' ? null : slug });
    void refreshFeed();
    void refreshPulseSurfaces();
  });

  // Double-click toggles solo (NEWS-95) — the one topic action common enough to
  // deserve a gesture instead of a trip through the right-click menu.
  //
  // Acts on the double-clicked row alone, never the wider selection: the two
  // clicks that make up the gesture have already collapsed the selection to
  // this row (a plain click sets it), so anything else would act on rows the
  // user can no longer see are targeted.
  //
  // Routed through `runTopicAction` rather than reimplemented, so the gesture
  // and the menu item can't drift apart — including the additive behaviour,
  // where soloing a second topic widens the filter instead of replacing it.
  // `.topic` is `user-select: none`, so this can't leave a stray text selection.
  void delegate(root, 'dblclick', '[data-topic-row]', (e, el) => {
    const id = el.getAttribute('data-topic-row');
    if (id === null || !(e instanceof MouseEvent)) return;
    const transferred = clickSoloTransfer?.id === id ? clickSoloTransfer : null;
    clickSoloTransfer = null;
    if (transferred === null) {
      runTopicAction('solo', [id]);
    } else {
      appStore.actions.setSolo(toggleSolo(transferred.prior, [id]));
      void refreshFeed();
      void refreshPulseSurfaces();
    }
  });

  // Keyboard equivalents for the row (NEWS-90). The context menu is the only
  // route to check / pause / priority / guidance / solo / delete, so without
  // these the whole topic action set is mouse-only.
  void delegate(root, 'keydown', '[data-topic-row]', (e, el) => {
    const id = el.getAttribute('data-topic-row');
    if (id === null || !(e instanceof KeyboardEvent)) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectTopic(id, { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey });
      return;
    }
    // The platform gesture for "open this element's menu": macOS has no Menu
    // key, so Shift+F10 is the one that has to work everywhere.
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      openTopicMenuFor(id, el);
    }
  });

  void delegate(root, 'contextmenu', '[data-topic-row]', (e, el) => {
    const id = el.getAttribute('data-topic-row');
    if (id === null || !(e instanceof MouseEvent)) return;
    e.preventDefault();
    const current = appStore.state.value.selectedTopicIds;
    // Right-clicking inside the selection acts on all of it; right-clicking
    // outside it selects that row first, so the menu never acts on rows the
    // user can't see are targeted.
    const topicIds = current.includes(id) ? current : [id];
    if (!current.includes(id)) {
      appStore.actions.setSelection([id]);
      anchorId = id;
    }
    appStore.actions.openContextMenu({ x: e.clientX, y: e.clientY, topicIds });
  });

  // Only a click that landed on the backdrop itself dismisses. The backdrop
  // wraps the menu, so matching descendants too would close the menu before the
  // item handler below could read `contextMenu` — the same trap the settings
  // dialog hit (see docs/3-ui.md).
  void delegate(root, 'click', '[data-action=close-menu]', (e, el) => {
    if (e.target === el) appStore.actions.closeContextMenu();
  });

  void delegate(root, 'click', '[data-menu-action]', (_e, el) => {
    const action = el.getAttribute('data-menu-action');
    const menu = appStore.state.value.contextMenu;
    if (action === null || menu === null) return;
    appStore.actions.closeContextMenu();
    runTopicAction(action, menu.topicIds);
  });

  // --- Story context menu (bookmark / share / flag), NEWS-61 ---
  void delegate(root, 'contextmenu', '[data-item-id]', (e, el) => {
    const id = el.getAttribute('data-item-id');
    if (id === null || !(e instanceof MouseEvent)) return;
    e.preventDefault();
    appStore.actions.openItemMenu({ x: e.clientX, y: e.clientY, itemId: id });
  });
  void delegate(root, 'click', '[data-action=close-item-menu]', (e, el) => {
    if (e.target === el) appStore.actions.closeItemMenu();
  });
  void delegate(root, 'click', '[data-item-menu-action]', (_e, el) => {
    const action = el.getAttribute('data-item-menu-action');
    const menu = appStore.state.value.itemMenu;
    if (action === null || menu === null) return;
    const item = feedAndFlagged().find((i) => i.id === menu.itemId);
    appStore.actions.closeItemMenu();
    if (item === undefined) return;
    if (action === 'bookmark') void setItemSaved(item.id, !item.saved);
    else if (action === 'share') void shareOne(item);
    else if (action === 'flag') flagItem(item, !item.offTopic);
  });
  // Clicking the "off topic" pill on a collapsed row prompts to unflag.
  void delegate(root, 'click', '[data-unflag-prompt]', (_e, el) => {
    const id = el.getAttribute('data-unflag-prompt');
    if (id === null) return;
    void (async () => {
      if (await confirm('Unflag this story? It will return to the feed.', { confirmLabel: 'Unflag' })) {
        appStore.actions.removeRecentlyFlagged(id);
        await setItemOffTopic(id, false);
        await refreshFeed();
      }
    })();
  });
  void delegate(root, 'click', '[data-action=exit-review]', () => {
    appStore.actions.setReviewTopicIds([]);
    void refreshFeed();
  });

  void delegate(root, 'click', '[data-action=clear-solo]', () => {
    appStore.actions.setSolo([]);
    void refreshFeed();
    void refreshPulseSurfaces();
  });
  void delegate(root, 'click', '[data-action=exit-solo-pulse]', () => {
    appStore.actions.setSolo([]);
    void refreshFeed();
    void refreshPulseSurfaces();
  });

  // --- Topic/category pulse (NEWS-453) ------------------------------------

  void delegate(root, 'click', '[data-open-pulse-kind]', (_e, el) => {
    const kind = el.getAttribute('data-open-pulse-kind');
    const id = el.getAttribute('data-open-pulse-id');
    if ((kind !== 'topic' && kind !== 'category') || id === null) return;
    const subcategory = el.getAttribute('data-open-pulse-subcategory');
    void loadPulseDetail({ kind, id, subcategory: subcategory === '' ? null : subcategory }, 30);
  });
  void delegate(root, 'click', '[data-action=close-pulse]', (e, el) => {
    if (e.target === el || el.classList.contains('icon')) appStore.actions.closePulse();
  });
  void delegate(root, 'click', '[data-pulse-days]', (_e, el) => {
    const raw = Number(el.getAttribute('data-pulse-days'));
    if (raw !== 7 && raw !== 30 && raw !== 90) return;
    const pulse = appStore.state.value.pulseDetail;
    if (pulse === null) return;
    void loadPulseDetail(
      { kind: pulse.scope.kind, id: pulse.scope.id, subcategory: pulse.scope.subcategory },
      raw,
    );
  });

  // --- Expandable story card (NEWS-281) ---
  //
  // ONE delegate for the whole gesture, the expander button included, per the
  // NEWS-126 lesson: `delegate()` runs every matching handler for the same
  // click, and the first one to re-render moves the DOM under the ones that
  // follow. A second handler on the button would have to guess whether this one
  // had already fired.
  //
  // Left-click only — `contextmenu` still opens the story menu, untouched.
  void delegate(root, 'click', '[data-item-id]', (e, el) => {
    const id = el.getAttribute('data-item-id');
    if (id === null || !(e.target instanceof Element)) return;
    // The expander's presence *is* the affordance, so ask the DOM rather than
    // re-deriving "is this expandable" from the variant: a flagged one-liner and
    // a review-mode card both render without one, and both must stay inert.
    if (el.querySelector('[data-expand-item]') === null) return;
    const target = e.target;
    if (target.closest('[data-expand-item]') === null) {
      // Everything else that already owns a click inside the card. Without these
      // the toggle rides along with the action the user actually pressed — most
      // visibly on a source link, which would open a tab AND move the card.
      if (target.closest('.item-actions') !== null) return;
      if (target.closest('ul.sources') !== null) return;
      // Content the pane will grow in NEWS-282 is its own; clicking into it must
      // not close the thing it is inside.
      if (target.closest('.item-pane') !== null) return;
      // Selecting the summary ends in a click on the card. Collapsing the story
      // someone is copying out of would be the worst possible reading of that.
      const selection = window.getSelection();
      if (selection !== null && !selection.isCollapsed) return;
    }
    appStore.actions.toggleItemExpanded(id);
    // Fetch the thread **on expand only** (NEWS-282), and only when the feed's
    // thread summary says there is one — a thread of one needs no request, which
    // is the majority of cards. `loadThread` also owns the cache, so a
    // collapse/re-expand costs nothing.
    if (appStore.state.value.expandedItemId === id) void loadThread(id);
  });

  // Retry a thread whose fetch failed (NEWS-282). A separate delegate is safe
  // here — unlike the NEWS-126 case — because the expand handler above returns
  // early for anything inside `.item-pane`, so exactly one of the two acts.
  void delegate(root, 'click', '[data-retry-thread]', (_e, el) => {
    const id = el.getAttribute('data-retry-thread');
    if (id === null) return;
    void loadThread(id);
  });

  void delegate(root, 'click', '[data-action=show-all-thread]', () => {
    appStore.actions.showAllThread();
  });

  void delegate(root, 'click', '[data-save-item]', (_e, el) => {
    const id = el.getAttribute('data-save-item');
    if (id === null) return;
    const saved = el.getAttribute('data-saved') === 'true';
    void setItemSaved(id, !saved);
  });
  void delegate(root, 'click', '[data-share-item]', (_e, el) => {
    const id = el.getAttribute('data-share-item');
    if (id === null) return;
    const item = feedAndFlagged().find((i) => i.id === id);
    if (item !== undefined) void shareOne(item);
  });
  void delegate(root, 'click', '[data-action=toggle-saved-filter]', () => {
    appStore.actions.setSavedFilter(!appStore.state.value.savedFilter);
    void refreshFeed();
  });
  void delegate(root, 'click', '[data-action=clear-saved-filter]', () => {
    appStore.actions.setSavedFilter(false);
    void refreshFeed();
  });

  // Live feed search (NEWS-60/76). The input is uncontrolled — no `value`
  // binding — so re-rendering can't fight the cursor. Search is now a server
  // query (NEWS-76), so the refetch is debounced rather than per-keystroke.
  void delegate(root, 'input', '[data-action=search]', (_e, el) => {
    appStore.actions.setSearchQuery((el as HTMLInputElement).value);
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => void refreshFeed(), SEARCH_DEBOUNCE_MS);
  });
  void delegate(root, 'click', '[data-action=show-more]', () => {
    appStore.actions.showMoreFeed();
    void refreshFeed();
  });

  void delegate(root, 'click', '[data-action=clear-search]', (_e, el) => {
    // Clear the store AND the uncontrolled input's live value, then refocus it.
    clearTimeout(searchDebounce);
    appStore.actions.setSearchQuery('');
    const input = el.closest('.search')?.querySelector<HTMLInputElement>('[data-action=search]');
    if (input) {
      input.value = '';
      input.focus();
    }
    void refreshFeed();
  });

  void delegate(root, 'click', '[data-action=dismiss-error]', () => {
    appStore.actions.setError(null);
  });
  // Server-owned, unlike every other banner here: dismissing deletes the row,
  // so the notice cannot come back on the next poll or the next launch
  // (NEWS-340). Cleared locally first so the banner goes on the click rather
  // than up to four seconds later.
  void delegate(root, 'click', '[data-action=dismiss-quarantine]', () => {
    appStore.actions.setQuarantine(null);
    void dismissQuarantine();
  });
  // The warning is derived from the runs list, so dismissal is by run id — a
  // later, different failure has a new id and shows again.
  void delegate(root, 'click', '[data-action=dismiss-warn]', (_e, el) => {
    const id = el.getAttribute('data-run-id');
    if (id !== null) appStore.actions.dismissRun(id);
  });
  void delegate(root, 'click', '[data-action=dismiss-behind]', () => {
    appStore.actions.dismissBehind();
  });
  void delegate(root, 'click', '[data-action=install-update]', () => {
    void installPendingUpdate();
  });
  void delegate(root, 'click', '[data-action=dismiss-update]', () => {
    appStore.actions.dismissUpdate();
  });
  void delegate(root, 'click', '[data-action=check-updates]', () => {
    appStore.actions.setUpdateChecking(true);
    void requestUpdateCheck().then((message) => {
      appStore.actions.setUpdateCheckMessage(message);
    });
  });

  // Notification toggle. Enabling requires a permission grant, and the request
  // must ride the user gesture that is this change event.
  void delegate(root, 'change', '[data-action=notify-toggle]', (_e, el) => {
    const wantsOn = (el as HTMLInputElement).checked;
    if (!wantsOn) {
      appStore.actions.setNotifyPermissionDenied(false);
      void setNotifyOnNewItems(false);
      return;
    }
    void (async () => {
      const granted = await ensureNotificationPermission();
      appStore.actions.setNotifyPermissionDenied(!granted);
      if (granted) {
        // Persist only when we can actually deliver — otherwise the box would
        // read "on" while nothing ever fires.
        await setNotifyOnNewItems(true);
      } else {
        // The user's click already checked the box. The stored setting stays
        // false, but false→false is no attribute change, so morph won't reset
        // the live `checked` property — do it by hand.
        (el as HTMLInputElement).checked = false;
      }
    })();
  });

  void delegate(root, 'click', '[data-action=confirm-ok]', () => {
    resolveConfirm(true);
  });
  void delegate(root, 'click', '[data-action=confirm-cancel]', () => {
    resolveConfirm(false);
  });
  // Backdrop click-away cancels. Same nesting caveat as the settings dialog:
  // only a click on the backdrop element itself, not a bubbled one from inside.
  void delegate(root, 'click', '[data-action=confirm-backdrop]', (e, el) => {
    if (e.target === el) resolveConfirm(false);
  });

  /*
   * Outbound links, handed to the system browser inside Tauri (FR-3.8).
   *
   * `el.href`, **not** `getAttribute('href')` (NEWS-401). The attribute is
   * whatever was authored; the property is the resolved absolute URL, and
   * `/api/open-external` parses what it is given with `new URL()` and rejects
   * anything that is not absolute http(s). Every current user of this hook
   * authors an absolute URL already, so this changes nothing today — it is here
   * so that authoring a relative one cannot silently produce a dead control.
   *
   * That is not hypothetical: the topics export did exactly that. Because
   * `openExternalUrl` returns true whether or not the call succeeds, the click
   * was `preventDefault`ed and the rejection was swallowed, leaving a button
   * that did nothing with no error to show for it.
   */
  void delegate(root, 'click', 'a[data-external]', (e, el) => {
    if (el instanceof HTMLAnchorElement && openExternalUrl(el.href)) e.preventDefault();
  });

  /*
   * Exports, inside the Tauri webview (NEWS-157).
   *
   * `<a download>` is a no-op in the WKWebView: the click is swallowed and
   * nothing is saved, with no error to show for it — the same shape as
   * `window.confirm` (NEWS-39) and `navigator.share` (NEWS-43). Handing the URL
   * to the system browser works because every export already answers with
   * `Content-Disposition: attachment`, so the browser saves it rather than
   * rendering it, and the server is on localhost so the browser can reach it.
   *
   * `el.href`, **not** `getAttribute('href')`: the attribute is the relative
   * string authored above, and `/api/open-external` parses what it is given with
   * `new URL()` and rejects anything that isn't absolute http(s). The property
   * is the resolved absolute URL. Outside Tauri `openExternalUrl` returns false
   * and the browser's own download handling runs untouched.
   */
  void delegate(root, 'click', 'a[data-export]', (e, el) => {
    if (el instanceof HTMLAnchorElement && openExternalUrl(el.href)) e.preventDefault();
    // Deferred by a tick (NEWS-158) so the anchor is not torn out of the DOM
    // inside its own click handler, before the browser has acted on `download`.
    //
    // Honestly: closing synchronously does *not* break the download in headless
    // Chromium — tried it, the tests still pass — so this is caution, not a fix
    // for something observed. It is kept because the environment that matters
    // here is the WKWebView, which is untestable from this side and is the whole
    // reason NEWS-157 existed, and because the same shape of teardown-mid-action
    // did bite once already (the backdrop-dismiss bug in docs/7-api-keys.md).
    if (appStore.state.value.export !== null) {
      setTimeout(() => {
        appStore.actions.closeExport();
      }, 0);
    }
  });

  void delegate(root, 'click', '[data-action=open-export]', () => {
    appStore.actions.openExport();
  });

  void delegate(root, 'click', '[data-action=close-export]', () => {
    appStore.actions.closeExport();
  });

  void delegate(root, 'click', '[data-action=export-backdrop]', (e, el) => {
    if (e.target === el) appStore.actions.closeExport();
  });

  void delegate(root, 'change', '[data-export-scope]', (_e, el) => {
    const scope = el.getAttribute('data-export-scope');
    if (scope === 'all' || scope === 'saved' || scope === 'topic') appStore.actions.patchExport({ scope });
  });

  void delegate(root, 'change', '[data-action=export-topic]', (_e, el) => {
    if (el instanceof HTMLSelectElement) appStore.actions.patchExport({ topicId: el.value });
  });

  void delegate(root, 'change', '[data-export-format]', (_e, el) => {
    const format = el.getAttribute('data-export-format');
    if (format === 'md' || format === 'json') appStore.actions.patchExport({ format });
  });
}

/**
 * Global interactions that aren't scoped to one element: dismissing the
 * selection and menu, and the Delete key.
 */
function wireGlobalKeysAndDismiss(): void {
  document.addEventListener('mousedown', (e) => {
    if (!(e.target instanceof Element)) return;
    // A click on a row, or inside the menu, is handled by its own delegate.
    if (e.target.closest('[data-topic-row]') !== null) return;
    if (e.target.closest('.menu') !== null) return;
    const { selectedTopicIds, contextMenu, itemMenu } = appStore.state.value;
    if (contextMenu !== null) appStore.actions.closeContextMenu();
    if (itemMenu !== null && e.target.closest('[data-item-id]') === null) appStore.actions.closeItemMenu();
    if (selectedTopicIds.length > 0) appStore.actions.setSelection([]);
  });

  document.addEventListener('keydown', (e) => {
    // Tab is trapped inside an open dialog (NEWS-90): without it, tabbing walks
    // out of the modal into the page behind, which a screen-reader user cannot
    // see is still there.
    if (e.key === 'Tab' && trapTabInDialog(e)) return;
    if (e.key === 'Escape') {
      const s = appStore.state.value;
      if (s.confirm !== null) {
        resolveConfirm(false);
        return;
      }
      // Innermost first: a dialog opened over another closes alone.
      if (s.guidanceTopicId !== null) {
        appStore.actions.closeGuidance();
        return;
      }
      if (s.pulseDetailOpen) {
        appStore.actions.closePulse();
        return;
      }
      if (s.privacyOpen) {
        appStore.actions.setPrivacyOpen(false);
        return;
      }
      // Above settings — the export dialog opens over the Data tab (NEWS-158),
      // so Escape must close it and leave Settings standing.
      if (s.export !== null) {
        appStore.actions.closeExport();
        return;
      }
      if (s.settingsOpen) {
        appStore.actions.setSettingsOpen(false);
        return;
      }
      // Above onboarding, because discovery now opens *over* the Topics step
      // (NEWS-146). Without this rung Escape closed the wizard underneath and
      // left discovery floating on top of nothing.
      if (s.discover !== null) {
        appStore.actions.closeDiscover();
        return;
      }
      if (s.onboarding !== null && s.onboarding !== 'auto') {
        closeOnboarding();
        return;
      }
      // An expanded story card (NEWS-281) is page content rather than an
      // overlay, so it closes *after* every dialog — and after the menus, since
      // a menu opens over a card — but before the selection rung, so one press
      // does one thing.
      if (s.contextMenu === null && s.itemMenu === null && s.expandedItemId !== null) {
        appStore.actions.collapseExpandedItem();
        return;
      }
      appStore.actions.closeContextMenu();
      appStore.actions.closeItemMenu();
      appStore.actions.setSelection([]);
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    // Never steal Backspace from the add-topic field — deleting a character
    // must not delete a topic.
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    const { selectedTopicIds } = appStore.state.value;
    if (selectedTopicIds.length === 0) return;
    e.preventDefault();
    confirmDelete(selectedTopicIds);
  });
}

/**
 * Keep Tab inside the frontmost dialog. Returns true when it handled the event.
 *
 * Reads the DOM rather than mirroring dialog state in the store: what is
 * actually focusable is a DOM question (a disabled Save button isn't), and a
 * duplicate model of it would drift.
 */
function trapTabInDialog(e: KeyboardEvent): boolean {
  const dialogs = [...document.querySelectorAll<HTMLElement>('.dialog-backdrop .dialog')];
  const dialog = dialogs.at(-1);
  if (dialog === undefined) return false;
  const focusable = [...dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]')]
    .filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1 && el.offsetParent !== null);
  const first = focusable.at(0);
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) return false;
  const active = document.activeElement;
  // Focus outside the dialog (including on <body> right after it opened) gets
  // pulled to an end of the cycle rather than left to wander the page.
  if (!(active instanceof HTMLElement) || !dialog.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return true;
  }
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
    return true;
  }
  if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/**
 * The poll's *scheduling* lives in `poll.ts` so it can be unit-tested (NEWS-238)
 * — this is only the wiring of what a refresh means here.
 */
/**
 * Move the model onto something the current provider actually offers (NEWS-253).
 *
 * Deliberately only called where a person can see it happen — after a provider
 * change, and when the Source tab opens. A correction applied silently in the
 * background would change which model someone's checks run on without them
 * having touched anything, which is a bigger liberty than fixing a setting they
 * are looking at.
 */
async function applyModelCorrection(): Promise<void> {
  const s = appStore.state.value;
  const next = correctedModel(
    s.settings.provider,
    s.settings.model,
    s.liveModels,
    PROVIDER_MODELS[s.settings.provider],
  );
  if (next !== null) await updateProviderSettings({ model: next });

  // Effort has to follow, and *actually* follow (NEWS-254). Narrowing the menu
  // while settings still held an unsupported level would hide the problem, not
  // fix it: the next check would send it and fail. Read fresh, since the model
  // change above refetched the levels for the new model.
  const after = appStore.state.value;
  const level = correctedEffort({ liveEffortLevels: after.liveEffortLevels, chosen: after.settings.effort });
  if (level !== null) await updateProviderSettings({ effort: level });
}

function startPolling(): void {
  startStatePolling(browserPollDeps(() => void refreshState().then(maybeOfferBackup)));
}

/** Is the app actually in front of the user right now? */
function isForegrounded(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * Heartbeat that permits scheduled checks on subscription-backed providers.
 *
 * Sent on an interval comfortably shorter than the server's window, plus
 * immediately on the events that can make the app foregrounded, so returning
 * to it takes effect at once instead of after the next tick.
 */
function startForegroundHeartbeat(): void {
  const beat = (): void => {
    if (isForegrounded()) void reportForeground();
  };
  beat();
  setInterval(beat, 60_000);
  window.addEventListener('focus', beat);
  document.addEventListener('visibilitychange', beat);
}

/**
 * Compile-time flag, substituted by esbuild (`--define:__KERF_DEV__`). False in
 * `build:client`, true in `build:client:dev`.
 *
 * A literal `false` lets esbuild drop the whole block *and* the `import()` with
 * it, so the dev chunk is never emitted in a production build — that is the
 * point of a define rather than a runtime check. It cannot be
 * `process.env.NODE_ENV`, kerf's own documented form: this is an IIFE browser
 * bundle, `process` doesn't exist, and the read would throw at startup.
 */
declare const __KERF_DEV__: boolean;

/**
 * kerf development diagnostics (NEWS-100). kerf 3.x no longer infers dev mode —
 * installing these is the app's decision, made here.
 *
 * `invariants: 'throw'` is the valuable one: it audits kerf's list bookkeeping
 * against the live DOM after every render and fails at the render that broke
 * it, rather than leaving a wrong picture to be discovered several interactions
 * later. That is exactly the shape KF-377 had.
 *
 * `enableWarnings()` rather than the `KERF_DEV_WARN_*` env vars, which cannot
 * be reached from a browser at all.
 */
if (__KERF_DEV__) {
  void import('kerfjs/dev').then((dev) => {
    dev.enableWarnings({
      invariants: 'throw',
      staleBinding: true,
      narrowSet: true,
      duplicateEachKeys: true,
      listRebind: true,
      staleIndex: true,
      eachInMorphSkip: true,
      delegateInEffect: true,
      rebuiltListeners: true,
      parserRepair: true,
    });
    return dev;
  });
}

/**
 * Poll the shell for an update found by its startup check (NEWS-89).
 *
 * A no-op outside the desktop shell, and silent on failure: a failed update
 * check is not worth a banner. The user is told there's an update, never
 * interrupted by one — nothing here installs anything.
 */
async function pollPendingUpdate(): Promise<void> {
  const invoke = getTauriInvoke();
  if (!invoke) return;

  for (const delay of UPDATE_POLL_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const version = await invoke('get_pending_update');
      if (typeof version === 'string' && version !== '') {
        appStore.actions.setUpdateVersion(version);
        return;
      }
    } catch {
      return;
    }
  }
}

/**
 * Ask the shell to check for an update right now, from Settings (NEWS-89).
 *
 * Returns what to tell the user. Unlike the startup poll this one reports
 * failure and "up to date" — the user asked, so silence would read as a bug.
 */
async function requestUpdateCheck(): Promise<string> {
  const invoke = getTauriInvoke();
  if (!invoke) return 'Updates are managed outside the desktop app.';
  try {
    const version = await invoke('check_for_update');
    if (typeof version === 'string' && version !== '') {
      appStore.actions.setUpdateVersion(version);
      return `Update available: v${version}`;
    }
    return 'Newsmonger is up to date.';
  } catch (error) {
    return updateCheckFailure(error);
  }
}

/**
 * Download and install the pending update (NEWS-89).
 *
 * The new binary only takes effect on relaunch, so this ends at `installed` and
 * asks the user to restart rather than killing the app under them — a news feed
 * they're mid-read is not something to close without asking.
 */
async function installPendingUpdate(): Promise<void> {
  const invoke = getTauriInvoke();
  if (!invoke) return;
  appStore.actions.setUpdateInstall('installing');
  try {
    await invoke('install_update');
    appStore.actions.setUpdateInstall('installed');
  } catch {
    appStore.actions.setUpdateInstall('failed');
  }
}


/**
 * Put the chosen theme on `<html>`, where the stylesheet reads it (FR-3.75).
 *
 * `auto` **removes** the attribute: following the system is the
 * `prefers-color-scheme` query doing its job, and `data-theme="auto"` would be a
 * third state every rule had to exclude.
 *
 * Exported-shaped rather than inlined so the settings handler and the poll can
 * both use it — a restore, or a second window changing the setting, arrives
 * through `/api/state` rather than through the control.
 */
function applyTheme(theme: 'auto' | 'light' | 'dark'): void {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

const root = document.getElementById('app');
if (root) {
  mount(root, () => appJsx());
  // A `<select>` the user has touched stops following the `selected` attribute
  // a morph writes (NEWS-238) — and kerf can only re-sync the property when
  // that attribute *changes*, so a control whose rendered choice stays put
  // never comes back. Registered after `mount` and deferred a microtask so it
  // runs once the morph for this change has finished, whatever order the
  // effects were queued in. See `select-sync.ts`.
  effect(() => {
    void appStore.state.value;
    queueMicrotask(() => syncSelects(root));
  });
  // The theme follows the *setting*, not only the control (FR-3.75, NEWS-334).
  // A restore from backup brings someone else's choice, and a second window can
  // change it — both arrive through `/api/state`, never through the `<select>`
  // on this page. The server stamps the attribute on first paint; this keeps it
  // true afterwards.
  effect(() => {
    applyTheme(appStore.state.value.settings.theme);
  });
  wireEvents(root);
  wireGlobalKeysAndDismiss();
  void refreshState().then(maybeOpenOnboarding).then(maybeOfferBackup);
  void refreshProviders().then(maybeOpenOnboarding);
  // Learn the OS notification permission up front in the desktop shell, so a
  // session that already had notifications on keeps firing them (NEWS-66).
  // Surface an update the shell already found (NEWS-89). Fire-and-forget: the
  // banner appears whenever the answer arrives, which is never on the critical
  // path to reading the news.
  void pollPendingUpdate();
  startPolling();
  startForegroundHeartbeat();
  trackRailTop(root);
}
