import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Demo fixture data (NEWS-212), **recorded from real coverage** since NEWS-376.
 *
 * Feeds `--demo`, which exists so the README hero and the still screenshots can
 * be captured from the **real running app** rather than mocked up in a design
 * tool. Same approach as `~/Documents/{glassbox,hotsheet}`, which both ship
 * `--demo` launch modes for exactly this.
 *
 * Why not reuse the `--ai-test` mock? Because it is tuned for a different job.
 * Its stories are deliberately generic and identical every call ("Major
 * development in X", sourced from "Example News") — that determinism is what
 * makes dedup testable, and it is precisely wrong for a screenshot: a hero image
 * full of `example.com` placeholders reads as a broken app, not a working one.
 *
 * **The stories used to be invented, and that was the bug** (NEWS-376). They were
 * written to look plausible, with `example.org` links and obviously-illustrative
 * outlet names. The consequence was not the prose: it was that every captured
 * screenshot had **no article images and no favicons**, because the real image
 * pipeline ran, asked a domain that serves neither, and correctly got nothing. A
 * reader of the README saw a news reader that cannot show a picture.
 *
 * So the stories now come from `assets/demo-data/`, captured once from a real
 * provider by `npm run record:demo-data` — real headlines, real outlets, real
 * links, real lead images. The capture is frozen and replayed with no network, so
 * `npm run demo:stills` renders the same thing next month on a machine with no
 * subscription. Same bargain `tests/fixtures/cli-sessions/` strikes, for the same
 * reason.
 *
 * Two beats per topic where the demo needs a "second check found something new"
 * moment: `first` is returned on the first check of a topic, `second` on any
 * later check. That is what makes deduplication *visible* in the hero — the whole
 * point of the product is that a re-check reports only what changed. **The
 * recorder deals one real capture across the two**, holding the newest few back,
 * because a second real check minutes after the first correctly finds nothing.
 * The staging is the only fiction; every headline, link, outlet and picture is
 * real.
 */

/** One recorded story, in the shape a provider returns. */
export interface DemoStory {
  title: string;
  summary: string;
  /** As reported by the outlet, or null. Recorded so the feed's dates are real. */
  publishedAt?: string | null;
  sources: { title: string; url: string }[];
}

/** What `assets/demo-data/stories.json` holds. */
interface DemoFixture {
  capturedAt: string;
  topics: { name: string; first: DemoStory[]; second: DemoStory[] }[];
  /** Article URL → the lead image the real pipeline resolved for it. */
  imagesByArticle: Record<string, { hash: string; sourceUrl: string }>;
  /** Origin → the favicon the real pipeline resolved for it. */
  faviconsByOrigin: Record<string, { hash: string; sourceUrl: string }>;
}

/**
 * Where the recording lives, resolved from this module rather than the cwd.
 *
 * Outside the published package: `files` ships `dist` only, and `--demo` is a
 * capture tool rather than a user feature. A missing fixture therefore degrades
 * to an empty demo rather than throwing — but `tests/unit/demo.test.ts` asserts
 * it is present *and* carries images, so it cannot go missing here unnoticed.
 */
const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/demo-data');

export function demoFixtureDir(): string {
  return FIXTURE_DIR;
}

function loadFixture(): DemoFixture {
  const file = path.join(FIXTURE_DIR, 'stories.json');
  if (!fs.existsSync(file)) {
    return { capturedAt: '', topics: [], imagesByArticle: {}, faviconsByOrigin: {} };
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as DemoFixture;
}

const FIXTURE = loadFixture();

/** The recorded lead image for an article URL, or null. */
export function demoImageFor(articleUrl: string): { hash: string; sourceUrl: string } | null {
  return FIXTURE.imagesByArticle[articleUrl] ?? null;
}

/** The recorded favicon for an origin, or null. */
export function demoFaviconFor(origin: string): { hash: string; sourceUrl: string } | null {
  return FIXTURE.faviconsByOrigin[origin] ?? null;
}

/** When the stories were captured, or `''` when there is no recording. */
export function demoCapturedAt(): string {
  return FIXTURE.capturedAt;
}

function recorded(name: string): { first: DemoStory[]; second: DemoStory[] } {
  return FIXTURE.topics.find((t) => t.name === name) ?? { first: [], second: [] };
}

export interface DemoTopic {
  name: string;
  /**
   * A **label** from `BUILTIN_CATEGORIES`, matched case-insensitively by the demo
   * provider's `classify()` (NEWS-395).
   *
   * A label that no longer resolves is dropped silently — correct behaviour
   * (FR-22.8), and exactly why nobody noticed when a taxonomy edit moved Energy
   * out of Science and left two of these pointing at nothing for four months.
   * `tests/unit/demo.test.ts` now resolves every pair against the live table, so
   * the next taxonomy edit fails the gate instead of quietly un-labelling the
   * screenshots.
   */
  category?: string;
  /** A subcategory label of `category`, same rules. */
  subcategory?: string;
  /**
   * A guidance steer used **only while recording** (NEWS-376), never rendered.
   *
   * One topic has to produce a real *thread* — several stories about one
   * unfolding subject — because the thread still and the hero's timeline beat
   * are both about that, and `capture-stills.ts` throws outright if no topic
   * has one. Real coverage of a broad beat does not cluster: the first capture
   * returned five offshore-wind stories about five unrelated projects, and
   * `planThreadIds` correctly made five threads of one.
   *
   * So the recorder narrows this topic to a single project. The stories are
   * still real reporting about a real thing that really unfolded — which is
   * what a thread *is*. The alternative was inventing one again.
   *
   * It must not name the subject the way the topic does: a topic's own words
   * are stopwords inside it (FR-29.10), so a topic called "Coastal Virginia
   * Offshore Wind" would subtract exactly the words its stories thread on.
   */
  captureGuidance?: string;
  /** Returned by the topic's first check. */
  first: DemoStory[];
  /** Returned by every later check — the "only what's new" beat. */
  second: DemoStory[];
}

/**
 * The demo's topics: names and sections, hand-chosen and stable.
 *
 * Deliberately **not** taken from the recording. The names are what the recorder
 * checks, so they have to exist before a capture does, and the sections are a
 * deliberate choice about what the filter bar demonstrates rather than whatever
 * a classifier happened to answer on the day.
 */
export const DEMO_TOPICS: DemoTopic[] = [
  { name: 'Fusion energy', category: 'Environment', subcategory: 'Energy', ...recorded('Fusion energy') },
  { name: 'Antarctic ice', category: 'Environment', subcategory: 'Climate', ...recorded('Antarctic ice') },
  {
    // **Not** "Offshore wind", and the rename is load-bearing (NEWS-376).
    //
    // This is the topic that has to produce a thread, and real coverage of the
    // project it threads on calls it "Coastal Virginia Offshore Wind" in every
    // headline. Under a topic named "Offshore wind", FR-29.10 subtracts
    // "offshore" and "wind" as the topic's own stopwords — exactly the words the
    // stories share — leaving two, which fails the 40% ratio against headlines
    // this long. Seven stories, six threads.
    //
    // Renaming the topic so it does not contain them leaves those words in play:
    // the same seven stories, unchanged, become **one thread of seven**. The old
    // invented fixture obeyed this rule by accident, by writing its saga about
    // "Dogger Bank" under "Offshore wind"; a real capture does not get to choose
    // what the outlets call things.
    name: 'Renewable energy buildout',
    category: 'Environment',
    subcategory: 'Energy',
    captureGuidance:
      'Report only on the Coastal Virginia Offshore Wind (CVOW) project run by Dominion Energy. Give me the ' +
      'sequence of developments across the past eighteen months as separate stories — one per milestone, cost ' +
      'revision, regulatory step or dispute, oldest first. Name the project in every headline. Six or more ' +
      'stories. Ignore other wind farms and general industry news.',
    ...recorded('Renewable energy buildout'),
  },
  {
    name: 'Semiconductor supply chain',
    category: 'Business',
    subcategory: 'Trade & Supply Chains',
    ...recorded('Semiconductor supply chain'),
  },
];

/**
 * How many stories exist after every topic's **first** check.
 *
 * Derived rather than `topics × 2` (NEWS-292): the thread fixture answers with
 * three, so the arithmetic that held for three symmetric topics silently
 * under-counted the moment a fourth arrived. A capture that waits for too few
 * stories photographs a feed still filling in, which is exactly the kind of
 * flake a manual, rarely-run pipeline does not catch.
 */
export const DEMO_FIRST_CHECK_STORIES = DEMO_TOPICS.reduce((n, t) => n + t.first.length, 0);

/** Look up a demo topic by name, case-insensitively. */
export function findDemoTopic(name: string): DemoTopic | undefined {
  const lower = name.trim().toLowerCase();
  return DEMO_TOPICS.find((t) => t.name.toLowerCase() === lower);
}
