/**
 * First-run onboarding (NEWS-297; the wizard itself is NEWS-78/128/146).
 *
 * Fourth seam out of `app.tsx`. Self-contained apart from two things it shares
 * deliberately: `keyRowJsx` (`key-row.tsx`), because the Source step embeds the
 * **real** key rows rather than a reduced copy of them, and the discovery dialog
 * the Topics step opens — the same one the sidebar opens, not a second one
 * (FR-24.18). Neither is incidental; both are the point of those steps.
 *
 * Rendering only: `onboarding-next`, `onboarding-skip`, `open-discover` and the
 * starter chips are handled by `delegate()` in `app.tsx` (NEWS-126). Which step
 * is current, what is ticked and what gets created on Finish live in the store
 * and in `onboarding.ts` — this file only draws them.
 */

import type { SafeHtml } from 'kerfjs';

import { providerLikelyUsable } from './discover.js';
import { icon } from './icons.js';
import { keyRowJsx } from './key-row.js';
import { onboardingCountText } from './onboarding.js';
import type { AppState, OnboardingStep } from './stores.js';
import { appStore, INTERVAL_OPTIONS, ONBOARDING_STEPS, STARTER_TOPICS } from './stores.js';

/**
 * First-run flow (NEWS-78).
 *
 * Four steps, because a new user has four things to learn or decide and no
 * reason to guess at any of them: what the app does, how it authenticates,
 * what to watch, and how often. Skippable at every step — an onboarding you
 * can't escape is worse than none.
 */
export function onboardingJsx(step: OnboardingStep): SafeHtml {
  const s = appStore.state.value;
  const index = ONBOARDING_STEPS.indexOf(step);
  return (
    <div class="dialog-backdrop onboarding-backdrop">
      <div class="dialog onboarding" role="dialog" aria-modal="true" aria-label="Set up Newsmonger">
        <div class="onboarding-body">{onboardingStepJsx(step, s)}</div>
        <div class="onboarding-foot">
          <span class="onboarding-dots" aria-hidden="true">
            {ONBOARDING_STEPS.map((name) => (
              <span class={`dot ${name === step ? 'on' : ''}`} />
            ))}
          </span>
          <span class="onboarding-actions">
            <button class="btn subtle" type="button" data-action="onboarding-skip">
              {index === ONBOARDING_STEPS.length - 1 ? 'Close' : 'Skip setup'}
            </button>
            <button class="btn primary" type="button" data-action="onboarding-next">
              {index === ONBOARDING_STEPS.length - 1 ? 'Start watching' : 'Continue'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

function onboardingStepJsx(step: OnboardingStep, s: AppState): SafeHtml {
  if (step === 'welcome') {
    return (
      <div>
        <h2>Newsmonger watches topics, not feeds.</h2>
        <p class="onboarding-lead">
          Name the things you want to keep up with. On a schedule you choose, Newsmonger asks an AI — with live web
          search — whether anything genuinely new has happened, and shows you only that, with links to the
          sources.
        </p>
        <p class="note">
          Nothing is scraped or subscribed to. Each check is a fresh look, and stories you have already been
          shown are never repeated.
        </p>
        <p class="note">
          A check sends the topic’s name and the titles already reported for it — nothing else leaves this
          machine, and Newsmonger has no servers of its own. The full note is in Settings → Privacy.
        </p>
      </div>
    );
  }
  if (step === 'source') return onboardingSourceJsx(s);
  if (step === 'topics') {
    return (
      <div>
        <h2>What should Newsmonger watch?</h2>
        <p class="onboarding-lead">
          Pick a few to start with — you can add your own, rename them, or delete them at any time.
        </p>
        <div class="starter-topics">
          {STARTER_TOPICS.map((name) => (
            <button
              class={`chip starter ${s.onboardingTopics.includes(name) ? 'on' : ''}`}
              type="button"
              data-starter-topic={name}
              aria-pressed={s.onboardingTopics.includes(name) ? 'true' : 'false'}
            >
              {name}
            </button>
          ))}
        </div>
        {/* Always-present container: the suggestions block appearing must not
            restructure its siblings (see docs/3-ui.md). */}
        <div class="onboarding-suggest">{onboardingSuggestJsx(s)}</div>
        <p class="note">{onboardingCountText(s.onboardingTopics.length, s.topics.length - s.onboardingTopicsAtStart)}</p>
      </div>
    );
  }
  return (
    <div>
      <h2>How often should it check?</h2>
      <p class="onboarding-lead">
        Every check costs a little — in API credit, or in your subscription’s quota — so this is the dial that
        matters most. Once a day suits most topics.
      </p>
      <label class="field">
        <span>Check every</span>
        <select data-action="interval">
          {INTERVAL_OPTIONS.map((o) => (
            <option value={String(o.ms)} selected={o.ms === s.settings.checkIntervalMs ? true : undefined}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <p class="note">You can change this in Settings later.</p>
    </div>
  );
}

/**
 * The "how do you want to pay for this" step.
 *
 * Subscription providers come first when they're actually available: someone
 * already paying for Claude or ChatGPT needs no key at all, and that is by far
 * the shortest path to a working app. Burying it under two key fields would
 * hide the easy answer behind the hard one.
 */
function onboardingSourceJsx(s: AppState): SafeHtml {
  const ready = s.providers.filter((p) => p.name !== 'auto' && p.name !== 'mock' && p.available === true);
  const subscriptions = ready.filter((p) => p.name === 'claude-cli' || p.name === 'codex-cli');
  return (
    <div>
      <h2>Where should the news come from?</h2>
      {subscriptions.length > 0 ? (
        <div>
          <p class="onboarding-lead">
            Found a signed-in subscription on this machine — nothing else to set up. Checks will use it, and
            run while Newsmonger is open.
          </p>
          <ul class="detected">
            {subscriptions.map((p) => (
              <li>
                {icon('ok', 14)}
                <span>{p.label}</span>
              </li>
            ))}
          </ul>
          <p class="note">Prefer to use an API key instead? Add one in Settings — it takes precedence.</p>
        </div>
      ) : ready.length > 0 ? (
        <div>
          <p class="onboarding-lead">A provider is already configured on this machine. You’re ready to go.</p>
          <ul class="detected">
            {ready.map((p) => (
              <li>
                {icon('ok', 14)}
                <span>{p.label}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div>
          <p class="onboarding-lead">
            Newsmonger needs an AI that can search the web. Either sign in to the Claude or Codex CLI on this
            machine, or paste an API key below — it’s stored in your {s.keychainLabel}, never in a file.
          </p>
          <div class="keys">{s.keys.map((k) => keyRowJsx(k, s.keychainLabel, s.keychainAvailable, s.savingKey === k.provider))}</div>
          <div class="key-notes">{s.keyError !== null ? <p class="banner error">{s.keyError}</p> : ''}</div>
          <p class="note">
            Keys are checked with the provider before they’re saved, so a typo shows up here rather than as a
            failed check tomorrow.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Discovery inside onboarding's Topics step (NEWS-128, then NEWS-146; FR-24.18).
 *
 * Setup is where the need is sharpest, and a brand-new user has no topics yet —
 * which makes this the one place suggestions are guaranteed unfiltered by the
 * FR-24.11 exclusions.
 *
 * This used to be a **second, smaller discovery**: a free-text box whose results
 * were chips. It answered the same question as the real dialog with a fraction
 * of its answer — no section grid for someone who can't yet name what they want,
 * no reason or ongoing/evergreen label on a suggestion, no narrower/similar, no
 * second batch. Two implementations of one idea, and the reduced one was the copy
 * a new user met first. So this is now a door to the real thing (NEWS-146), and
 * it opens with `data-action=open-discover` — the *same* attribute the sidebar's
 * grid button uses, so there is still exactly one delegate for "open discovery".
 */
function onboardingSuggestJsx(s: AppState): SafeHtml {
  // Onboarding runs before a provider is necessarily configured — Source comes
  // first but is skippable — so this degrades to the static starters above
  // rather than offering a button that can only fail.
  //
  // The question is precisely "would a request resolve a provider", so this
  // mirrors `resolveProvider`: an explicitly-chosen provider must itself be
  // available, and `auto` falls back to the same order that does. Asking merely
  // whether *any* provider is available gets the explicit case wrong — someone
  // who picked OpenAI and hasn't added a key would be offered a button that
  // cannot work, because an unrelated signed-in CLI happens to be present.
  if (!providerLikelyUsable(s)) {
    return (
      <p class="suggest-note">
        Set up a source above and Newsmonger can suggest topics for you — or just pick from the list.
      </p>
    );
  }
  return (
    <div>
      <button class="btn" type="button" data-action="open-discover">
        {icon('grid')} Discover topics
      </button>
      <p class="suggest-note">
        Describe what you’re into, or browse by section. Anything you add there is created straight away.
      </p>
    </div>
  );
}
