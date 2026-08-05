import type { ProviderProbe } from './ai/providers/index.js';
import type { KeyVerifier } from './ai/verify-key.js';
import type { KeysResp } from './api/schemas.js';
import type { Attendance } from './attendance.js';
import type { Backups } from './backup.js';
import type { CheckRunner } from './checks.js';
import type { Store } from './db/store.js';
import type { DiscoveryService } from './discovery.js';
import type { ClearUndoBuffer } from './undo.js';

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
    /** Topic discovery (NEWS-125); null when the app was built without it. */
    discovery: DiscoveryService | null;
    /** In-memory undo for a cleared topic (NEWS-145). */
    undo: ClearUndoBuffer;
    /** Backup snapshots to the user's chosen folder (NEWS-192); null = no backups wired. */
    backups: Backups | null;
    /** Fills the settings provider picker; `--demo` swaps in a fixed set (NEWS-315). */
    probe: ProviderProbe;
    /** Fixed API-key panel for `--demo`; null reads the real environment and keychain (NEWS-315). */
    demoKeys: KeysResp | null;
  };
}
