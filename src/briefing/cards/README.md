# Briefing card templates

The scenes a briefing reel is built from (NEWS-166). Specified in [docs/27 — The Briefing Reel](../../../docs/27-briefing-reel.md), §27.6.

These are **design, not a pipeline.** Nothing generates them yet. They exist so the visual language is settled — and reviewable — before a renderer is written, because domotion faithfully renders whatever HTML/CSS it is given, so whether the reel is worth sharing is decided here rather than in the generator.

| File | Scene |
|---|---|
| `cards.css` | The whole design. Tokens, type scale, spacing, and all five scenes. |
| `title.html` | Opening card — date and story count. |
| `story.html` | A story with a lead image. The common case. |
| `story-long.html` | Stress case: a headline that needs the `is-long` step-down, plus a one-line deck. |
| `story-no-media.html` | A story with no image — about a third of them (FR-8.2), so a normal card, not an edge case. |
| `end.html` | Closing card: wordmark, count, and the FR-27.6 AI disclosure. |

## Two unresolved references

`story*.html` references `photo.png` and `end.html` references `wordmark-dark.svg`. **Neither is checked in here**, deliberately:

- The photo is per-story and comes from the local image cache at render time. A committed sample would be a fake photograph living in `src/`, and the temptation to point the real generator at it is exactly the mistake FR-27.8 exists to prevent.
- The wordmark is already in `assets/`. Copying it here would be a second copy to keep in sync with `--pine`, which `tests/unit/brand-assets.test.ts` guards for the originals only.

Both are resolved by whatever renders the cards, by staging them beside the HTML.

## Previewing

Copy the templates plus the two unresolved files into one directory and capture:

```bash
DIR=$(mktemp -d)
cp src/briefing/cards/* "$DIR"/
cp assets/wordmark-dark.svg "$DIR"/
cp <some-photo>.png "$DIR"/photo.png

npx -p domotion-svg domotion capture "$DIR/story.html" --width 1080 --height 1920 -o "$DIR/story.svg"
npx -p domotion-svg svg-to-image "$DIR/story.svg" -o "$DIR/story.png" --width 380
```

Then **look at the PNG**. Stills first: composition, colour and type are where the problems are, and motion cannot rescue a weak frame.

Use a **bright, busy** photo when checking the photo card. A dark image flatters the scrim and hides whether the headline is actually legible over the picture.
