import type { KeyVerifier } from './ai/verify-key.js';
import type { Attendance } from './attendance.js';
import type { CheckRunner } from './checks.js';
import type { Store } from './db/store.js';

/** Hono environment: per-app dependencies injected by `createApp`. */
export interface AppEnv {
  Variables: {
    store: Store;
    runner: CheckRunner;
    attendance: Attendance;
    /** Data directory, for locating the on-disk image cache. */
    dataDir: string;
    /** Vendor-side key check before saving (NEWS-78); null skips it. */
    verifyKey: KeyVerifier | null;
  };
}
