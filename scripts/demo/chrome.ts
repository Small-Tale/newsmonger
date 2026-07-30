/**
 * SVG compositing for the demo hero (NEWS-212).
 *
 * Wraps each captured frame in faux browser chrome and draws a broadcast-style
 * lower-third caption. Adapted from `~/Documents/glassbox/scripts/demo/chrome.ts`,
 * which is where the layout reasoning comes from; the divergences are the brand
 * (Newsmonger's pine accent, not glassbox's blue) and dropping the terminal
 * variant, since this demo has no terminal beats yet.
 *
 * The canvas background is **transparent** so the window floats on whatever the
 * README puts behind it, light or dark. Rounded corners and a hairline border
 * rather than a drop shadow — a shadow would be clipped by the tight margins.
 *
 * Layout (px, on the final canvas):
 *   ┌─ MARGIN_TOP ─────────────────────────────┐   (transparent)
 *   │  ╭─ title bar (TITLE_H) ──────────────╮   │  ← traffic lights + title
 *   │  │   captured content (CONTENT_W×H)   │   │
 *   │  ╰────────────────────────────────────╯   │
 *   │  ▌ lower-third pill (CAPTION_H)           │
 *   └───────────────────────────────────────────┘
 *
 * Content renders at CONTENT_W×CONTENT_H then translates by (OX, OY) inside the
 * card, so any overlay coordinate measured in content space must be shifted by
 * the same amount.
 */

const MARGIN_X = 24;
const MARGIN_TOP = 24;
const TITLE_H = 38;
const CAPTION_H = 84;

export const CONTENT_W = 1280;
export const CONTENT_H = 800;

/** Top-left of the captured content within the final canvas. */
export const OX = MARGIN_X;
export const OY = MARGIN_TOP + TITLE_H;

export const CANVAS_W = CONTENT_W + MARGIN_X * 2;
export const CANVAS_H = MARGIN_TOP + TITLE_H + CONTENT_H + CAPTION_H;

const CARD_W = CONTENT_W;
const CARD_H = TITLE_H + CONTENT_H;

const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

/**
 * The app's own pine accent (`--pine` dark-mode value from `styles.scss`).
 *
 * The dark variant rather than the light `#17604f`, because the caption pill sits
 * on a near-black background where the darker pine is close to invisible.
 */
const ACCENT = '#4da88e';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Square-top, rounded-bottom clip: the content's top edge meets the title bar. */
function contentClipPath(): string {
  const x0 = OX;
  const y0 = OY;
  const x1 = OX + CONTENT_W;
  const y1 = OY + CONTENT_H;
  const r = 13;
  return `M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1 - r} A ${r} ${r} 0 0 1 ${x1 - r} ${y1} L ${x0 + r} ${y1} A ${r} ${r} 0 0 1 ${x0} ${y1 - r} Z`;
}

export interface ChromeOpts {
  title: string;
  /** Unique id suffix so multi-frame clip-path ids can't collide. */
  id: string;
  caption?: string;
}

/** Wrap captured content in window chrome + lower-third, returning full-canvas markup. */
export function chromeWrap(contentSvg: string, opts: ChromeOpts): string {
  const { title, id, caption } = opts;
  const barFill = '#22272e';
  const clipId = `cclip-${id}`;
  const lightsY = MARGIN_TOP + TITLE_H / 2;

  const lights =
    `<circle cx="${MARGIN_X + 20}" cy="${lightsY}" r="6.5" fill="#ff5f57"/>` +
    `<circle cx="${MARGIN_X + 42}" cy="${lightsY}" r="6.5" fill="#febc2e"/>` +
    `<circle cx="${MARGIN_X + 64}" cy="${lightsY}" r="6.5" fill="#28c840"/>`;

  const titleText =
    `<text x="${CANVAS_W / 2}" y="${lightsY + 4.5}" text-anchor="middle" ` +
    `font-family="${SANS}" font-size="13" fill="#cdd3de">${esc(title)}</text>`;

  return (
    `<defs><clipPath id="${clipId}"><path d="${contentClipPath()}"/></clipPath></defs>` +
    `<rect x="${MARGIN_X}" y="${MARGIN_TOP}" width="${CARD_W}" height="${CARD_H}" rx="14" ry="14" fill="${barFill}"/>` +
    `<rect x="${MARGIN_X + 0.5}" y="${MARGIN_TOP + 0.5}" width="${CARD_W - 1}" height="${CARD_H - 1}" ` +
    `rx="13.5" ry="13.5" fill="none" stroke="#ffffff" stroke-opacity="0.10"/>` +
    lights +
    titleText +
    `<g clip-path="url(#${clipId})"><g transform="translate(${OX}, ${OY})">${contentSvg}</g></g>` +
    (caption !== undefined && caption !== '' ? lowerThird(caption) : '')
  );
}

/**
 * A left-anchored broadcast-style lower third: accent bar, brand eyebrow, caption.
 *
 * Self-contained (its own filled background) so it stays legible on a transparent
 * canvas over any page colour.
 */
function lowerThird(text: string): string {
  const bandY = MARGIN_TOP + TITLE_H + CONTENT_H;
  const pillH = 56;
  const pillY = bandY + (CAPTION_H - pillH) / 2;
  const pillX = MARGIN_X;
  // Width grows with the caption (~11.5px/char at 21px), clamped so a short one
  // isn't a stubby pill.
  const pillW = Math.max(360, 30 + Math.round(text.length * 11.5) + 30);
  const barX = pillX + 16;
  const barW = 5;
  const textX = barX + barW + 16;

  return (
    `<rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="13" ry="13" fill="#161b22" fill-opacity="0.96"/>` +
    `<rect x="${pillX + 0.5}" y="${pillY + 0.5}" width="${pillW - 1}" height="${pillH - 1}" rx="12.5" ry="12.5" ` +
    `fill="none" stroke="#ffffff" stroke-opacity="0.10"/>` +
    `<rect x="${barX}" y="${pillY + 14}" width="${barW}" height="${pillH - 28}" rx="2.5" fill="${ACCENT}"/>` +
    `<text x="${textX}" y="${pillY + 21}" font-family="${SANS}" font-size="10.5" font-weight="700" ` +
    `letter-spacing="2" fill="${ACCENT}">NEWSMONGER</text>` +
    `<text x="${textX}" y="${pillY + 42}" font-family="${SANS}" font-size="21" font-weight="600" ` +
    `fill="#e8edf4">${esc(text)}</text>`
  );
}

/** A closing card in the same window rect, so the loop lands somewhere deliberate. */
export function endCard(tagline: string): string {
  const cx = MARGIN_X + CARD_W / 2;
  const cy = MARGIN_TOP + CARD_H / 2;
  return (
    `<rect x="${MARGIN_X}" y="${MARGIN_TOP}" width="${CARD_W}" height="${CARD_H}" rx="14" ry="14" fill="#161b22"/>` +
    `<rect x="${MARGIN_X + 0.5}" y="${MARGIN_TOP + 0.5}" width="${CARD_W - 1}" height="${CARD_H - 1}" ` +
    `rx="13.5" ry="13.5" fill="none" stroke="#ffffff" stroke-opacity="0.10"/>` +
    `<text x="${cx}" y="${cy - 10}" text-anchor="middle" font-family="${SANS}" font-size="58" ` +
    `font-weight="700" fill="#e8edf4">Newsmonger</text>` +
    `<text x="${cx}" y="${cy + 40}" text-anchor="middle" font-family="${SANS}" font-size="24" ` +
    `fill="${ACCENT}">${esc(tagline)}</text>`
  );
}
