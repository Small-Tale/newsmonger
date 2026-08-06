/** Types for the npm/npx spawn helper (NEWS-356). See the `.mjs` for the why. */

/** A command name and whether it must go through a shell to run. */
export type SpawnSpec = { command: string; shell: boolean };

/** How to spawn `npm` on `platform` (defaults to the running one). */
export function npmSpawn(platform?: NodeJS.Platform): SpawnSpec;

/** How to spawn `npx` on `platform` (defaults to the running one). */
export function npxSpawn(platform?: NodeJS.Platform): SpawnSpec;
