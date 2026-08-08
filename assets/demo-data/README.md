# Demo recording

Real news, captured once, replayed forever. This is what `--demo` serves and what
every screenshot in the README is a photograph of.

Regenerate with `npm run record:demo-data` (needs a signed-in `claude` CLI, and
runs outside the command sandbox). See [docs/28-demo-capture.md](../../docs/28-demo-capture.md)
FR-28.23.

## `stories.json`

- `topics` — the stories per demo topic, split into what the first check finds
  and what a second check finds. **The split is staged**: a real second check
  minutes after the first correctly finds nothing, so one capture is dealt
  across the two. The staging is the only fiction — every headline, link,
  outlet, date and picture is real reporting.
- `imagesByArticle` — article URL → the lead image the real pipeline resolved
  for it.
- `faviconsByOrigin` — origin → the favicon the real pipeline resolved for it.

The two maps are keyed by exactly what the real fetchers are *asked*, so the
demo's replaying fetchers are drop-in replacements rather than a different
shape. Without them the demo would need the network, and would depend on those
particular articles still carrying the same `og:image` next month.

## `images/*.bin`

The bytes those two maps point at: **21 `.ico` favicons, 13 PNG, 12 JPEG and one
WebP** at the last capture.

**The `.bin` extension is the app's cache format, not a choice made here.**
`cachedImagePath()` in `src/images/cache.ts` names every cached image
`<hash>.bin`, and the hash is of the image **URL**, not of its content — so
re-encoding a file cannot invalidate anything, and two stories citing one outlet
share a single entry. The app never trusts an extension anyway:
`sniffImageType()` reads magic bytes when serving. `createDemoImageFetcher`
copies these into the running data directory's cache, so the names have to match
on both ends.

Run `file assets/demo-data/images/*.bin` to see what any of them actually is.

Sources are capped at 900px wide on capture — a publisher's lead image is
routinely 2000px and a couple of megabytes, against a card that renders about
430px. One capture arrived at 5.3 MB before that cap existed, of which a single
image was 2.1 MB.

## What this replaced, and why

The stories used to be invented prose linking to `example.org`. The reasoning was
sound — attributing invented reporting to a real masthead puts words in a
publication's mouth — but `example.org` serves neither an article nor a favicon,
so every shipped screenshot showed a news reader that could not display a
picture.
