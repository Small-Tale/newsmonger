/**
 * Demo fixture data (NEWS-212).
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
 * These stories are **invented, not real reporting.** They are written to look
 * like plausible summaries of the kind of thing each topic surfaces, with source
 * names that are obviously illustrative rather than impersonating a real
 * outlet's byline. Nothing here should ever be presented as actual news.
 *
 * Two beats per topic where the demo needs a "second check found something new"
 * moment: `first` is returned on the first check of a topic, `second` on any
 * later check. That is what makes deduplication *visible* in the hero — the
 * whole point of the product is that a re-check reports only what changed.
 */

/** One fabricated story, in the shape a provider returns. */
export interface DemoStory {
  title: string;
  summary: string;
  sources: { title: string; url: string }[];
}

export interface DemoTopic {
  name: string;
  category?: string;
  subcategory?: string;
  /** Returned by the topic's first check. */
  first: DemoStory[];
  /** Returned by every later check — the "only what's new" beat. */
  second: DemoStory[];
}

export const DEMO_TOPICS: DemoTopic[] = [
  {
    name: 'Fusion energy',
    category: 'Science',
    subcategory: 'Energy',
    first: [
      {
        title: 'Tokamak run holds plasma for 22 minutes, a new record for the design',
        summary:
          'A long-pulse experiment sustained a stable plasma for just over 22 minutes, roughly triple the facility’s previous best. The team credits an upgraded divertor for shedding heat without contaminating the core. It is a step toward continuous operation rather than a net-energy milestone.',
        sources: [
          { title: 'Illustrative Science Daily', url: 'https://example.org/fusion/tokamak-long-pulse' },
          { title: 'Illustrative Physics Wire', url: 'https://example.org/fusion/divertor-upgrade' },
        ],
      },
      {
        title: 'Private fusion firm raises $900M, but shifts its first-power target to 2032',
        summary:
          'The round is among the largest in the sector so far. In the same announcement the company moved its demonstration timeline out by three years, citing magnet manufacturing rather than physics as the constraint.',
        sources: [{ title: 'Illustrative Business Review', url: 'https://example.org/fusion/funding-round' }],
      },
    ],
    second: [
      {
        title: 'Regulators publish the first licensing framework written for fusion, not fission',
        summary:
          'The proposed rules treat fusion devices as radiological facilities rather than reactors, which removes several requirements that developers argued were designed for a fundamentally different risk profile. A consultation period runs for 90 days.',
        sources: [{ title: 'Illustrative Policy Desk', url: 'https://example.org/fusion/licensing-framework' }],
      },
    ],
  },
  {
    name: 'Antarctic ice',
    category: 'Science',
    subcategory: 'Climate',
    first: [
      {
        title: 'Winter sea-ice maximum comes in fourth-lowest on the satellite record',
        summary:
          'The annual maximum fell well below the long-term average for the ninth year running. Researchers are careful to separate the trend from year-to-year variability, which around Antarctica is unusually large.',
        sources: [{ title: 'Illustrative Earth Observer', url: 'https://example.org/ice/sea-ice-maximum' }],
      },
      {
        title: 'Sub-ice survey finds a channel of warm water reaching further inland than mapped',
        summary:
          'An autonomous vehicle traced relatively warm water along a bedrock trough beneath a major glacier. The finding matters because melting driven from below is harder to observe and slower to reverse than surface melt.',
        sources: [
          { title: 'Illustrative Polar Journal', url: 'https://example.org/ice/warm-water-channel' },
          { title: 'Illustrative Ocean Report', url: 'https://example.org/ice/auv-survey' },
        ],
      },
    ],
    second: [
      {
        title: 'Reanalysis trims a widely cited sea-level projection by about 15 centimetres',
        summary:
          'A revised treatment of ice-cliff collapse lowers the upper end of one prominent 2100 estimate. The authors stress that the change reflects better constrained physics, not a reduced overall risk.',
        sources: [{ title: 'Illustrative Climate Review', url: 'https://example.org/ice/projection-revised' }],
      },
    ],
  },
  {
    name: 'Semiconductor supply chain',
    category: 'Business',
    subcategory: 'Technology',
    first: [
      {
        title: 'Second advanced packaging plant announced as bottleneck moves downstream',
        summary:
          'With leading-edge wafer capacity easing, packaging has become the constraint for high-bandwidth memory parts. The new site is intended to come online in stages from late next year.',
        sources: [{ title: 'Illustrative Industry Wire', url: 'https://example.org/chips/packaging-plant' }],
      },
      {
        title: 'Export rules widened to cover a class of chipmaking subsystems',
        summary:
          'The update targets components rather than complete tools, closing a route that had remained open. Suppliers have 120 days to comply, and two have already said existing service contracts are affected.',
        sources: [{ title: 'Illustrative Trade Desk', url: 'https://example.org/chips/export-rules' }],
      },
    ],
    second: [
      {
        title: 'Memory prices climb a fourth straight quarter on AI server demand',
        summary:
          'Contract prices rose again, and buyers are reportedly signing longer agreements to secure supply. Analysts expect the run to continue until the packaging capacity above actually lands.',
        sources: [{ title: 'Illustrative Market Monitor', url: 'https://example.org/chips/memory-prices' }],
      },
    ],
  },
];

/** Topic names in the order the demo adds them. */
export const DEMO_TOPIC_NAMES = DEMO_TOPICS.map((t) => t.name);

/** Look up a demo topic by name, case-insensitively. */
export function findDemoTopic(name: string): DemoTopic | undefined {
  const lower = name.trim().toLowerCase();
  return DEMO_TOPICS.find((t) => t.name.toLowerCase() === lower);
}
