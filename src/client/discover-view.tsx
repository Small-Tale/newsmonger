/**
 * Topic discovery: the dialog, both its doors, the result cards and the tuner
 * (NEWS-297; the feature is NEWS-124–128).
 *
 * Seventh seam out of `app.tsx`. It looked like one of the "stateful dialogs"
 * that would need untangling first, and it does not — because the state machine
 * was already lifted out in NEWS-127. `startTuner`/`judgeCandidate`/`nextRound`/
 * `mergeKept` live in `discover.ts` as pure functions, the session lives in the
 * store, and the request-issuing handlers (`runDiscovery`, `fetchTunerRound`,
 * `enterTuner`, `judgeTunerCandidate`, `finishTuner`, `loadMoreSuggestions`)
 * stayed in `app.tsx` with every other `delegate()`. What was left here is
 * markup, which is why this moved as cleanly as the stateless dialogs did.
 *
 * Rendering only: `discover-nav`, `discover-search`, `data-tuner`,
 * `data-add-suggestion`, `discover-back` and the rest are handled by
 * `delegate()` in `app.tsx` (NEWS-126).
 */

import type { SafeHtml } from 'kerfjs';
import { each } from 'kerfjs';

import type { TopicSuggestion } from '../api/schemas.js';
import { MAX_DISCOVER_QUERY_LENGTH, MAX_TUNE_ROUNDS } from '../api/schemas.js';
import type { TunerState } from './discover.js';
import {
  currentCandidate,
  groupSuggestions,
  kindLabel,
  resultsHeading,
  resultsQualifier,
  sectionFor,
  sectionTiles,
  tunerRationale,
} from './discover.js';
import { animationDurationMs, DEFAULT_TARGET_MS, estimateTargetMs, readDurations } from './discover-progress.js';
import { icon } from './icons.js';
import type { DiscoverState } from './stores.js';

/**
 * Topic discovery (NEWS-126, `docs/24-topic-discovery.md`).
 *
 * Two doors into one result list, and deliberately neither is primary: the box
 * serves someone who sort of knows what they're into, the section grid serves
 * someone who wants to see what exists, and each covers the other's failure. An
 * empty box is "surprise me" (FR-24.3), not an error — which is what stops the
 * blank field being a wall for the very user this feature is for.
 */
export function discoverDialogJsx(d: DiscoverState): SafeHtml {
  return (
    <div class="dialog-backdrop" data-action="discover-backdrop">
      <div class="dialog discover" role="dialog" aria-modal="true" aria-label="Discover topics">
        <div class="discover-head">
          <h2>Discover topics</h2>
          <button class="btn icon" type="button" data-action="close-discover" aria-label="Close">
            {icon('clear')}
          </button>
        </div>

        <form class="discover-search" data-action="discover-search">
          <input
            type="text"
            name="discover-query"
            placeholder="What are you into? — “i cycle and work in biotech”"
            maxLength={MAX_DISCOVER_QUERY_LENGTH}
            autocomplete="off"
            data-morph-skip-children
          />
          <button class="btn primary" type="submit" disabled={d.loading ? true : undefined}>
            Suggest
          </button>
        </form>

        <div class="discover-body">{discoverBodyJsx(d)}</div>
      </div>
    </div>
  );
}

/**
 * The pane below the box: the section grid, a section's subcategories, or results.
 *
 * One always-present container in the caller holds this, so switching panes
 * never restructures the dialog's siblings (see `docs/3-ui.md`).
 */
function discoverBodyJsx(d: DiscoverState): SafeHtml {
  if (d.tuner !== null) return tunerJsx(d.tuner);
  if (d.loading) return discoverWaitingJsx();
  if (d.error !== null) {
    return (
      <div class="discover-status error">
        <p>{d.error}</p>
        <button class="btn" type="button" data-action="discover-retry">
          Try again
        </button>
      </div>
    );
  }
  if (d.view === 'results') return discoverResultsJsx(d);
  return d.section === null ? sectionGridJsx() : subsectionsJsx(d.section);
}

/**
 * What a discovery call looks like while it runs (NEWS-137).
 *
 * The bar is paced entirely by CSS: the estimated duration is handed over as a
 * custom property and a keyframe animation does the rest. No timer, no
 * per-frame re-render — which matters because a 10 Hz re-render of the whole
 * mount would fight the morph for a bar that is decorative by construction.
 *
 * It is `aria-hidden` with the status line beside it doing the announcing: a
 * progress bar whose value is an estimate has nothing truthful to report to a
 * screen reader, and "37%" would be a claim the app cannot stand behind.
 */
function discoverWaitingJsx(): SafeHtml {
  const target = estimateTargetMs(readDurations());
  return (
    <div class="discover-waiting">
      <p class="discover-status">Asking…</p>
      <div
        class="discover-bar"
        aria-hidden="true"
        style={`--discover-duration: ${String(Math.round(animationDurationMs(target)))}ms`}
      >
        <span class="discover-bar-fill" />
      </div>
      <p class="discover-bar-note">
        {target === DEFAULT_TARGET_MS
          ? 'This usually takes half a minute.'
          : `Recent searches took about ${String(Math.round(target / 1000))}s.`}
      </p>
    </div>
  );
}

/**
 * The 11 section tiles (FR-24.2).
 *
 * `.map()`, not `each()` — the sections are a constant array, and `each()`
 * memoizes per item by object identity, so a constant list would cache forever
 * and stop re-rendering (kerf hard rule 14).
 */
function sectionGridJsx(): SafeHtml {
  return (
    <div class="discover-pane">
      <p class="discover-hint">…or browse by section.</p>
      <div class="section-grid">
        {sectionTiles().map((category) => (
          <button class="section-tile" type="button" data-discover-nav={`section:${category.slug}`}>
            {category.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One section's subcategories, plus the escape for someone who knows none of them. */
function subsectionsJsx(slug: string): SafeHtml {
  const category = sectionFor(slug);
  if (category === undefined) return sectionGridJsx();
  return (
    <div class="discover-pane">
      <button class="btn subtle back" type="button" data-action="discover-back">
        ‹ All sections
      </button>
      <h3>{category.label}</h3>
      <div class="section-chips">
        {category.subcategories.map((sub) => (
          <button class="chip" type="button" data-discover-nav={`sub:${slug}/${sub.slug}`}>
            {sub.label}
          </button>
        ))}
        <button class="chip anything" type="button" data-discover-nav={`sub:${slug}/`}>
          Anything in {category.label}
        </button>
      </div>
    </div>
  );
}

/**
 * The result list (FR-24.4), grouped by section.
 *
 * The grouping doubles as a preview of where each topic will file itself in the
 * filter bar once added.
 */
function discoverResultsJsx(d: DiscoverState): SafeHtml {
  const groups = groupSuggestions(d.suggestions);
  return (
    <div class="discover-pane">
      <div class="discover-results-head">
        <button class="btn subtle back" type="button" data-action="discover-back">
          ‹ Back
        </button>
        <h3>{d.source === null ? 'Suggestions' : resultsHeading(d.source)}</h3>
        {/* "closest matches" when the answers don't match the question
            (NEWS-269) — a section drill-in whose results file themselves
            somewhere else. Without it the heading and the group label below
            contradict each other and the honest reading is "the filter broke".
            Always-present span so its arrival can't disturb the keyed group list
            below it (kerf). */}
        <span class="results-qualifier">{resultsQualifier(d.source, groups)}</span>
        {d.suggestions.length === 0 || d.source === null ? (
          ''
        ) : (
          /* Plural, and only here (NEWS-267… NEWS-265): this pair retunes the
             **whole result set**, while the identical-looking pair on each
             suggestion row retunes that one topic. They used to read exactly the
             same — same class, same icon, same word — 470px apart with a
             heading and a group label between them, so nothing but position
             said which anchor a click was committing to. Both start a
             six-round, billable tuner (FR-24.6), so guessing is expensive.
             "these" versus "this" is the whole distinction, carried in one
             word, and the titles name the anchor outright. */
          <span class="results-depth">
            <button
              class="link-btn"
              type="button"
              data-tune={`narrower:${resultsHeading(d.source)}`}
              title={`More specific than “${resultsHeading(d.source)}”`}
            >
              {icon('funnel', 13)} narrow these
            </button>
            <button
              class="link-btn"
              type="button"
              data-tune={`similar:${resultsHeading(d.source)}`}
              title={`Adjacent to “${resultsHeading(d.source)}”`}
            >
              {icon('blend', 13)} more like these
            </button>
          </span>
        )}
      </div>
      {groups.length === 0 ? (
        <p class="discover-status">
          Nothing new to suggest here — you may already follow everything this turned up.
        </p>
      ) : (
        <div class="suggestion-groups">
          {/* Outer `each()` for the keyed group list; inner `.map()` because a
              nested `each()` is never reconciled — the row is flattened to HTML,
              so the inner list would render as static markup and silently stop
              updating. kerf throws on this in dev, which is how it was caught. */}
          {each(
            groups,
            (group) => (
              <div class="suggestion-group" data-key={group.key}>
                <h4 class="suggestion-group-label">{group.label}</h4>
                {group.suggestions.map((suggestion) =>
                  suggestionCardJsx(suggestion, d.added.includes(suggestion.name)),
                )}
              </div>
            ),
            { key: 'suggestion-groups' },
          )}
          {/* Always-present container: the button and the exhausted note swap
              in and out, and a conditional sibling must not restructure the
              keyed list above it (docs/3-ui.md). */}
          <div class="discover-more">{discoverMoreJsx(d)}</div>
        </div>
      )}
    </div>
  );
}

/**
 * The keep/skip tuner (NEWS-127, FR-24.5–24.9).
 *
 * A **depth control**, never an entry point — that distinction is the whole
 * reason this shape was chosen over a tuner-first design. It costs nothing until
 * someone asks to go deeper, and it answers the two questions a static list
 * cannot: *narrower than this* and *more like this*.
 */
function tunerJsx(t: TunerState): SafeHtml {
  const candidate = currentCandidate(t);
  return (
    <div class="discover-pane tuner">
      <div class="tuner-head">
        <span class="tuner-round">
          Round {String(t.round)} of {String(MAX_TUNE_ROUNDS)}
        </span>
        {/* Endable at any point (FR-24.9) — and the only way out, so it is
            never hidden behind a state the user has to reach first. `btn` rather
            than `btn subtle` for the same reason as the review banner's exit
            (NEWS-266): subtle then rendered borderless and transparent, so the
            escape from a six-round flow read as a caption while Skip and Keep
            below it read as buttons. Equal weight to Skip is right — both are
            buttons, and Keep stays the primary. NEWS-305 gave `subtle` a resting
            edge, so the two now differ only in weight; this stays `btn` because
            the *only* way out of a flow should not be the quiet variant. */}
        <button class="btn" type="button" data-tuner="done">
          Done
        </button>
      </div>

      <div class="tuner-body">{tunerCardJsx(t, candidate)}</div>

      <div class="tuner-kept">
        {t.kept.length === 0 ? (
          <span class="tuner-kept-empty">Nothing kept yet.</span>
        ) : (
          <span>
            Kept: {t.kept.map((s) => s.name).join(' · ')}
          </span>
        )}
      </div>
    </div>
  );
}

function tunerCardJsx(t: TunerState, candidate: TopicSuggestion | undefined): SafeHtml {
  if (t.error !== null) {
    return (
      <div class="discover-status error">
        <p>{t.error}</p>
        <button class="btn" type="button" data-tuner="done">
          Back to the list
        </button>
      </div>
    );
  }
  if (t.loading) return <p class="discover-status">Thinking…</p>;
  if (candidate === undefined) {
    return <p class="discover-status">That’s everything — anything you kept is waiting in the list.</p>;
  }
  return (
    <div class="tuner-card">
      <div class="suggestion-main">
        <span class="suggestion-name">{candidate.name}</span>
        <span class={`suggestion-kind ${candidate.kind}`}>{kindLabel(candidate.kind)}</span>
      </div>
      <p class="suggestion-reason">{candidate.reason}</p>
      {/* Why this is being offered (FR-24.8). Without it the loop is a slot
          machine; with it, a user who can see the model has misread them can
          skip out rather than abandon the feature. */}
      <p class="tuner-why">{tunerRationale(t)}</p>
      <div class="tuner-actions">
        <button class="btn" type="button" data-tuner="skip">
          {icon('clear', 14)} Skip
        </button>
        <button class="btn primary" type="button" data-tuner="keep">
          {icon('bookmark', 14)} Keep
        </button>
      </div>
    </div>
  );
}

/**
 * "More like these" for the whole result list (NEWS-136).
 *
 * Every press is a billable call, so when a round comes back with nothing new
 * the button is replaced by a plain statement rather than left there to be
 * pressed again — an exhausted seam should be visible, not discovered.
 */
function discoverMoreJsx(d: DiscoverState): SafeHtml {
  if (d.exhausted) {
    return <p class="discover-more-note">That’s everything for this search — try another wording or section.</p>;
  }
  return (
    <button class="btn" type="button" data-action="discover-more" disabled={d.loadingMore ? true : undefined}>
      {d.loadingMore ? 'Finding more…' : 'More suggestions'}
    </button>
  );
}

/** One suggestion. Stays put once added — see `DiscoverState.added`. */
function suggestionCardJsx(suggestion: TopicSuggestion, added: boolean): SafeHtml {
  return (
    <div class={`suggestion ${added ? 'added' : ''}`} data-key={suggestion.name}>
      <div class="suggestion-main">
        <span class="suggestion-name">{suggestion.name}</span>
        <span class={`suggestion-kind ${suggestion.kind}`}>{kindLabel(suggestion.kind)}</span>
      </div>
      <p class="suggestion-reason">{suggestion.reason}</p>
      {added ? (
        <span class="suggestion-added">{icon('ok')} Added</span>
      ) : (
        <button class="btn" type="button" data-add-suggestion={suggestion.name}>
          + Add
        </button>
      )}
      {/* The depth controls (FR-24.5). One attribute, one delegate — see the
          delegate/morph rule in docs/3-ui.md. */}
      <span class="suggestion-depth">
        <button class="link-btn" type="button" data-tune={`narrower:${suggestion.name}`} title="More specific than this">
          {icon('funnel', 13)} narrower
        </button>
        <button class="link-btn" type="button" data-tune={`similar:${suggestion.name}`} title="Adjacent to this">
          {icon('blend', 13)} similar
        </button>
      </span>
    </div>
  );
}
