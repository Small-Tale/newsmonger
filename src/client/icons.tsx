import type { SafeHtml } from 'kerfjs';

/**
 * The handful of Lucide icons the UI needs, inlined.
 *
 * Path data copied verbatim from `lucide-static@1.26.0` rather than taking a
 * runtime dependency: a couple of dozen icons is a few hundred bytes, whereas the package
 * would be staged into the desktop sidecar's `node_modules` (see
 * `scripts/build-sidecar.sh`) for the same result. Re-copy from the same
 * source if more are added, so the set stays visually consistent.
 *
 * Lucide's grid is 24×24 with a 2px stroke; `stroke-width` is scaled down here
 * because these render at 15px, where a literal 2px stroke reads as a blob.
 *
 * Every icon in the UI comes from here. No emoji, and no hand-drawn glyphs —
 * emoji render as someone else's artwork at someone else's weight and colour,
 * which no amount of CSS brings into line with a stroked icon set. The one
 * exception is the watch dial, which is a data visualisation (its arc encodes
 * progress toward the next check) rather than an icon.
 */
export type IconName =
  | 'check'
  | 'pause'
  | 'play'
  | 'solo'
  | 'delete'
  | 'clear'
  | 'settings'
  | 'panel'
  | 'ok'
  | 'warn'
  | 'arrow'
  | 'download'
  | 'upload'
  | 'bookmark'
  | 'share'
  | 'star'
  | 'search'
  | 'guidance'
  | 'flag'
  | 'shield'
  | 'clock'
  | 'key'
  | 'bell'
  | 'database'
  | 'bot'
  | 'grid'
  | 'funnel'
  | 'blend'
  | 'pencil'
  | 'chevron';

function paths(name: IconName): SafeHtml {
  switch (name) {
    case 'pencil':
      return (
        <g>
          <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
          <path d="m15 5 4 4" />
        </g>
      );
    case 'funnel': // narrowing a topic down
      return (
        <g>
          <path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z" />
        </g>
      );
    case 'blend': // two overlapping circles — adjacent, related
      return (
        <g>
          <circle cx="9" cy="9" r="7" />
          <circle cx="15" cy="15" r="7" />
        </g>
      );
    case 'grid': // lucide grid-2x2 — browsing a set of topics, not navigating (NEWS-362)
      return (
        <g>
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M3 12h18" />
          <path d="M12 3v18" />
        </g>
      );
    case 'shield':
      return (
        <g>
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
        </g>
      );
    case 'clock':
      return (
        <g>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </g>
      );
    case 'key':
      return (
        <g>
          <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
          <path d="m21 2-9.6 9.6" />
          <circle cx="7.5" cy="15.5" r="5.5" />
        </g>
      );
    case 'bell':
      return (
        <g>
          <path d="M10.268 21a2 2 0 0 0 3.464 0" />
          <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
        </g>
      );
    case 'database':
      return (
        <g>
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5V19A9 3 0 0 0 21 19V5" />
          <path d="M3 12A9 3 0 0 0 21 12" />
        </g>
      );
    case 'bot':
      return (
        <g>
          <path d="M12 8V4H8" />
          <rect width="16" height="12" x="4" y="8" rx="2" />
          <path d="M2 14h2" />
          <path d="M20 14h2" />
          <path d="M15 13v2" />
          <path d="M9 13v2" />
        </g>
      );
    case 'check': // rotate-cw
      return (
        <g>
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
        </g>
      );
    case 'pause':
      return (
        <g>
          <rect x="14" y="3" width="5" height="18" rx="1" />
          <rect x="5" y="3" width="5" height="18" rx="1" />
        </g>
      );
    case 'play':
      return (
        <g>
          <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
        </g>
      );
    case 'solo': // circle-dot
      return (
        <g>
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="1" />
        </g>
      );
    case 'delete': // trash-2
      return (
        <g>
          <path d="M10 11v6" />
          <path d="M14 11v6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </g>
      );
    case 'clear': // x
      return (
        <g>
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </g>
      );
    case 'settings':
      return (
        <g>
          <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
          <circle cx="12" cy="12" r="3" />
        </g>
      );
    case 'panel': // panel-left
      return (
        <g>
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M9 3v18" />
        </g>
      );
    case 'ok': // check
      return (
        <g>
          <path d="M20 6 9 17l-5-5" />
        </g>
      );
    case 'warn': // triangle-alert
      return (
        <g>
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </g>
      );
    case 'arrow': // arrow-right
      return (
        <g>
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </g>
      );
    case 'bookmark':
      return (
        <g>
          <path d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z" />
        </g>
      );
    case 'download': // lucide `download` — an arrow into a tray, not a share graph
      return (
        <g>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" x2="12" y1="15" y2="3" />
        </g>
      );
    case 'upload': // lucide `upload` — the same tray, arrow reversed, so import
      // and export read as one pair rather than as two unrelated controls.
      return (
        <g>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" x2="12" y1="3" y2="15" />
        </g>
      );
    case 'share': // share-2
      return (
        <g>
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" x2="15.42" y1="13.51" y2="17.49" />
          <line x1="15.41" x2="8.59" y1="6.51" y2="10.49" />
        </g>
      );
    case 'star':
      return (
        <g>
          <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.12 2.12 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.12 2.12 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.12 2.12 0 0 0 1.597-1.16z" />
        </g>
      );
    case 'search':
      return (
        <g>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </g>
      );
    case 'guidance': // crosshair — a topic narrowed to what the user actually wants
      return (
        <g>
          <circle cx="12" cy="12" r="10" />
          <line x1="22" x2="18" y1="12" y2="12" />
          <line x1="6" x2="2" y1="12" y2="12" />
          <line x1="12" x2="12" y1="6" y2="2" />
          <line x1="12" x2="12" y1="22" y2="18" />
        </g>
      );
    case 'flag':
      return (
        <g>
          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
          <line x1="4" x2="4" y1="22" y2="15" />
        </g>
      );
    case 'chevron': // chevron-down — the disclosure marker on a story card
      return (
        <g>
          <path d="m6 9 6 6 6-6" />
        </g>
      );
  }
}

/** Render an icon at `size` px. Decorative — always paired with a text label. */
export function icon(name: IconName, size = 15): SafeHtml {
  return (
    <svg class="icon" viewBox="0 0 24 24" width={String(size)} height={String(size)} aria-hidden="true">
      {paths(name)}
    </svg>
  );
}
