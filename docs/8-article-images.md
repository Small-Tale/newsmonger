# 8 — Article Images

Stories carry the article's own lead image, fetched server-side and served from the local cache. The browser never contacts a publisher.

See also: [2 — News Checks and Deduplication](2-news-checks-and-dedup.md), [3 — UI](3-ui.md), [4 — CLI, Server, and Storage](4-cli-server-storage.md).

## Status: shipped, verified against live sites

## Where the image comes from

- **FR-8.1** *(Shipped)* After a check finds new stories, the server fetches each story's first source URL and reads its Open Graph image tag — the same mechanism behind link previews in Slack or iMessage. `src/images/ogimage.ts` handles either attribute order, `property=` or `name=`, relative URLs resolved against the page, and HTML entities in the value. It prefers `og:image:secure_url` → `og:image:url` → `og:image` → `twitter:image`.

  **The model is not asked for an image URL.** It would happily supply one, but models invent plausible-looking image URLs that 404, and verifying one means fetching it anyway — at which point reading the real tag is strictly better and costs no extra tokens.

- **FR-8.2** *(Shipped)* **No image is the normal case, not an edge case.** Measured against live sites: AP publishes one; the Guardian's section front and BBC News have no `og:image` at all; Ars Technica answers a bot challenge; and TechCrunch's own `og:image` is a dead link (404). The card layout collapses its media slot entirely when there's no picture, so a missing image costs nothing visually.

- **FR-8.3** *(Shipped)* Failures are silent and never cost a story. Image resolution runs per-story in parallel and each is individually caught — a timeout, a 404, a blocked bot, or a thrown error yields `image: null` and the story is stored regardless.

## Privacy: proxied, never hotlinked

- **FR-8.4** *(Shipped)* Images are fetched **once by the server**, cached on disk under `<data-dir>/images/`, and served from `GET /api/image/:hash`. The page loads them from `127.0.0.1`.

  Hotlinking would have been simpler, but it would tell **every publisher in the feed** your IP address and that you opened the app — including for stories you never click. The browser currently makes *zero* third-party requests, and that is worth keeping. Verified by asserting no non-loopback request leaves the page while a cached image renders.

- **FR-8.5** *(Shipped)* Cache filenames are the SHA-256 of the image URL, truncated to 32 hex characters. Content-addressed, so the response is served `immutable` with a one-year max-age and can never go stale.

## Security: fetching URLs a model chose

An AI provider decides what the server connects to. That makes naive fetching a server-side request forgery hole, so `src/images/safety.ts` denies by default.

- **FR-8.6** *(Shipped)* Only `http:`/`https:`. No `file:`, `data:`, `javascript:`, or anything else. URLs carrying credentials are refused outright.
- **FR-8.7** *(Shipped)* Blocked hosts: `localhost` and friends, `.local` / `.internal` / `.home.arpa` suffixes, and every private address range — loopback, RFC1918, carrier-grade NAT, multicast, and **link-local, which includes the `169.254.169.254` cloud metadata endpoint**. IPv6 loopback, link-local, and unique-local are covered, as are IPv4-mapped IPv6 forms like `::ffff:127.0.0.1` (the obvious bypass).
- **FR-8.8** *(Shipped)* Hostnames are checked **after DNS resolution** too, not just by name — a public-looking name that resolves into the LAN is the classic rebinding shape. Every returned address is checked, not just the first: a rebinding attack only needs one usable answer, and an empty answer is a rejection rather than an allow.

  Resolution is **injectable** (*NEWS-259*), which is how the rule is tested. Real DNS cannot produce the interesting input on demand — no name under our control resolves to `10.0.0.1` from a test — so the tests supply it. Reaching for real DNS also made the unit suite depend on the resolver answering inside vitest's 5-second timeout, which it once did not under a fully parallel run.
- **FR-8.9** *(Shipped)* The image URL is re-validated separately from the article URL. It is a *second* attacker-influenced value, and the one a redirect could aim back at the local network.
- **FR-8.10** *(Shipped)* **`GET /api/image/:hash` never fetches.** It reads from the cache or 404s. An endpoint that fetched whatever it was pointed at would be an open proxy running on the user's machine. Images enter the cache only during a check, from vetted URLs. The hash-shape check is also what makes the path join safe — a validated hash cannot contain a separator or `..`.
- **FR-8.11** *(Shipped)* Responses are bounded: 8 s timeout, 5 MB image cap, and the content type must be a real image format. The stored file's type is sniffed from its magic bytes when served, not taken from the origin's header.

### Pages truncate, images don't

`fetchWithLimit` reads at most 512 KB of a page. It **truncates** rather than rejecting, because `<head>` sits at the very top — AP's section front is ~1.8 MB, and rejecting on size meant it silently produced no image until this was fixed. Images take the opposite treatment: an oversized image is rejected outright, since a truncated one is a corrupt file.

Downloads land via a temp file and an atomic rename, so a crash mid-download can't leave a truncated image that would then be served forever as a valid cache hit.

## Rendering

- **FR-8.12** *(Shipped)* The image sits above the headline in a fixed 16:9 slot with `object-fit: cover`, so a publisher's tall or panoramic artwork can't disturb the feed's rhythm and cards don't reflow as images decode. Loading is lazy and decoding async. The `alt` is empty — the image is decorative next to a headline that already says what the story is.
- The media slot is **always rendered** and collapses via `:empty`, per the kerf structural rule in [3 — UI](3-ui.md).

## Cache pruning (FR-8.13)

- **FR-8.13** *(Shipped, NEWS-36)* Orphaned cached images are reclaimed by a **mark-and-sweep**: `liveImageHashes(items)` collects every hash still referenced by a live item, and `pruneImageCache(dataDir, liveHashes)` deletes every `.bin` in `<data-dir>/images/` not in that set (plus stray `.tmp` files from interrupted downloads). It runs at **startup** and after a **topic delete** (`DELETE /api/topics/:id`).

  The mark set *is* the reference count: an image shared by two stories (same URL → same hash) survives as long as either story does, so deleting one topic never orphans another's picture. The sweep is self-healing — it also reclaims orphans from a crash or an older version, not just the delete that triggered it — and best-effort: a cache it can't read simply isn't pruned that pass, and a failed prune never fails the delete.

  **An empty mark set is not a licence to delete everything** — see FR-8.19, which is the failure this description hid.

  Not wired to the scheduler tick: the only way the item set shrinks is a topic delete (a re-check only adds), and startup covers everything else. A size/age cap (option 3 in the ticket) was considered unnecessary — images are ≤5 MB and the mark-and-sweep bounds the directory to what's actually referenced.

## Source favicons (FR-8.14–8.18, NEWS-169)

The feed's source links carried a pine arrow glyph — a bullet saying "this is a link", which the underline already said. A favicon says *who*.

- **FR-8.14** *(Shipped, NEWS-169)* Each `NewsSource` carries its outlet's favicon, cached locally and shaped exactly like the item's `image` (`hash` + `sourceUrl`). Per **source**, not per item: a story can cite several outlets and each link wears its own mark.

  **Why this exists when FR-8.1 already fetches a picture:** `og:image` is absent about a third of the time (FR-8.2), while a favicon is near-universal and a couple of kilobytes. For *attribution* it is the more reliable signal of the two.

- **FR-8.15** *(Shipped, NEWS-169)* Resolution is keyed on the **origin**, not the article URL. A favicon belongs to a site, not a page — so one outlet cited by six stories is one request and one cache entry, and the same outlets recur on every check. `originOf()` canonicalises, so `https://reuters.com/a` and `https://reuters.com/b?x=1` collapse to one key.

- **FR-8.16** *(Shipped, NEWS-169)* Two bounded attempts, cheapest first: **`/favicon.ico`** at the origin, then the origin's homepage read for a `<link rel="icon">` / `apple-touch-icon`. The first is the oldest convention on the web and still honoured almost everywhere, costing one small GET with no HTML parse; the second exists because plenty of modern sites ship only an SVG or a hashed asset path. So the common case is one request and the worst case is two.

  `rel` is matched as **whole words** within the attribute, because real markup writes `rel="shortcut icon"` and `rel="icon shortcut"` and means the same thing by both — while a substring match on `icon` would wrongly accept unrelated longer tokens.

- **FR-8.17** *(Shipped, NEWS-169)* Same safety posture as the lead image, and for the same reason: an icon URL read out of a page is a **second attacker-influenced value**, so it goes through `rejectUnsafeUrl` before being fetched (FR-8.9's situation exactly). Bounds differ from a photo's, deliberately:

  - **256 KB**, two orders of magnitude below the lead-image cap. A hero photograph is legitimately megabytes; a site icon is kilobytes, and a server answering `/favicon.ico` with a full-page image should be rejected rather than cached.
  - A **wider type set** — `image/x-icon` and `image/vnd.microsoft.icon` (both spellings real servers send) plus `image/svg+xml`. None of those belong in the lead-image set, where a `.ico` hero would signal something had gone wrong.
  - A **zero-length body is refused.** Some servers answer a missing `/favicon.ico` with an empty 200 rather than a 404, and the cache is never re-fetched — so caching that would put a broken image on every link from that outlet permanently.

- **FR-8.18** *(Shipped, NEWS-169)* Favicons **join the FR-8.13 mark-and-sweep** via `liveImageHashes`, which now walks each item's sources as well as its image. Without it the startup prune would reclaim every icon — silently, leaving broken images that reappear only after a fresh check. Because the cache is content-addressed, the mark set is still the reference count: two stories citing one outlet share a hash, and it survives while either does.

  Verified against a real database, not only in a unit test: seed favicons, restart the server, and both files survive the startup prune.

## Keeping pictures for as long as the stories (NEWS-341)

- **FR-8.19** *(Shipped, NEWS-341)* **An empty mark set never sweeps a populated cache.** `pruneImageCache` skips the `.bin` sweep when `liveHashes` is empty and the cache is not, and says so on stderr. `.tmp` files still go: a half-written download is referenced by nothing whatever the mark set says.

  Every caller builds the set from `store.listItems()`, so an empty set means one of two things — "this install has no stories" or "the database I read is not the one this cache belongs to" — and the second is not hypothetical. A database quarantined at startup ([FR-4.9](4-cli-server-storage.md)) is replaced by an empty one; the startup prune then ran against zero items and deleted **every cached image in the install**. When the database was restored from its backup, 47 stories came back pointing at pictures that no longer existed.

  The asymmetry decides it. Refusing to sweep costs disk and nothing else, and corrects itself the moment any story exists again — the set is non-empty, and genuine orphans go. Sweeping on a set that is wrong is unrecoverable: the source URLs are the only way back, and only if the rows survived.

- **FR-8.20** *(Shipped, NEWS-341)* **A missing cache file is refetched on demand from the URL the story recorded.** `GET /api/image/:hash` falls back to `Store.imageSourceUrl(hash)` → `cacheImageUrl(...)` → serve, rather than answering 404.

  This works without a database write because the cache is **content-addressed by source URL**: `imageHash(sourceUrl)` is the hash the row already carries, so a repair cannot disagree with the row it repairs. Covers **source favicons** as well as lead images — they share the cache, and a repair that knew about half of it would leave the icons broken with nothing to explain why.

  This does **not** reopen FR-8.9's open-proxy hole, and the distinction is the whole design: the URL comes from a story already stored, never from the request. A hash nothing references resolves to nothing and no request is made — exactly as when the route never fetched at all, which is still asserted. The refetch re-runs the SSRF checks, because a `sourceUrl` was checked when it was first seen and the name it resolves to today is not the name it resolved to then.

  **One attempt per image per run**, keyed by data directory *and* hash. A broken `<img>` is retried by the browser on every repaint, so an unreachable URL would otherwise become a fetch per frame; keying by hash alone would let one `--data-dir` suppress a repair in another. Not persisted — a URL that fails today may work tomorrow, and a permanent "don't try" record would need something to invalidate it.

  The downloader is **injected** (`refetchImage` on `createApp`), following the NEWS-315 precedent, so the repair path is testable without a network and `null` switches it off.

  Verified against the real database from the incident: three stories whose images had been deleted all returned 200 with their bytes, cached back under their original hashes.
