import type { DiscoverUsageResp, StateResp } from '../api/schemas.js';

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
  /**
   * Effort the check ran at (NEWS-226). `null` = not recorded (a run from
   * before the column existed); `''` = the model's own default.
   *
   * The two are kept apart deliberately: collapsing them would make every
   * historical run look like a default-effort data point, which is exactly the
   * comparison this field exists to support.
   */
  effort: string | null;
  newItems: number;
  /** Estimated cost, or null when it can't be known (NEWS-79). */
  error: string | null;
}

export function runRows(state: Pick<StateResp, 'runs' | 'topics'>): RunRow[] {
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
    effort: run.effort,
    newItems: run.newItems,
    error: run.error,
  }));
}

/**
 * How a run's effort reads in the bundle: ` · effort max`, or nothing at all.
 *
 * Silent for both "not recorded" and "provider default" — a line saying
 * "effort default" on every run from a provider that has no such parameter
 * would be noise on the majority of rows.
 */
export function effortLabel(effort: string | null): string {
  return effort === null || effort === '' ? '' : ` · effort ${effort}`;
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
   * Discovery's call log (NEWS-130), or null when it couldn't be read.
   *
   * Included because discovery is the one surface that can issue **unbounded**
   * AI calls, so "how many did this app make, and how many were free" is exactly
   * what a bug report about unexpected cost needs.
   *
   * Note what the log does *not* hold: the free-text query. It records the scope
   * **kind** only (`describe` / `section` / `tune`), so a user's description of
   * their interests — user content in the same sense a topic name is (FR-7.13) —
   * cannot reach a bundle that is usually pasted somewhere public. That is a
   * property of the recorder, not a filter here; keep it that way.
   */
  discovery: DiscoverUsageResp | null;
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
  lines.push('# Newsmonger diagnostics');
  lines.push('');
  lines.push(`version: ${opts.appVersion}`);
  lines.push(`user agent: ${opts.userAgent}`);
  lines.push(`provider setting: ${state.settings.provider}`);
  lines.push(`model setting: ${state.settings.model === '' ? '(provider default)' : state.settings.model}`);
  lines.push(`endpoint set: ${state.settings.endpoint === '' ? 'no' : 'yes'}`);
  lines.push(`check interval: ${String(Math.round(state.settings.checkIntervalMs / 60_000))} min`);
  lines.push(`topics: ${String(state.topics.length)} (${String(state.topics.filter((t) => t.paused).length)} paused)`);
  lines.push('');
  lines.push(`## Recent checks (${String(rows.length)})`);
  if (rows.length === 0) lines.push('(none recorded)');
  for (const [i, row] of rows.entries()) {
    const who = opts.includeTopicNames ? row.topicName : `topic ${String(i + 1)}`;
    lines.push(
      `- ${row.startedAt} ${row.status} ${who} · ${row.provider ?? 'no provider'}/${row.model ?? '?'}` +
        `${effortLabel(row.effort)} · ${formatDuration(row.durationMs)} · ${String(row.newItems)} new`,
    );
    // Error text is the whole point of the bundle, so it is never truncated
    // away — it is also the one field that could echo a topic name back, which
    // is why the redaction note below is unconditional.
    if (row.error !== null) lines.push(`    error: ${row.error}`);
  }
  lines.push('');
  lines.push('## Topic discovery');
  if (opts.discovery === null) {
    lines.push('(unavailable)');
  } else if (opts.discovery.calls === 0) {
    lines.push('(no discovery calls this session)');
  } else {
    const cached = opts.discovery.recent.filter((c) => c.cached).length;
    const failed = opts.discovery.recent.filter((c) => c.status === 'failed').length;
    lines.push(
      `${String(opts.discovery.calls)} calls this session ` +
        `(${String(cached)} of the last ${String(opts.discovery.recent.length)} served from cache, ${String(failed)} failed)`,
    );
    for (const call of opts.discovery.recent) {
      const via = call.cached ? 'cache' : `${call.provider ?? 'no provider'}/${call.model ?? '?'}`;
      lines.push(
        `- ${call.at} ${call.status} ${call.scope} · ${via} · ${String(call.returned)} returned` +
          (call.error === null ? '' : `\n    error: ${call.error}`),
      );
    }
  }

  lines.push('');
  lines.push(
    opts.includeTopicNames
      ? 'Topic names included at the reporter’s request. No API keys are present — the app never holds one client-side.'
      : 'Topic names redacted. Error text is verbatim and may still mention a topic. No API keys are present — the app never holds one client-side.',
  );
  return lines.join('\n');
}
