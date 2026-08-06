/**
 * The `--demo` provider (NEWS-212): curated, plausible-looking stories.
 *
 * Exists so the README hero and still screenshots can be captured from the real
 * running app — real server, real check pipeline, real dedup, real rendering —
 * with only the *provider* substituted. Same shape as the `--demo` launch modes
 * in `~/Documents/{glassbox,hotsheet}`.
 *
 * Separate from `createMockProvider` rather than a flag on it, because the two
 * want opposite things from their fixtures. The mock returns the *same two
 * stories every call* on purpose — that is what makes dedup assertable. This one
 * returns a different set on the second check, so a capture can *show* dedup
 * working. Merging them would mean one of the two jobs gets a fixture tuned for
 * the other.
 *
 * The stories are fabricated. See `src/demo.ts` for why they are written the way
 * they are, and why the sources are transparently illustrative.
 */

import type { KeysResp } from '../../api/schemas.js';
import { DEMO_TOPICS, findDemoTopic } from '../../demo.js';
import type {
  CategoryOption,
  CheckResult,
  ConcreteProviderName,
  KnownItem,
  NewsProvider,
  SuggestRequest,
  SuggestResult,
  TokenUsage,
  TopicClassification,
  TopicContext,
} from '../types.js';
import { KEY_ENV_VARS, KEYED_PROVIDERS, PROVIDER_INFO } from '../types.js';
import type { ProbedProvider } from './index.js';

/** Plausible-looking spend, so the diagnostics/usage surfaces aren't all zeroes. */
const USAGE: TokenUsage = {
  inputTokens: 4200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 1100,
  webSearches: 3,
};

/**
 * Match the demo topic's declared category against what the server offered.
 *
 * Returns **slugs**, not labels: `TopicClassification` is validated against the
 * live taxonomy by the caller, so a label here would be rejected and the topic
 * would file itself as unclassified. Matching is done on the *label*, since that
 * is what `src/demo.ts` reads naturally ("Science" / "Climate").
 *
 * An unmatched name yields `null` rather than a guess — a wrong category in a
 * screenshot is worse than no category, because it looks like a working feature
 * doing the wrong thing.
 */
function classify(name: string, options: CategoryOption[]): TopicClassification | null {
  const topic = findDemoTopic(name);
  if (topic === undefined || topic.category === undefined || topic.category === '') return null;
  if (options.length === 0) return null;
  const category = topic.category.toLowerCase();
  const match = options.find((o) => o.label.toLowerCase() === category);
  if (!match) return null;
  const sub =
    topic.subcategory === undefined
      ? undefined
      : match.subcategories.find((s) => s.label.toLowerCase() === topic.subcategory?.toLowerCase());
  return { category: match.slug, subcategory: sub?.slug ?? null };
}

/**
 * The provider the demo capture pretends is configured (NEWS-315).
 *
 * `anthropic`, and nothing else. It is this project's documented default, so a
 * screenshot showing it is showing the ordinary case rather than an unusual
 * setup.
 *
 * The value has to be *some* provider, and the status line's most informative
 * state — `auto` resolving to a named provider — needs exactly one entry of
 * `AUTO_ORDER` to be available. Every alternative encodes the same arbitrariness
 * somewhere; this puts it in one named constant.
 */
const DEMO_AVAILABLE: ConcreteProviderName = 'anthropic';

/**
 * A provider probe that reads the fixture instead of the machine (NEWS-315).
 *
 * `--demo` exists so the README's images can be photographs of the real app. The
 * one thing left in it that read the *capturing machine* was `GET /api/providers`,
 * which probes for signed-in CLIs and present keys. So `assets/stills/settings-source.png`
 * said "ready — via Claude subscription (Claude Code)" on the owner's laptop and
 * "no provider is signed in or keyed" on a machine with nothing configured —
 * a tracked binary whose content depended on who regenerated it, and a small leak
 * of the capturer's environment into a public repo.
 *
 * It was deterministic by accident before NEWS-308, which is why nothing caught
 * it: the line rendered blank on the default `auto` setting, so there was nothing
 * to vary.
 *
 * Deliberately still a *probe* rather than a hardcoded response in the route:
 * the shape, the ordering and the `mock` entry all stay real, so the picker in a
 * capture is the picker users see.
 */
export function demoProbeProviders(): Promise<ProbedProvider[]> {
  const names: ConcreteProviderName[] = ['claude-cli', 'codex-cli', 'anthropic', 'openai', 'mock'];
  return Promise.resolve(
    names.map((name) => ({
      name,
      endpointConfigurable: PROVIDER_INFO[name].endpointConfigurable,
      label: PROVIDER_INFO[name].label,
      available: name === DEMO_AVAILABLE,
    })),
  );
}

/**
 * The API-key panel a capture photographs — **also** fixed (NEWS-315).
 *
 * The ticket named the provider probe. The same screenshot has a second
 * environmental input nobody had noticed: `GET /api/keys` reports, per keyed
 * provider, whether a key is configured and *where it came from*, plus whether a
 * credential store exists and what the platform calls it. So the two key rows
 * read "Paste API key" on a machine with none and announce a configured key on
 * a machine with `ANTHROPIC_API_KEY` exported — and the sentence under them says
 * "Keychain", "System Keyring" or "Credential Manager" depending on the OS.
 *
 * Empty and macOS-shaped, deliberately: the empty state is the one a reader
 * arrives at, it is what the panel is *for*, and a screenshot advertising that
 * someone's key is configured says nothing useful about the app. It reports
 * neither a real key nor a real absence — it reports the fixture.
 */
export function demoKeysResponse(): KeysResp {
  return {
    keys: KEYED_PROVIDERS.map((provider) => ({
      provider,
      label: PROVIDER_INFO[provider].label,
      configured: false,
      source: null,
      envVar: KEY_ENV_VARS[provider],
    })),
    keychainAvailable: true,
    keychainLabel: 'Keychain',
  };
}

export function createDemoProvider(): NewsProvider {
  // Which topics have been checked at least once, so the second check can return
  // the "and here is what's new" set. Per-process, like the demo itself.
  const checked = new Set<string>();

  return {
    // Reports as `mock`, not `demo`. `ConcreteProviderName` is derived from
    // `PROVIDER_NAMES`, which drives the Settings dropdown, the CLI usage line and
    // the docs — adding a name there would advertise a capture-only mode as a
    // provider users can pick. This *is* a fixture provider; it just carries
    // nicer fixtures than the one `--ai-test` uses.
    name: 'mock',
    model: '',
    effort: '' as const,
    // Never gated on a foreground window — a capture runs headless, and a demo
    // that silently refused to check would be a confusing thing to debug.
    attended: false,
    isAvailable: () => Promise.resolve(true),

    suggestTopics(request: SuggestRequest): Promise<SuggestResult> {
      // Discovery offers the demo topics not already followed, so the browse
      // dialog has something realistic in it.
      const exclude = new Set(request.exclude.map((n) => n.toLowerCase()));
      return Promise.resolve({
        usage: USAGE,
        suggestions: DEMO_TOPICS.filter((t) => !exclude.has(t.name.toLowerCase())).map((t) => ({
          name: t.name,
          reason: `Active coverage across ${t.subcategory?.toLowerCase() ?? 'several'} outlets, with genuinely new developments most weeks.`,
          kind: 'ongoing' as const,
          guidance: '',
          classification: classify(t.name, request.categoryOptions ?? []),
        })),
      });
    },

    checkTopic(
      topicName: string,
      _known: KnownItem[],
      _sinceIso: string | null,
      context: TopicContext = {},
    ): Promise<CheckResult> {
      const topic = findDemoTopic(topicName);
      const classification = classify(topicName, context.categoryOptions ?? []);
      if (!topic) {
        // A topic the fixtures don't cover — return nothing rather than generic
        // filler, so anything typed during a capture stays visibly empty instead
        // of quietly inventing stories about it.
        return Promise.resolve({ items: [], usage: USAGE, classification });
      }
      const key = topic.name.toLowerCase();
      const first = !checked.has(key);
      checked.add(key);
      return Promise.resolve({
        items: first ? topic.first : topic.second,
        usage: USAGE,
        classification,
      });
    },
  };
}
