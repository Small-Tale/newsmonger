# 36 — Default Topics from Profiles

The profile picker ([20 — First-Run Onboarding](20-onboarding.md) FR-20.12) asks what kind of reader someone is. This is what that answer buys them: a feed that already has something in it when setup ends, rather than an empty sidebar and an invitation to think of topics unaided.

See also [24 — Topic Discovery](24-topic-discovery.md), [35 — Location](35-location.md).

## Status: partial

The table, the selection and the guidance steers are shipped. The AI-generated enhancement over this floor is not — see *Not yet built*.

### The table

- **FR-36.1** *(Shipped)* Every one of the 48 profiles maps to **five topics, ordered best first** (`src/profile-topics.ts`). 240 in total, researched in NEWS-387.

- **FR-36.2** *(Shipped)* **Every entry is a standing beat, not a story.** The rule applied to all 240:

  > Would this name have made sense in 2015, and will it still make sense in 2035?

  That rejects named entities — companies, people, products, individual tournaments — and accepts subjects a newsroom could assign a reporter to for a decade. *EV battery technology* survives; *Tesla's next model* does not.

  The list ships once and is read for years, so anything **ongoing** in the FR-24.10 sense is a bug with a delayed fuse. A unit test enforces the mechanical half (no years in a name); the rest is stated in prose because no test can catch a company name that looks like a beat.

- **FR-36.3** *(Shipped)* **US institutions and US-only jargon are absent.** *University admissions and entrance exams*, not *college admissions* — "college" means pre-university across much of the Commonwealth, and entrance exams covers gaokao, JEE, A-levels and the SAT alike. Likewise *planning rules* not *zoning*, *healthcare funding* not *reimbursement*, *transfers, trades and signings* not *free agency*.

  US **spelling** stays. The codebase is en-US and ships a `Jobs & Labor` category; what breaks for a reader elsewhere is a topic naming a thing that does not exist where they live, not a `z`. A test pins the removed phrasings, because they are the ones that come to hand when editing.

  **Four beats resist this and are documented in place**: pensions, tuition, health funding and legal precedent are jurisdiction-bound *concepts*, and rewording only makes them vaguer. The location setting (FR-35) is what resolves them, at check time.

### Choosing what to create

- **FR-36.4** *(Shipped)* **The ordering is the selection mechanism, not decoration.** Someone who ticks ten profiles must not get fifty topics: every topic is its own check, and FR-20.6 already says so at the moment of choosing. `topicsForProfiles` takes the highest-ranked few from each, so depth per profile falls as the tick count rises — one profile yields its whole list, ten yield roughly one each.

- **FR-36.5** *(Shipped)* **Round-robin by rank, not profile-major.** Taking five from the first profile and then five from the second would give a ten-profile user everything from two of them and nothing from the other eight. Going rank by rank across all ticked profiles means every one contributes its best topic before any contributes a second.

  This is the whole design, and it is the reason the ranking in FR-36.1 had to be real rather than arbitrary.

- **FR-36.6** *(Shipped)* **Capped at 12 by default.** Twelve is a digest a person can read, and twelve is a number of checks a new user has not agreed to anything larger than. The cap is also the size of the burst a fresh install makes in its first minute, since each created topic fires its own first check immediately (FR-1.12).

- **FR-36.7** *(Shipped)* Selection is **stable regardless of tick order** — profiles are walked in canonical page order, so the same four profiles always yield the same topics whatever sequence they were clicked in.

- **FR-36.8** *(Shipped)* Deduplicated with **`normalizeTopicName`**, deliberately not `normalizeTitle` from `ai/dedupe.ts`: that one strips punctuation because it compares headlines, whereas in a topic name a hyphen stands in for a space. Same call FR-24.24 makes, for the same reason — the headline rule would let a re-punctuated duplicate straight through.

- **FR-36.9** *(Shipped)* **Explicitly chosen topics win any overlap.** At Finish, the starter chips and anything added from discovery are created first and passed as exclusions to the profile selection: a name the user typed or picked is a stronger signal than one derived from "you said you like food". Topics that already exist are excluded too, so reopening the guide for an existing user cannot propose something they are already watching — the spirit of FR-24.11, which discovery enforces server-side.

### Guidance steers

- **FR-36.10** *(Shipped, NEWS-400)* **Guidance steers, on the topics that earn one — deliberately sparse.**

  FR-24.12 gives a discovery suggestion a steer because the model is writing justification prose anyway. A hand-written table pays for every one, and **a steer that restates the topic name is worse than none**: it spends prompt on nothing and reads as though someone had thought about it. So an entry exists only where the name alone would search too broadly or drift into an adjacent subject — *"Marathons and road racing"* needs nothing; *"Artificial intelligence"* does.

  Three shapes earn one: **fields rather than beats** (Artificial intelligence, Medical and biology research), **names that read as the consumer subject but mean the industry behind it** (Games industry and studios, Music industry and streaming economics), and **topics that drift into their neighbour without a boundary** (Food trends, which otherwise returns recipes; Stock markets, which otherwise returns stock tips).

  The steer travels **with the create**, never in a follow-up PATCH — creating a topic fires its first check immediately (FR-1.12), so a second request lands after the check the steer exists to narrow. Same reasoning as FR-24.26.

- **FR-36.12** *(Shipped, NEWS-400)* **No steer mentions place, and that is the finding.**

  NEWS-387 identified four beats it could not reword without making them vaguer — legal precedent, Politics watcher, and the pensions / tuition / health-funding trio — and expected guidance to carry the qualifier a name could not afford.

  **It cannot.** A static steer saying "in the reader's own jurisdiction" is meaningless without knowing the jurisdiction. That residue was solved instead by **FR-35.4**, which passes the user's location into *every* check with an instruction naming exactly these cases — "local events, property, schools, transport, jobs, weather, and national politics or law". Writing them here as well would duplicate a live signal with a frozen, worse copy.

  A test asserts no steer contains jurisdiction language, so the reasoning cannot quietly rot back.

## Testing

- **Unit** (`tests/unit/profile-topics.test.ts`, 23 tests): every profile has five topics and no key names a profile that doesn't exist; no duplicates within a profile; the removed US-shaped phrasings stay out; no name carries a year. On selection: a single profile yields its whole list, rank-first ordering holds, the cap holds at ten profiles with every one represented, order-independence, exclusions (including a re-punctuated match), and a zero cap meaning none rather than unlimited. On the steers: the map stays sparse, every key names a topic that exists, no steer restates its own name, none mentions place, and an unsteered topic returns `''` rather than `undefined` — which is what the create path checks and what FR-24.19 treats as "no guidance".

## Not yet built

- **FR-36.11** *(Design only)* **AI-generated topics as an enhancement over this floor.** NEWS-382 proposed the static map as the floor and an AI pass as the enhancement, on the FR-20.6b pattern: if a provider resolves, ask discovery; if not, fall back. Only the floor is built. The floor is the half that has to exist, because onboarding's Source step is skippable and a user can reach Finish with no provider at all.
