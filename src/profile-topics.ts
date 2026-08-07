/**
 * Default topics per reader profile (NEWS-382, from the research in NEWS-387).
 *
 * Five per profile, **ordered by expected reader pull × news volume**. The order
 * is not cosmetic — it is the selection mechanism. Someone who ticks ten
 * profiles must not get fifty topics, because every topic is its own check and
 * FR-20.6 already says so at the moment of choosing. `topicsForProfiles` takes
 * the highest-ranked few from each, so the depth per profile falls as the tick
 * count rises. A flat unordered set of five would make that impossible.
 *
 * **Every entry is a standing beat, not a story.** The rule applied to all 240:
 *
 * \> Would this name have made sense in 2015, and will it still make sense in 2035?
 *
 * That rejects named entities — companies, people, products, individual
 * tournaments — and accepts subjects a newsroom could assign a reporter to for a
 * decade. "EV battery technology" survives; "Tesla's next model" does not. The
 * list ships once and is read for years, so anything *ongoing* in the FR-24.10
 * sense is a bug with a delayed fuse.
 *
 * **US institutions and US-only jargon are deliberately absent** (NEWS-387's
 * de-Americanisation pass). "University admissions and entrance exams", not
 * "college admissions"; "planning rules", not "zoning"; "Transfers, trades and
 * signings", not "free agency". US *spelling* stays — the codebase is en-US and
 * ships a `Jobs & Labor` category — because what breaks for a reader elsewhere
 * is a topic naming a thing that does not exist where they live, not a `z`.
 *
 * Four beats resist this and are noted where they appear: pensions, tuition,
 * health funding and legal precedent are jurisdiction-bound *concepts*, and
 * rewording them only makes them vaguer. The location a user gives (FR-35) is
 * what actually resolves those, at check time.
 */

import { normalizeTopicName } from './discovery.js';
import { ALL_PROFILES } from './profiles.js';

/**
 * How many topics a full selection produces, at most.
 *
 * Twelve is a daily digest that a person can actually read, and twelve separate
 * checks is a cost a new user has not agreed to anything larger than. The number
 * matters more than it looks: this runs at the end of onboarding, where each
 * created topic fires its own first check immediately (FR-1.12), so the cap is
 * also the size of the burst a fresh install makes on its first minute.
 */
export const DEFAULT_TOPIC_CAP = 12;

/**
 * Profile id → its five topics, best first.
 *
 * Kept as plain names. The **guidance steer** each of these deserves (FR-24.12)
 * is not here yet — the maintainer deferred it to integration time as less
 * critical than getting the names right. See NEWS-400.
 */
export const PROFILE_TOPICS: Readonly<Record<string, readonly string[]>> = {
  // --- page 1 ---------------------------------------------------------------
  'tech-enthusiast': [
    'Consumer gadgets and product launches',
    'Artificial intelligence',
    'Smartphones and mobile platforms',
    'Big Tech antitrust and regulation',
    'Computer chips and semiconductors',
  ],
  foodie: [
    'Restaurant openings and chef news',
    'Food trends and ingredients',
    'Restaurant awards and rankings',
    'Food safety and recalls',
    'Cookbooks and food media',
  ],
  traveler: [
    'Airline routes and fares',
    'Travel disruption and airport operations',
    'Visa rules and border requirements',
    'Hotels and short-term rentals',
    'Destinations and overtourism',
  ],
  'sports-fan': [
    'League results and standings',
    'Transfers, trades and signings',
    'Title races and playoffs',
    'Sports business and broadcast rights',
    'Athlete injuries and comebacks',
  ],
  investor: [
    'Stock markets and indices',
    'Central bank policy and interest rates',
    'Corporate earnings',
    'Inflation and economic data',
    'Mergers and acquisitions',
  ],
  'film-tv-buff': [
    'Film releases and reviews',
    'Streaming platforms and originals',
    'Awards season',
    'Box office and studio business',
    'Casting and production news',
  ],
  'fitness-wellness': [
    'Exercise science and training research',
    'Nutrition and diet research',
    'Sleep and recovery',
    'Wearables and fitness tech',
    'Supplements and performance',
  ],
  gamer: [
    'Game releases and reviews',
    'Gaming hardware and consoles',
    'Games industry and studios',
    'Esports',
    'Live-service updates and game preservation',
  ],
  'science-curious': [
    'Space exploration and astronomy',
    'Medical and biology research',
    'Climate science',
    'Physics and fundamental research',
    'Archaeology and human origins',
  ],
  parent: [
    'Child health and pediatrics',
    'Schools and education policy',
    'Child safety and product recalls',
    "Screen time and children's technology",
    'Childcare costs and family policy',
  ],
  'music-lover': [
    'New album releases',
    'Touring and live music',
    'Music industry and streaming economics',
    'Artist news and interviews',
    'Charts and music awards',
  ],
  'small-business-owner': [
    'Small business regulation and taxes',
    'Hiring and labor costs',
    'Lending and access to capital',
    'Consumer spending trends',
    'Payments and business software',
  ],
  gardener: [
    'Seasonal planting and growing guides',
    'Plant disease and pests',
    'Native plants and pollinators',
    'Drought and water restrictions',
    'Garden design and tools',
  ],
  'politics-watcher': [
    // Generic by construction — the wording names no country's institutions.
    // *Whose* politics is a locale question, answered by FR-35 at check time.
    'Elections and campaigns',
    'Legislation and policy',
    'Courts and judicial rulings',
    'Government budgets and spending',
    'Polling and public opinion',
  ],
  'car-enthusiast': [
    'New car launches and reviews',
    'Electric vehicles and batteries',
    'Motorsport',
    'Auto industry and manufacturing',
    'Classic and collector cars',
  ],
  student: [
    // "University admissions and entrance exams" covers gaokao / JEE / A-levels
    // / SAT alike; "college" means pre-university across much of the Commonwealth.
    'University admissions and entrance exams',
    'Tuition fees and student funding',
    'Campus life and student issues',
    'Graduate job market and internships',
    'Education technology and study tools',
  ],

  // --- page 2 ---------------------------------------------------------------
  'software-developer': [
    'Programming languages and frameworks',
    'Developer tools and AI coding assistants',
    'Cloud platforms and infrastructure',
    'Open source projects and licensing',
    'Tech hiring and the developer job market',
  ],
  'healthcare-professional': [
    'Clinical research and trial results',
    'Drug approvals and pharmaceuticals',
    // "Funding", not "reimbursement" — the latter is US private-insurance
    // vocabulary. The concept stays jurisdiction-bound regardless.
    'Healthcare policy and funding',
    'Medical devices and diagnostics',
    'Clinician workforce and burnout',
  ],
  'home-cook': [
    'Recipes and techniques',
    'Kitchen equipment and reviews',
    'Food prices and ingredient supply',
    'Seasonal and local produce',
    'Home food preservation and safety',
  ],
  'hiker-camper': [
    'National parks and protected areas',
    'Outdoor gear and equipment',
    'Trail conditions and access',
    'Public land and access rights',
    'Wildlife and wilderness safety',
  ],
  reader: [
    'New book releases',
    'Literary prizes and awards',
    'Publishing industry',
    'Author interviews and profiles',
    'Libraries and access to books',
  ],
  'startup-founder': [
    'Venture capital and funding rounds',
    'Exits, IPOs and acquisitions',
    'Founder strategy and company building',
    'Emerging technology markets',
    'Startup hiring and equity',
  ],
  'pet-owner': [
    'Pet health and veterinary medicine',
    'Pet food safety and recalls',
    'Animal behavior and training',
    'Veterinary costs and pet insurance',
    'Animal welfare and shelters',
  ],
  'diy-home-repair': [
    'Home renovation projects and techniques',
    'Tools and equipment',
    'Building materials and costs',
    'Home energy efficiency',
    'Building regulations and approvals',
  ],
  'space-astronomy': [
    'Rocket launches and spaceflight',
    'Space telescopes and observations',
    'Planetary science and missions',
    'Commercial space industry',
    'Astronomical events and skywatching',
  ],
  'climate-environment': [
    'Climate science and research',
    'Renewable energy transition',
    'Extreme weather and adaptation',
    'Climate policy and agreements',
    'Conservation and biodiversity',
  ],
  photographer: [
    'Camera gear and lens releases',
    'Photo editing software and workflow',
    'Photographic technique and craft',
    'Photojournalism and image ethics',
    'Exhibitions and photography prizes',
  ],
  'board-games': [
    'New board game releases',
    'Tabletop roleplaying games',
    'Board game industry and crowdfunding',
    'Conventions and game awards',
    'Game design and mechanics',
  ],
  'mental-health': [
    'Mental health research and treatment',
    'Therapy access and mental health policy',
    'Stress, burnout and workplace wellbeing',
    'Meditation and mindfulness practice',
    'Digital wellbeing and social media effects',
  ],
  educator: [
    'Education policy and funding',
    'Teaching practice and curriculum',
    'AI and technology in the classroom',
    'Teacher pay and working conditions',
    'Student outcomes and assessment',
  ],
  'fashion-style': [
    'Runway shows and collections',
    'Fashion industry business',
    'Sustainable and secondhand fashion',
    'Street style and trends',
    'Designers and creative directors',
  ],
  'local-news': [
    // The one profile whose topics are meaningless without a location. They
    // read as placeholders until FR-35's setting is filled in, which is why the
    // onboarding location step sits before topics are created.
    'City government and council decisions',
    'Local development and planning',
    'Local schools',
    'Local crime and public safety',
    'Local transit and infrastructure',
  ],

  // --- page 3 ---------------------------------------------------------------
  runner: [
    'Running training and coaching science',
    'Marathons and road racing',
    'Running shoes and gear',
    'Running injuries and prevention',
    'Elite distance running',
  ],
  'anime-comics': [
    'New anime seasons and releases',
    'Manga releases and licensing',
    'Comics and graphic novels',
    'Anime and comics industry',
    'Conventions and fandom',
  ],
  'beer-wine-spirits': [
    'Wine regions and vintages',
    'Craft beer and breweries',
    'Spirits and cocktails',
    'Drinks industry and regulation',
    'Non-alcoholic and low-alcohol drinks',
  ],
  musician: [
    'Instruments and music gear',
    'Music production and recording technology',
    'Performance technique and practice',
    'Music rights, royalties and licensing',
    'Music education and learning',
  ],
  'property-housing': [
    'Home prices and the housing market',
    'Mortgage rates and lending',
    // "Planning rules", not "zoning reform" — zoning is US/Canada.
    'Housing policy and planning rules',
    'Rental market and tenant issues',
    'Commercial property',
  ],
  'legal-professional': [
    // "Legal precedent" still leans common-law; a civil-law reader has statutes
    // and commentary instead. Not fixable by rewording — see the module note.
    'Court rulings and legal precedent',
    'Regulation and compliance',
    'Legal industry and law firms',
    'Legal technology and AI in law',
    'Legal education and the profession',
  ],
  'crafts-making': [
    'Knitting, sewing and fiber crafts',
    'Woodworking',
    '3D printing and digital fabrication',
    'Craft supplies and tools',
    'Selling handmade and craft business',
  ],
  'academic-researcher': [
    'Research funding and grants',
    'Scientific publishing and peer review',
    'Research integrity and replication',
    'Academic careers and job market',
    'Open access and data sharing',
  ],
  'volunteer-community': [
    // "Nonprofit sector and charities" keeps both the US and UK word, since the
    // two readerships use different ones for the same thing.
    'Nonprofit sector and charities',
    'Volunteering and civic participation',
    'Community development and local initiatives',
    'Philanthropy and grantmaking',
    'Disaster response and mutual aid',
  ],
  retiree: [
    'Retirement income and pensions',
    'Healthcare costs and coverage in later life',
    'Pension policy and retirement benefits',
    'Aging and longevity research',
    'Estate planning and inheritance',
  ],
  aviation: [
    'Commercial aviation industry',
    'Aircraft technology and new models',
    'Air safety and incident investigations',
    'Pilots, training and general aviation',
    'Air traffic control and airspace',
  ],
  'remote-worker': [
    'Remote and hybrid work policy',
    'Distributed team tools and practice',
    'Digital nomad visas and relocation',
    'Home office setup and ergonomics',
    'The remote labor market',
  ],
  'frugal-living': [
    'Personal budgeting and saving',
    'Consumer deals and price trends',
    'Debt and credit management',
    'Grocery and household costs',
    'Consumer rights and hidden fees',
  ],
  'language-learner': [
    'Language learning methods and research',
    'Language learning apps and tools',
    'Translation and interpretation technology',
    'Linguistics and language change',
    'Culture and media in other languages',
  ],
  'history-buff': [
    'Archaeology and new discoveries',
    'Historical research and reinterpretation',
    'Museums and exhibitions',
    'History books and documentaries',
    'Preservation and historic sites',
  ],
  'skincare-beauty': [
    'Skincare science and ingredients',
    'Beauty product launches',
    'Cosmetics regulation and safety',
    'Beauty industry business',
    'Dermatology and skin health',
  ],
};

/** Topics for one profile, best first. Empty for an id this build doesn't ship. */
export function topicsForProfile(id: string): readonly string[] {
  return PROFILE_TOPICS[id] ?? [];
}

/**
 * Turn ticked profiles into the topics to create.
 *
 * **Round-robin by rank, not profile-major**, and that is the whole design.
 * Taking five from the first profile and then five from the second would give
 * someone who ticked ten profiles everything from two of them and nothing from
 * the other eight. Going rank by rank across all of them means every ticked
 * profile contributes its best topic before any profile contributes a second.
 *
 * The consequence is that depth per profile falls as the tick count rises, which
 * is exactly what the NEWS-387 ranking exists to make possible: one profile
 * yields its whole list, ten yield roughly one each.
 *
 * Deduplicated with `normalizeTopicName` — the *topic-name* rule, deliberately
 * not `normalizeTitle` from `ai/dedupe.ts`, which strips punctuation because it
 * compares headlines. Same call FR-24.24 makes, for the same reason.
 *
 * `exclude` takes names the user already follows, so reopening onboarding for an
 * existing user cannot propose something they are already watching (the spirit
 * of FR-24.11, which the discovery path enforces server-side).
 */
export function topicsForProfiles(
  ids: readonly string[],
  options: { cap?: number; exclude?: readonly string[] } = {},
): string[] {
  const cap = options.cap ?? DEFAULT_TOPIC_CAP;
  if (cap <= 0) return [];

  // Canonical page order rather than tick order, so the same set of profiles
  // always yields the same topics — a user who ticked the same four things in a
  // different sequence should not get a different feed.
  const ordered = ALL_PROFILES.filter((p) => ids.includes(p.id)).map((p) => topicsForProfile(p.id));
  if (ordered.length === 0) return [];

  const seen = new Set((options.exclude ?? []).map(normalizeTopicName));
  const picked: string[] = [];
  const deepest = Math.max(...ordered.map((list) => list.length));
  for (let rank = 0; rank < deepest && picked.length < cap; rank++) {
    for (const list of ordered) {
      if (picked.length >= cap) break;
      // Length-checked rather than undefined-checked: every profile ships five
      // topics today, so the type says this cannot miss — but `deepest` is taken
      // from the data, and a profile with a shorter list must skip its turn
      // rather than push `undefined` into the result.
      if (rank >= list.length) continue;
      const name = list[rank];
      const key = normalizeTopicName(name);
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(name);
    }
  }
  return picked;
}
