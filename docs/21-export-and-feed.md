# 21 — Export and Feed

Nothing could get out of the app. Saved stories could only be read inside it, and the digest only at the machine running the server. That is a lock-in smell in a tool whose entire output is text someone else wrote, and a missed distribution channel: the natural home for a daily digest is whatever reader the user already lives in.

See also [11 — Story Actions](11-story-actions.md) (bookmarking) and [4 — CLI, Server, and Storage](4-cli-server-storage.md) (the origin guard this relies on).

## Status: shipped

### Selections

- **FR-21.1** *(Shipped)* Every endpoint takes the same `scope` parameter, mirroring the feed's own views: `all` (default), `saved`, or `topic` with `&topic=<id>`. Newest-first, capped at 2000 stories — generous for a document, bounded so an install with a year of retained stories can't build a 40 MB response.

- **FR-21.2** *(Shipped)* **Off-topic flagged stories are excluded from every selection.** They are hidden from the feed, so exporting them would be a surprise.

### Formats

- **FR-21.3** *(Shipped)* `GET /api/export.md` — Markdown, **grouped by topic**. An export is read as a document, and a document about six subjects wants six sections. Served as an attachment.

- **FR-21.4** *(Shipped)* `GET /api/export.json` — the escape hatch, so nothing is trapped in the app. Topic *names* rather than ids, since an id means nothing outside this install.

- **FR-21.5** *(Shipped)* `GET /feed.xml` — **Atom**, served inline. Atom rather than RSS 2.0: ISO-8601 dates rather than RFC-822, `id` a required stable field rather than an optional convention, and content type declared rather than guessed. Every reader that speaks RSS speaks Atom. Newest-first here — a reader is a timeline, which is the opposite of the Markdown grouping and deliberate in both directions.

  Entries are keyed on the **item id**, not the article URL: two stories can cite the same source, and a reader keyed on a duplicate id silently drops one. Bodies go out as `type="text"` — the summaries are plain prose (markup is stripped on the way in, see `sanitize.ts`), so no reader has to decide whether to trust them as markup.

  Every interpolated value is XML-escaped. An unescaped `&` in a source URL is the classic way to ship a feed no reader will parse, and a headline is model output — tests cover both.

### Reach

- **FR-21.6** *(Shipped)* All three are same-origin-guarded like every other route (FR-4.5a), and the guard's "**absent `Origin` is allowed**" rule is exactly what makes the feed usable: a desktop RSS reader is not a browser page and sends no `Origin`, while a web page on another origin still gets a 403 and cannot read the archive.

- **FR-21.7** *(Deferred)* The server is localhost-only, so a reader on **another device** can't subscribe. Making the feed reachable off-machine needs a bearer token in the URL and a non-loopback bind — deliberately out of scope here, and coupled to the mobile/LAN work (NEWS-46 line). The Settings note says plainly that it works from this machine only rather than leaving the user to discover it.

## Testing

- **Unit** (`tests/unit/export.test.ts`, 18 tests): Markdown grouping, deleted-topic heading, empty-state text; JSON parseability and topic-name resolution; `escapeXml` over all five metacharacters; Atom well-formedness, **`&` in a source URL escaped**, **markup in a headline escaped**, entries keyed on item id (two stories, one source → two entries), the no-source case omitting the alternate link, and the empty-feed `<updated>` fallback. Then the routes: content types, `Content-Disposition` present on downloads and absent on the feed, `scope=saved` / `scope=topic` narrowing, off-topic exclusion, and a **cross-origin request returning 403**.
- **E2E** (`tests/e2e/app.spec.ts`): the Settings export row renders with real `href`s (not JS handlers — a blob download has nowhere to go in the Tauri webview), and `/feed.xml` + `/api/export.md` are fetched over real HTTP with their headers and content asserted.
