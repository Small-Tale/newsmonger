# 35 — Location

Some topics are inherently about somewhere. Someone who follows **Concerts** almost certainly means concerts within reach of them; someone who follows **Space exploration** never means the regional planetarium. Before this, the app had no way to tell the two apart, so every check searched the whole world and a topic like *Local schools* or *Housing costs* returned news about nowhere in particular.

See also [20 — First-Run Onboarding](20-onboarding.md), [18 — Topic Guidance](18-guidance.md), [22 — Topic Categories](22-topic-categories.md).

## Status: partial

The setting and its use in every check are shipped. The onboarding step that asks for it is not — see *Not yet built* at the end.

### The setting

- **FR-35.1** *(Shipped)* A single **global** `location` setting, editable in **Settings ▸ App ▸ Location**. One value for the whole app, not one per topic. `''` — the default — means every topic stays global, which is exactly the behaviour that existed before this feature.

  It lives on the App tab beside Theme rather than under Schedule or Source because it is a fact about the *user*, not about cadence or about which model runs.

- **FR-35.2** *(Shipped)* **Free text, with no place list and no validation beyond a 200-character cap.**

  This is the central design decision and it is deliberate. A gazetteer-backed picker has to decide whether 東京 and "Tokyo" are the same row, and it rejects the village that isn't in it — so it fails hardest for exactly the people whose location is least like the dataset's idea of one. The value's whole job is to reach the check prompt as a phrase a model can read, and any string a person recognises as their own place already does that job perfectly.

  So **"Lisbon", "Lisboa", "北海道", "the Scottish Borders" and "Europe" are all equally valid**, and none of them is normalised, case-folded or transliterated on the way in. The value is trimmed and stored as typed.

  An earlier design (NEWS-389) proposed a GeoNames-backed type-ahead over 69,577 cities, with a `GET /api/places` lookup and ranked suggestions. It was dropped before implementation: an ASCII-name search actively fights someone typing in their own script, and it bought validation that nothing downstream needs.

- **FR-35.3** *(Shipped)* **Granularity is the user's choice and nothing parses it.** A continent is as valid an answer as a street address. There is no continent/country/region/city ladder in the schema, no resolution step, and no stored level — the string goes to the model whole.

  This is what makes "as much or as little as you like" true rather than a slogan. A ladder would need a level for every answer, and would have to reject or coerce the ones that don't fit it.

### How checks use it

- **FR-35.4** *(Shipped)* The location is passed on **every** check, with an instruction telling the model when it applies — not resolved into a per-topic scope stored at classification time.

  The alternative was a `reach` field per topic (`anywhere` / `my-country` / `near-me`), guessed once and overridable. It was designed and then dropped, because **how local a subject is varies by story as much as by topic**. A national tour announcement is on-topic for a near-me *Concerts*; a local council row is not on-topic for a country-level *Elections*. A field set once, at classification time, cannot make that call — the model reading the actual stories can.

  Dropping it also removed a field that would have needed a source marker (`auto` / `manual`), a re-classification path, migration for existing topics, and UI. The prompt instruction replaces all of it.

- **FR-35.5** *(Shipped)* **The instruction has two halves and both are load-bearing.** It states where the user is *and* that a subject not tied to a place must ignore it and search globally.

  Without the second half every topic drifts local and *Space exploration* starts returning the regional planetarium — which is worse than the behaviour before the feature, because the user cannot see why their global topic went quiet. The prompt says so in those terms: "a worldwide topic narrowed to the user's town is worse than one that ignored the location."

  Within the topics where it *does* apply, the breadth is the model's judgement too: some subjects mean the immediate area, others the whole country.

- **FR-35.6** *(Shipped)* The setting is read **per check**, not captured when the sweep starts, so an edit in Settings takes effect on the next check rather than the next restart.

- **FR-35.7** *(Shipped)* **The location never enters the topic name.** Rewriting *Concerts* to *Concerts in Lisbon* would make `normalizeTopicName` treat it as a different subject — breaking dedup against everything already reported — and would silently go wrong the day the user moves. The name is the subject; the location is a modifier on the question asked about it.

### Privacy

- **FR-35.8** *(Shipped)* The value is stored locally like every other setting and is **sent to the configured AI provider with every check**, which is the only way it can do anything. The Settings hint says what it is used for; the field is empty by default and clearing it restores global behaviour immediately.

## Testing

- **Unit** (`tests/unit/location-prompt.test.ts`): the instruction appears when a location is set and is absent when it is `''` or whitespace; it carries the ignore-if-global half; a non-ASCII location survives to the prompt unaltered; the value is not appended to the topic name. Settings round-trip through the API with a CJK value and with a 200-character value.
- **E2E** (`tests/e2e/settings-layout.spec.ts`): the field persists a typed value across a reload, and clearing it stores `''`.

## Not yet built

- **FR-35.9** *(Design only)* An **onboarding step** that asks for the location during first run, so it is set before the Topics step creates anything. Designed in NEWS-389 (see `location-picker-wireframes-v2.png` on that ticket) and deferred: the step slots in beside the profile picker from NEWS-383, and building the two separately then reconciling their placement in `ONBOARDING_STEPS` is more work than building them together.

  Until then the setting is discoverable only in Settings, which means a first-run user gets global topics until they find it.
