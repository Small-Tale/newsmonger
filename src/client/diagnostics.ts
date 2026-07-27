import { estimateCostUsd, formatUsd } from '../ai/pricing.js';
import type { StateResp } from '../api/schemas.js';

/** One row of the diagnostics table, already resolved for display. */
export interface RunRow {
  id: string;
  topicId: string;
  /** Topic name, or a placeholder when the topic has since been deleted. */
  topicName: string;
  startedAt: string;
  status: StateResp['runs'][number]['status'];
  /** Wall-clock duration in ms, or null while the run is still in flight. */
  durationMs: number | null;
  provider: string | null;
  model: string | null;
  newItems: number;
  /** Estimated cost, or null when it can't be known (NEWS-79). */
  costUsd: number | null;
  error: string | null;
}

export function runRows(state: Pick<StateResp, 'runs' | 'topics' | 'prices'>): RunRow[] {
  const names = new Map(state.topics.map((t) => [t.id, t.name]));
  return state.runs.map((run) => ({
    id: run.id,
    topicId: run.topicId,
    topicName: names.get(run.topicId) ?? 'deleted topic',
    startedAt: run.startedAt,
    status: run.status,
    durationMs: run.finishedAt === null ? null : Date.parse(run.finishedAt) - Date.parse(run.startedAt),
    provider: run.provider,
    model: run.model,
    newItems: run.newItems,
    costUsd: estimateCostUsd(run.model ?? '', run.usage, state.prices),
    error: run.error,
  }));
}

/** "1.2s" / "4m 08s" — a duration a person can compare at a glance. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${String(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`;
}

export interface DiagnosticsOptions {
  /**
   * Include topic names. Off by default: a topic name is user content — the
   * privacy note treats it as such (see `docs/7-api-keys.md` FR-7.13) — and a
   * bug report is usually pasted somewhere public.
   */
  includeTopicNames: boolean;
  /** Runtime facts the client can only learn from the page it's running in. */
  userAgent: string;
  appVersion: string;
}

/**
 * A redacted diagnostics bundle for a bug report (NEWS-88).
 *
 * Carries what makes a failure reproducible — versions, the active provider,
 * and the recent run outcomes with their error text — and nothing that
 * identifies the user or their interests. **API keys can't leak here by
 * construction**: no key value exists anywhere in client state to begin with
 * (see `KeyStatusSchema`), so there is nothing to filter out.
 */
export function buildDiagnostics(state: StateResp, opts: DiagnosticsOptions): string {
  const rows = runRows(state);
  const lines: string[] = [];
  lines.push('# News diagnostics');
  lines.push('');
  lines.push(`version: ${opts.appVersion}`);
  lines.push(`user agent: ${opts.userAgent}`);
  lines.push(`provider setting: ${state.settings.provider}`);
  lines.push(`model setting: ${state.settings.model === '' ? '(provider default)' : state.settings.model}`);
  lines.push(`endpoint set: ${state.settings.endpoint === '' ? 'no' : 'yes'}`);
  lines.push(`check interval: ${String(Math.round(state.settings.checkIntervalMs / 60_000))} min`);
  lines.push(`topics: ${String(state.topics.length)} (${String(state.topics.filter((t) => t.paused).length)} paused)`);
  lines.push(
    `spend this month: ${formatUsd(state.spend.usd)} across ${String(state.spend.pricedRuns)} priced runs` +
      `, ${String(state.spend.unpricedRuns)} unpriced`,
  );
  lines.push(`monthly budget: ${state.spend.monthlyBudgetUsd === 0 ? 'none' : formatUsd(state.spend.monthlyBudgetUsd)}`);
  lines.push('');
  lines.push(`## Recent checks (${String(rows.length)})`);
  if (rows.length === 0) lines.push('(none recorded)');
  for (const [i, row] of rows.entries()) {
    const who = opts.includeTopicNames ? row.topicName : `topic ${String(i + 1)}`;
    const cost = row.costUsd === null ? 'cost unknown' : formatUsd(row.costUsd);
    lines.push(
      `- ${row.startedAt} ${row.status} ${who} · ${row.provider ?? 'no provider'}/${row.model ?? '?'}` +
        ` · ${formatDuration(row.durationMs)} · ${String(row.newItems)} new · ${cost}`,
    );
    // Error text is the whole point of the bundle, so it is never truncated
    // away — it is also the one field that could echo a topic name back, which
    // is why the redaction note below is unconditional.
    if (row.error !== null) lines.push(`    error: ${row.error}`);
  }
  lines.push('');
  lines.push(
    opts.includeTopicNames
      ? 'Topic names included at the reporter’s request. No API keys are present — the app never holds one client-side.'
      : 'Topic names redacted. Error text is verbatim and may still mention a topic. No API keys are present — the app never holds one client-side.',
  );
  return lines.join('\n');
}
