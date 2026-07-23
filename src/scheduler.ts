import type { CheckRunner } from './checks.js';

const DEFAULT_TICK_MS = 60_000;

/**
 * Periodically runs due news checks. Every tick, topics whose last check is
 * older than the configured interval (or that have never been checked) are
 * checked. Ticks never overlap: if a sweep is still running, the tick is
 * skipped.
 */
export function startScheduler(runner: CheckRunner, tickMs: number = DEFAULT_TICK_MS): () => void {
  let sweeping = false;
  const tick = (): void => {
    if (sweeping) return;
    sweeping = true;
    runner
      .checkDue(new Date())
      .catch((err: unknown) => {
        console.error('news: scheduled check sweep failed:', err);
      })
      .finally(() => {
        sweeping = false;
      });
  };
  const handle = setInterval(tick, tickMs);
  // Run one sweep shortly after startup so overdue topics don't wait a full tick.
  const startupHandle = setTimeout(tick, 3_000);
  return () => {
    clearInterval(handle);
    clearTimeout(startupHandle);
  };
}
