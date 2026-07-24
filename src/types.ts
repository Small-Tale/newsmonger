import type { Attendance } from './attendance.js';
import type { CheckRunner } from './checks.js';
import type { Store } from './db/store.js';

/** Hono environment: per-app dependencies injected by `createApp`. */
export interface AppEnv {
  Variables: {
    store: Store;
    runner: CheckRunner;
    attendance: Attendance;
  };
}
