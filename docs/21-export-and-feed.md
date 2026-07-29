# 21 — Export and Feed

Nothing could get out of the app. Saved stories could only be read inside it, and the digest only at the machine running the server. That is a lock-in smell in a tool whose entire output is text someone else wrote, and a missed distribution channel: the natural home for a daily digest is whatever reader the user already lives in.

See also [11 — Story Actions](11-story-actions.md) (bookmarking), [4 — CLI, Server, and Storage](4-cli-server-storage.md) (the origin guard this relies on), and [27 — The Briefing Reel](27-briefing-reel.md), which reuses this document's scope rules but is aimed at strangers rather than at the user's own reader.

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

- **FR-21.9** *(Shipped, NEWS-158)* Settings → Data offers **one "Export stories…" button opening one dialog**, which asks two questions: *what* (All stories / Saved only) and *what format* (Markdown / JSON).

  It replaced three fixed buttons — All (.md), All (.json), Saved (.md) — which between them covered three of the four combinations. **"Saved only (.json)" had no way to be asked for**, for no reason beyond nobody having added a fourth button; and a fourth button is the wrong answer, since the choice is two questions rather than one list. (The ticket asked whether there was a reason all-stories JSON was unavailable — it was available; saved-as-JSON was the gap.)

  The dialog always opens on **All + Markdown**. One that remembered the last choice would export something different from what the last press did, for a reason nothing on screen explains.

  The Export control stays an **`<a>` with a real `href`**, not a button with a click handler, so the FR-21.8 Tauri routing keeps working unchanged. It closes the dialog on the *next tick* rather than synchronously, so the anchor is not removed inside its own click handler — defensive rather than a fix for something observed (Chromium tolerates either), kept because the WKWebView is the environment that matters here and cannot be tested from this side.

- **FR-21.11** *(Shipped, NEWS-161)* The button is **filled, and carries a `download` icon**. It shipped outlined with `share-2` — three linked circles, which name handing something to another person or app. This writes a file to disk. It is also the only action on the Data tab, and an outlined button there read as an afterthought.

  Its icon sits on the label's **centre line**: the row's `.btn` is a flex row, without which a 15px glyph is an inline box on the 13px text's baseline and rides visibly high. All three are measured in `tests/e2e/app.spec.ts` — centre offset under 1.5px, the glyph asserted by *what it is made of* (a `polyline` arrowhead and no `circle`s, which survives a resize or recolour), and the fill compared against `--panel` rather than a hex so it holds in both themes.

- **FR-21.10** *(Shipped, NEWS-160)* The dialog's third scope is **One topic**, revealing a picker of the watched topics in sidebar order. `scope=topic` had worked on all three endpoints since NEWS-85 and was covered by unit tests, but nothing in the UI could ask for it — a documented, tested capability reachable only by hand-assembling a URL.

  Choosing the scope **lands on a topic** rather than on nothing. This is the one place the DOM and the store can disagree: a `<select>` with no `selected` option still displays its first one, so leaving the store's `topicId` null shows a picker that looks chosen beside an Export button that is disabled. The E2E asserts the Export control is live *before* touching the picker, which is the only ordering that catches it.

  With **no topics at all** the option is disabled and says why — it could only ever produce an empty file, and an enabled control that yields nothing is worse than a disabled one that explains itself.

  URL construction is `exportHref` in `src/client/export-url.ts`, a pure function of the choice. It returns **null** for "one topic" with none picked, and the dialog renders a disabled button rather than a link: falling back to `scope=all` there would hand over the whole archive when the user asked for one subject, which is the quietest possible way to get this wrong.

- **FR-21.8** *(Shipped, NEWS-157)* **In the Tauri webview an export is handed to the system browser.** `<a download>` is a no-op in the WKWebView: the click is swallowed, nothing is saved, and there is no error to show for it — the same class of gap as `window.confirm` (NEWS-39) and `navigator.share` (NEWS-43), and it made all three buttons look broken on the desktop app.

  The links stay real `href`s — an earlier note here justified them as "so they work in the Tauri webview too", which was simply wrong and is what this corrects. A `data-export` click handler routes them through `/api/open-external` when `window.__TAURI__` is present, and stands aside in a normal browser. This works because every export already answers with `Content-Disposition: attachment`, so the browser saves rather than renders it, and the server is on localhost so the browser can reach it.

  The handler reads the anchor's **`href` property, not its attribute**: the attribute is the relative string authored in the JSX, and `/api/open-external` parses what it is given with `new URL()` and rejects anything that isn't absolute http(s). Pinned by a test — re-breaking it sends `/api/export.md?scope=all` and would 400.

- **FR-21.7** *(Deferred)* The server is localhost-only, so a reader on **another device** can't subscribe. Making the feed reachable off-machine needs a bearer token in the URL and a non-loopback bind — deliberately out of scope here, and coupled to the mobile/LAN work (NEWS-46 line). The Settings note says plainly that it works from this machine only rather than leaving the user to discover it.

## Testing

- **Unit** (`tests/unit/export.test.ts`, 18 tests): Markdown grouping, deleted-topic heading, empty-state text; JSON parseability and topic-name resolution; `escapeXml` over all five metacharacters; Atom well-formedness, **`&` in a source URL escaped**, **markup in a headline escaped**, entries keyed on item id (two stories, one source → two entries), the no-source case omitting the alternate link, and the empty-feed `<updated>` fallback. Then the routes: content types, `Content-Disposition` present on downloads and absent on the feed, `scope=saved` / `scope=topic` narrowing, off-topic exclusion, and a **cross-origin request returning 403**.
- **E2E** (`tests/e2e/app.spec.ts`): the Settings export row renders with real `href`s, `/feed.xml` + `/api/export.md` are fetched over real HTTP with their headers and content asserted, and — since NEWS-157 — clicking a link **actually downloads** in a browser, and drives `/api/open-external` with an absolute URL when `window.__TAURI__` is defined. Since NEWS-158 the four scope × format combinations are each walked end to end — chosen in the dialog, `href` asserted, clicked, and the downloaded filename checked — rather than sampled. That last one makes the desktop path testable without a Tauri window: `openExternalUrl` keys off the global, so defining it is enough. Before this, the link's *shape* was asserted and its *behaviour* was not, which is how a dead button went unnoticed.
