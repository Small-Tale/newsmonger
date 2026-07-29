import { main } from './cli.js';

/** Entry point for `npm run briefing`. Kept separate so `cli.ts` stays importable by tests. */
process.exit(main());
