import type { SafeHtml } from 'kerfjs';

import type { PulseResp } from '../api/schemas.js';
import { icon } from './icons.js';

function linePoints(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) return '';
  const max = Math.max(1, ...values);
  return values
    .map((value, index) => {
      const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
      const y = height - (value / max) * (height - 3) - 1.5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** Tiny comparison chart shared by the rail and compact pulse surfaces. */
export function sparklineJsx(values: readonly number[], label: string, className = ''): SafeHtml {
  const points = linePoints(values, 72, 24);
  return (
    <span class={`sparkline ${className}`} role="img" aria-label={label}>
      <svg viewBox="0 0 72 24" width="72" height="24" aria-hidden="true">
        <polyline points={points} fill="none" vector-effect="non-scaling-stroke" />
      </svg>
    </span>
  );
}

function metric(value: string, label: string): SafeHtml {
  return (
    <span class="pulse-metric">
      <strong>{value}</strong> {label}
    </span>
  );
}

function trendText(pulse: PulseResp): string {
  if (pulse.trendPercent === null) return 'No comparable stories in the previous period';
  if (pulse.trendPercent === 0) return 'Even with the previous period';
  return `${pulse.trendPercent > 0 ? '+' : ''}${String(pulse.trendPercent)}% vs previous ${String(pulse.days)} days`;
}

function sourceShare(pulse: PulseResp): string {
  return pulse.topSourceShare === null ? '—' : `${String(Math.round(pulse.topSourceShare * 100))}%`;
}

function topSourceLabel(pulse: PulseResp): string {
  return pulse.sources[0]?.label ?? 'Top source';
}

function pulseScopeAttrs(pulse: PulseResp): Record<string, string> {
  return {
    'data-open-pulse-kind': pulse.scope.kind,
    'data-open-pulse-id': pulse.scope.id,
    'data-open-pulse-subcategory': pulse.scope.subcategory ?? '',
  };
}

/** The shallow summary shown above the feed for exactly one soloed topic. */
export function compactTopicPulseJsx(pulse: PulseResp): SafeHtml {
  return (
    <section class="compact-pulse" aria-labelledby="compact-pulse-title">
      <div class="compact-pulse-head">
        <div>
          <h2 id="compact-pulse-title">{pulse.scope.label}</h2>
          <span class="mode-pill">Solo</span>
        </div>
        <button class="btn link" type="button" data-action="exit-solo-pulse">Exit solo</button>
      </div>
      <div class="compact-pulse-body">
        <div class="compact-pulse-copy">
          <span class="eyebrow">30-day pulse</span>
          <div class="pulse-metrics">
            {metric(String(pulse.storyCount), pulse.storyCount === 1 ? 'story' : 'stories')}
            {metric(String(pulse.activeThreads), pulse.activeThreads === 1 ? 'active thread' : 'active threads')}
            {metric(String(pulse.distinctOutlets), pulse.distinctOutlets === 1 ? 'outlet' : 'outlets')}
            {metric(sourceShare(pulse), topSourceLabel(pulse))}
          </div>
          <div class="compact-pulse-trend">
            {sparklineJsx(pulse.series.map((point) => point.stories), `${trendText(pulse)}; daily story volume`)}
            <span>{trendText(pulse)}</span>
          </div>
          <small>Calculated from stored stories{pulse.smallSample ? ' · Small sample' : ''}</small>
        </div>
        <button class="btn primary" type="button" {...pulseScopeAttrs(pulse)}>
          Explore topic pulse {icon('chevron', 15)}
        </button>
      </div>
    </section>
  );
}

/** Understated rollup beneath an active category/subcategory filter. */
export function categoryPulseJsx(pulse: PulseResp): SafeHtml {
  return (
    <button class="category-pulse" type="button" {...pulseScopeAttrs(pulse)}>
      <span class="category-pulse-label">{pulse.scope.label}</span>
      <span>{String(pulse.storyCount)} stories · last 30 days</span>
      <span>{trendText(pulse)}</span>
      {sparklineJsx(pulse.series.map((point) => point.stories), `${pulse.scope.label}: ${trendText(pulse)}`)}
      <span class="category-pulse-open">Explore {icon('chevron', 13)}</span>
    </button>
  );
}

function shortDate(iso: string): string {
  const parsed = new Date(`${iso}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function cadenceText(pulse: PulseResp): string {
  if (pulse.cadence.averageDays === null) return 'Not enough stories to calculate';
  if (pulse.cadence.averageDays < 1) return 'More than one new story a day';
  return `A new story every ${String(pulse.cadence.averageDays)} days`;
}

/** Full deterministic drill-down, opened deliberately from a compact surface. */
export function pulseDialogJsx(pulse: PulseResp | null, loading: boolean, days: 7 | 30 | 90): SafeHtml {
  return (
    <div class="dialog-backdrop pulse-backdrop" data-action="close-pulse">
      <section class="dialog pulse-dialog" role="dialog" aria-modal="true" aria-labelledby="pulse-dialog-title">
        <header class="pulse-dialog-head">
          <div>
            <span class="eyebrow">Topic pulse</span>
            <h2 id="pulse-dialog-title">{pulse?.scope.label ?? 'Loading pulse…'}</h2>
          </div>
          <button class="btn icon" type="button" data-action="close-pulse" aria-label="Close">{icon('clear')}</button>
        </header>
        <div class="pulse-period" role="group" aria-label="Analysis period">
          {([7, 30, 90] as const).map((period) => (
            <button
              class={`btn${days === period ? ' active' : ''}`}
              type="button"
              data-pulse-days={String(period)}
              disabled={loading ? true : undefined}
            >
              {String(period)} days
            </button>
          ))}
        </div>
        <div class="pulse-dialog-content" aria-busy={loading ? 'true' : 'false'}>
          {pulse === null ? (
            <p class="pulse-loading">Calculating from stored stories…</p>
          ) : (
            <>
              <div class="pulse-stat-grid">
                <div><strong>{String(pulse.storyCount)}</strong><span>stories</span></div>
                <div><strong>{String(pulse.activeThreads)}</strong><span>active threads</span></div>
                <div><strong>{String(pulse.distinctOutlets)}</strong><span>distinct outlets</span></div>
                <div><strong>{sourceShare(pulse)}</strong><span>{topSourceLabel(pulse)}</span></div>
              </div>
              <p class={`pulse-sample${pulse.smallSample ? ' warn' : ''}`}>
                {pulse.smallSample ? 'Small sample — trends may shift quickly. ' : ''}{trendText(pulse)}.
              </p>
              <div class="pulse-detail-grid">
                <section class="pulse-panel pulse-over-time">
                  <h3>Coverage over time</h3>
                  <div class="pulse-bars" role="img" aria-label="Daily new stories and thread updates">
                    {pulse.series.map((point) => {
                      const max = Math.max(1, ...pulse.series.map((candidate) => candidate.stories));
                      return (
                        <span class="pulse-day" title={`${shortDate(point.date)}: ${String(point.stories)} stories, ${String(point.updates)} updates`}>
                          <span class="pulse-update" style={`height:${String((point.updates / max) * 100)}%`}></span>
                          <span class="pulse-story" style={`height:${String((point.stories / max) * 100)}%`}></span>
                        </span>
                      );
                    })}
                  </div>
                  <div class="pulse-legend"><span>Stories</span><span>Thread updates</span></div>
                  <details class="pulse-table-wrap">
                    <summary>View data table</summary>
                    <table>
                      <thead><tr><th>Date</th><th>Stories</th><th>Updates</th></tr></thead>
                      <tbody>{pulse.series.map((point) => <tr><td>{shortDate(point.date)}</td><td>{String(point.stories)}</td><td>{String(point.updates)}</td></tr>)}</tbody>
                    </table>
                  </details>
                </section>
                <section class="pulse-panel pulse-cadence">
                  <h3>Coverage cadence</h3>
                  <dl>
                    <div><dt>Typical pace</dt><dd>{cadenceText(pulse)}</dd></div>
                    <div><dt>Longest quiet period</dt><dd>{String(pulse.cadence.longestQuietDays)} days</dd></div>
                    <div><dt>Most active day</dt><dd>{pulse.cadence.mostActiveDate === null ? '—' : `${shortDate(pulse.cadence.mostActiveDate)} · ${String(pulse.cadence.mostActiveCount)} stories`}</dd></div>
                  </dl>
                </section>
                <section class="pulse-panel pulse-sources">
                  <h3>Source concentration</h3>
                  {pulse.sources.length === 0 ? <p>No source metadata in this period.</p> : (
                    <ol>
                      {pulse.sources.map((source) => (
                        <li><span>{source.label}</span><span class="source-bar"><i style={`width:${String(source.share * 100)}%`}></i></span><strong>{String(source.count)} · {String(Math.round(source.share * 100))}%</strong></li>
                      ))}
                      {pulse.otherSourceCount > 0 ? <li><span>Other outlets</span><span></span><strong>{String(pulse.otherSourceCount)}</strong></li> : ''}
                    </ol>
                  )}
                  <small>Counts each story's primary source, not viewpoints or independent reporting.</small>
                </section>
                <section class="pulse-panel pulse-threads">
                  <h3>Most-updated threads</h3>
                  {pulse.threads.length === 0 ? <p>No developing threads in this period.</p> : (
                    <ol>{pulse.threads.map((thread) => <li><div><strong>{thread.title}</strong><small>{new Date(thread.startedAt).toLocaleDateString()}–{new Date(thread.latestAt).toLocaleDateString()}</small></div><span>{String(thread.updates)} {thread.updates === 1 ? 'update' : 'updates'}</span></li>)}</ol>
                  )}
                </section>
              </div>
              <p class="pulse-method">All figures are calculated from stories stored in Newsmonger. No AI analysis.</p>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
