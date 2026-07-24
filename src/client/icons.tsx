import type { SafeHtml } from 'kerfjs';

/**
 * The handful of Lucide icons the UI needs, inlined.
 *
 * Path data copied verbatim from `lucide-static@1.26.0` rather than taking a
 * runtime dependency: six icons is a few hundred bytes, whereas the package
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
  | 'bookmark'
  | 'share'
  | 'star';

function paths(name: IconName): SafeHtml {
  switch (name) {
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
