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
 */
export type IconName = 'check' | 'pause' | 'play' | 'solo' | 'delete' | 'clear';

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
