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
- **FR-8.8** *(Shipped)* Hostnames are checked **after DNS resolution** too, not just by name — a public-looking name that resolves into the LAN is the classic rebinding shape.
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

  Not wired to the scheduler tick: the only way the item set shrinks is a topic delete (a re-check only adds), and startup covers everything else. A size/age cap (option 3 in the ticket) was considered unnecessary — images are ≤5 MB and the mark-and-sweep bounds the directory to what's actually referenced.
