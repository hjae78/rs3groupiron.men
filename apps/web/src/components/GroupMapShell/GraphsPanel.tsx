import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  DEMO_GROUP,
  fetchXpHistory,
  type XpHistoryPeriod,
  type XpHistoryResponse,
} from '../../api/groupClient';
import { clickDownload, svgToPngBlob } from '../../lib/download';
import { errorMessage } from '../../lib/errors';
import { downloadCsv, downloadXlsx, type Table } from '../../lib/exportTable';
import {
  DEFAULT_GRAPH_PREFS,
  PERIODS as PERIOD_VALUES,
  readGraphPrefs,
  writeGraphPrefs,
  TIME_CHARTS,
  type ChartKind,
  type GraphPrefs,
} from '../../lib/graphPrefs';
import { colorForName, formatQty } from '../../lib/items';
import { SKILL_BY_ID, SKILLS } from '../../lib/skills';
import {
  DEMO_XP_SAMPLE_MS,
  demoGainFor,
  type DemoXp,
} from '../../hooks/useDemoActivity';
import { useLatestRequest } from '../../hooks/useLatestRequest';
import { useLiveRefresh } from '../../hooks/useLiveRefresh';
import { useUrlState } from '../../hooks/useUrlState';
import { Spinner } from '../Spinner';
import { ChartOptionsMenu } from './ChartOptionsMenu';
import { ExportMenu, type ExportFormat } from './ExportMenu';
import { IconSelect, type IconOption } from './IconSelect';
import { SkillIcon } from './MemberAvatar';
import { memberOptions, type MemberBadge } from './memberOptions';
import { PanelStatus } from './PanelChrome';
import { Segmented, type SegmentedOption } from './Segmented';
import { toUnix } from '../../lib/time';
import { XpChart, type ChartRow, type Slice } from './XpChart';

const PERIOD_OPTIONS: Array<SegmentedOption<XpHistoryPeriod>> = [
  { id: '24h', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '365d', label: 'Year' },
];

const PERIOD_TITLE: Record<XpHistoryPeriod, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '365d': 'Year',
};

const SKILL_OPTIONS: IconOption[] = [
  {
    value: 'overall',
    label: 'Overall',
    icon: <SkillIcon skillId="overall" />,
  },
  ...[...SKILLS]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((s) => ({ value: s.id, label: s.name, icon: <SkillIcon skillId={s.id} /> })),
];

const SKILL_VALUES: string[] = SKILL_OPTIONS.map((o) => o.value);

const MAX_SLICES = 10;

/** Module-level response cache so switching tabs doesn't refetch. */
const CACHE_TTL_MS = 60_000;
/** Group/period/skill combinations held before expired entries are swept. */
const CACHE_MAX = 50;
const historyCache = new Map<string, { at: number; data: XpHistoryResponse }>();

function cacheKey(group: string, period: XpHistoryPeriod, skill: string) {
  return `${group}|${period}|${skill}`;
}

function readCache(key: string) {
  const hit = historyCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    historyCache.delete(key);
    return null;
  }
  return hit.data;
}

function writeCache(key: string, data: XpHistoryResponse) {
  const now = Date.now();
  historyCache.set(key, { at: now, data });

  // Otherwise one entry accumulates for every combination ever visited.
  if (historyCache.size > CACHE_MAX) {
    for (const [k, entry] of historyCache) {
      if (now - entry.at >= CACHE_TTL_MS) historyCache.delete(k);
    }
  }
}

type GraphsPanelProps = {
  groupName?: string;
  groupToken?: string;
  dataRevision?: number;
  members?: ReadonlyArray<MemberBadge>;
  injectedXp?: DemoXp;
};

export function GraphsPanel({
  groupName = DEMO_GROUP,
  groupToken = '',
  dataRevision,
  members = [],
  injectedXp,
}: GraphsPanelProps) {
  const [urlParams] = useSearchParams();
  const [prefs, setPrefs] = useState<GraphPrefs>(readGraphPrefs);
  const { mode, logScale, chart } = prefs;

  const [period, setPeriodUrl] = useUrlState('period', DEFAULT_GRAPH_PREFS.period, {
    allowed: PERIOD_VALUES,
  });
  const [skill, setSkillUrl] = useUrlState('skill', DEFAULT_GRAPH_PREFS.skill, {
    allowed: SKILL_VALUES,
  });
  const [playerFilter, setPlayerUrl] = useUrlState('member', DEFAULT_GRAPH_PREFS.player);

  const [data, setData] = useState<XpHistoryResponse | null>(() =>
    readCache(cacheKey(groupName, period, skill)),
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  // Pointing at a legend name emphasises that member's series; it is a
  // read-only highlight, so nothing is ever hidden from the chart.
  const [highlight, setHighlight] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const [saving, setSaving] = useState<ExportFormat | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const request = useLatestRequest();

  const isTimeChart = TIME_CHARTS.includes(chart);

  const patch = useCallback(
    (next: Partial<GraphPrefs>) => {
      if (next.period !== undefined) setPeriodUrl(next.period);
      if (next.skill !== undefined) setSkillUrl(next.skill);
      if (next.player !== undefined) setPlayerUrl(next.player);
      setPrefs((prev) => {
        const merged = { ...prev, ...next };
        writeGraphPrefs(merged);
        return merged;
      });
    },
    [setPeriodUrl, setSkillUrl, setPlayerUrl],
  );

  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (urlParams.has('period') || urlParams.has('skill') || urlParams.has('member')) return;
    const saved = readGraphPrefs();
    if (saved.period !== DEFAULT_GRAPH_PREFS.period) setPeriodUrl(saved.period);
    if (saved.skill !== DEFAULT_GRAPH_PREFS.skill) setSkillUrl(saved.skill);
    if (saved.player !== DEFAULT_GRAPH_PREFS.player) setPlayerUrl(saved.player);
  }, [urlParams, setPeriodUrl, setSkillUrl, setPlayerUrl]);

  const load = useCallback(
    async (force = false, silent = false) => {
      const key = cacheKey(groupName, period, skill);
      const cached = force ? null : readCache(key);
      if (!cached && !silent) setLoading(true);
      setError(null);
      const settled = await request(async (signal) => {
        if (cached) return cached;
        const next = await fetchXpHistory(groupName, groupToken, period, skill, signal);
        writeCache(key, next);
        return next;
      });
      if (!settled) return;
      if (settled.ok) setData(settled.value);
      else setError(errorMessage(settled.error, 'Failed to load XP history'));
      setLoading(false);
    },
    [request, groupName, groupToken, period, skill],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // `force` skips the cache, which is the whole point of refreshing.
  useLiveRefresh(
    useCallback(() => void load(true, true), [load]),
    { signal: dataRevision, intervalMs: 300_000 },
  );

  // Demo gains are appended on a synthetic clock that carries on past the end
  // of the fetched window, so the live tail can never fall behind a refreshed
  // `to` and dip the cumulative line.
  const view = useMemo<XpHistoryResponse | null>(() => {
    const samples = injectedXp?.samples ?? [];
    if (!data || !injectedXp || !samples.length) return data;

    const grid = data.series[0]?.points ?? [];
    const lastT = grid.length ? new Date(grid[grid.length - 1]!.t).getTime() : Date.now();
    const stamps = samples.map((_, i) =>
      new Date(lastT + (i + 1) * DEMO_XP_SAMPLE_MS).toISOString(),
    );

    const names = [
      ...new Set([...data.series.map((s) => s.name), ...Object.keys(injectedXp.totals)]),
    ];

    const series = names.map((name) => {
      const base = data.series.find((s) => s.name === name);
      const points = base ? [...base.points] : grid.map((p) => ({ t: p.t, gain: 0 }));
      const tail = points[points.length - 1]?.gain ?? 0;
      samples.forEach((entry, i) => {
        points.push({ t: stamps[i]!, gain: tail + demoGainFor(entry.totals, name, skill) });
      });
      return { name, points };
    });

    const players = names.map((name) => {
      const base = data.players.find((p) => p.name === name);
      const gains = injectedXp.totals[name] ?? {};
      const bySkill = new Map((base?.skills ?? []).map((s) => [s.id, { ...s }]));
      for (const id of Object.keys(gains)) {
        if (skill !== 'overall' && id !== skill) continue;
        const row = bySkill.get(id);
        if (row) row.gain += gains[id]!;
        else {
          bySkill.set(id, {
            id,
            name: SKILL_BY_ID[id as SkillKey]?.name ?? id,
            gain: gains[id]!,
          });
        }
      }
      return {
        name,
        totalGain: (base?.totalGain ?? 0) + demoGainFor(injectedXp.totals, name, skill),
        skills: [...bySkill.values()].sort((a, b) => b.gain - a.gain),
      };
    });

    return { ...data, series, players };
  }, [data, injectedXp, skill]);

  useEffect(() => {
    if (!view || playerFilter === 'all') return;
    if (!view.players.some((p) => p.name === playerFilter)) patch({ player: 'all' });
  }, [view, playerFilter, patch]);

  const playerOptions = useMemo(
    () =>
      memberOptions(
        (view?.players ?? []).map((p) => p.name),
        members,
        'All players',
      ),
    [view, members],
  );

  const matchesFilter = useCallback(
    (name: string) => playerFilter === 'all' || name === playerFilter,
    [playerFilter],
  );

  const visibleSeries = useMemo(
    () => (view?.series ?? []).filter((s) => matchesFilter(s.name)),
    [view, matchesFilter],
  );

  const visiblePlayers = useMemo(
    () => (view?.players ?? []).filter((p) => matchesFilter(p.name)),
    [view, matchesFilter],
  );

  const chartRows = useMemo<ChartRow[]>(() => {
    if (!visibleSeries.length) return [];
    const byTime = new Map<string, ChartRow>();
    for (const series of visibleSeries) {
      let previous = 0;
      for (const point of series.points) {
        const row = byTime.get(point.t) ?? { t: point.t };
        row[series.name] = mode === 'interval' ? Math.max(0, point.gain - previous) : point.gain;
        previous = point.gain;
        byTime.set(point.t, row);
      }
    }
    return [...byTime.values()].sort(
      (a, b) => new Date(String(a.t)).getTime() - new Date(String(b.t)).getTime(),
    );
  }, [visibleSeries, mode]);

  const slices = useMemo<Slice[]>(() => {
    const raw =
      playerFilter === 'all'
        ? visiblePlayers.map((p) => ({ name: p.name, value: p.totalGain }))
        : (visiblePlayers[0]?.skills ?? []).map((s) => ({ name: s.name, value: s.gain }));

    const ranked = raw.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
    if (ranked.length <= MAX_SLICES) return ranked;
    const head = ranked.slice(0, MAX_SLICES - 1);
    const rest = ranked.slice(MAX_SLICES - 1).reduce((sum, s) => sum + s.value, 0);
    return rest > 0 ? [...head, { name: 'Other', value: rest }] : head;
  }, [playerFilter, visiblePlayers]);

  const lastIndex = Math.max(0, chartRows.length - 1);
  const start = Math.min(range?.start ?? 0, lastIndex);
  const end = Math.min(range?.end ?? lastIndex, lastIndex);
  const zoomed = isTimeChart && range !== null && (start > 0 || end < lastIndex);

  useEffect(() => setRange(null), [period, skill, mode]);

  const seriesNames = useMemo(() => visibleSeries.map((s) => s.name), [visibleSeries]);
  const shownNames = seriesNames;

  const endDrag = useCallback(() => {
    setDrag((current) => {
      if (!current) return null;
      const [from, to] = [current.from, current.to].sort((a, b) => a - b);
      if (to - from >= 1) setRange({ start: from, end: to });
      return null;
    });
  }, []);

  const baseName = `${groupName}-${skill}-${period}-${chart}`
    .replace(/\s+/g, '-')
    .toLowerCase();

  function exportTable(): Table {
    if (isTimeChart) {
      return {
        filename: baseName,
        sheet: `${skillLabel} ${PERIOD_TITLE[period]}`,
        headers: ['Time (unix)', ...shownNames],
        rows: chartRows.map((row) => [
          toUnix(String(row.t)),
          ...shownNames.map((name) => Number(row[name] ?? 0)),
        ]),
      };
    }
    const total = slices.reduce((sum, s) => sum + s.value, 0);
    return {
      filename: baseName,
      sheet: `${skillLabel} ${PERIOD_TITLE[period]}`,
      headers: [playerFilter === 'all' ? 'Member' : 'Skill', 'XP', 'Share %'],
      rows: slices.map((s) => [
        s.name,
        s.value,
        total ? Math.round((s.value / total) * 1000) / 10 : 0,
      ]),
    };
  }

  async function downloadPng() {
    // Legend swatches carry .recharts-surface too and sort first in the DOM.
    const svg = chartRef.current?.querySelector<SVGSVGElement>('.recharts-wrapper > svg');
    if (!svg) throw new Error('The chart is not ready yet');
    const legend = isTimeChart
      ? shownNames.map((name) => ({ label: name, color: colorForName(name) }))
      : slices.map((s) => ({ label: s.name, color: colorForName(s.name) }));
    const blob = await svgToPngBlob(svg, {
      background: '#12100c',
      caption: `${skillLabel} — ${PERIOD_TITLE[period]}${mode === 'interval' && isTimeChart ? ' (per step)' : ''}`,
      legend,
    });
    const href = URL.createObjectURL(blob);
    clickDownload(href, `${baseName}.png`);
    URL.revokeObjectURL(href);
  }

  async function runExport(format: ExportFormat) {
    setSaving(format);
    try {
      if (format === 'png') await downloadPng();
      else if (format === 'csv') downloadCsv(exportTable());
      else await downloadXlsx(exportTable());
    } catch (err) {
      setError(errorMessage(err, 'Could not export the chart'));
    } finally {
      setSaving(null);
    }
  }

  const skillLabel =
    skill === 'overall' ? 'Overall' : (SKILL_BY_ID[skill as SkillKey]?.name ?? skill);
  const hasChart = view != null && (isTimeChart ? chartRows.length > 0 : slices.length > 0);

  return (
    <section className="gms-graphs gms-panel" aria-label="XP graphs" aria-busy={loading}>
      <div className="gms-graphs-toolbar">
        <span className="gms-graphs-label">Period</span>
        <Segmented
          options={PERIOD_OPTIONS}
          value={period}
          ariaLabel="Period"
          onChange={(value) => patch({ period: value })}
        />

        <span className="gms-graphs-label">Skill</span>
        <IconSelect
          label="Skill"
          hideLabel
          value={skill}
          options={SKILL_OPTIONS}
          onChange={(value) => patch({ skill: value })}
        />

        <span className="gms-graphs-label">Player</span>
        <IconSelect
          label="Player"
          hideLabel
          value={playerFilter}
          options={playerOptions}
          onChange={(value) => patch({ player: value })}
        />

        <span className="gms-graphs-spacer" />

        {/* Only while it applies — an always-there disabled button is noise. */}
        {zoomed && (
          <button
            type="button"
            className="gms-graphs-toggle"
            title="Show the whole period again"
            onClick={() => setRange(null)}
          >
            Reset zoom
          </button>
        )}

        <ChartOptionsMenu
          chart={chart}
          onChartChange={(value) => patch({ chart: value })}
          showMode={isTimeChart}
          mode={mode}
          onModeChange={(value) => patch({ mode: value })}
          showLogScale={chart !== 'pie'}
          logScale={logScale}
          onLogScaleChange={(on) => patch({ logScale: on })}
        />

        <ExportMenu
          busy={saving}
          disabled={!hasChart}
          onExport={(format) => void runExport(format)}
        />
      </div>

      <div className="gms-graphs-chart-wrap">
        <h2 className="gms-graphs-title">
          {`${skillLabel} · ${PERIOD_TITLE[period]}`}
          {isTimeChart && mode === 'interval' && (
            <span className="gms-graphs-title-tag">per step</span>
          )}
          {zoomed && <span className="gms-graphs-title-tag">zoomed</span>}
        </h2>

        {/* The spinner takes the chart's place rather than sitting beside it, so
            the panel doesn't reflow between states. */}
        {loading ? (
          <div className="gms-graphs-chart gms-graphs-chart--loading">
            <Spinner label="Loading XP history…" />
          </div>
        ) : (
          <>
            <PanelStatus error={error} />
            {!error && hasChart && (
              <div className="gms-graphs-chart" ref={chartRef}>
                <XpChart
                  kind={chart}
                  period={period}
                  mode={mode}
                  logScale={logScale}
                  rows={chartRows}
                  slices={slices}
                  seriesNames={seriesNames}
                  highlight={highlight}
                  start={start}
                  end={end}
                  drag={drag}
                  onDragStart={(i) => setDrag({ from: i, to: i })}
                  onDragMove={(i) => setDrag((d) => (d ? { from: d.from, to: i } : d))}
                  onDragEnd={endDrag}
                  onBrush={(s, e) => setRange({ start: s, end: e })}
                />
              </div>
            )}
            {!error && !hasChart && (
              <p className="gms-panel-status">No XP recorded in this period.</p>
            )}
          </>
        )}

        {!loading && hasChart && (
          <p className="gms-graphs-hint">{chartHint(chart, playerFilter === 'all')}</p>
        )}
      </div>

      <div
        className={
          skill === 'overall'
            ? 'gms-graphs-players'
            : 'gms-graphs-players gms-graphs-players--totals'
        }
      >
        {skill === 'overall' ? (
          visiblePlayers.map((player) => <PlayerBreakdown key={player.name} player={player} />)
        ) : (
          <div className="gms-graphs-totals">
            {visiblePlayers.map((player) => (
              <span
                key={player.name}
                className={
                  highlight === player.name
                    ? 'gms-graphs-total-chip gms-graphs-total-chip--on'
                    : 'gms-graphs-total-chip'
                }
                onMouseEnter={() => setHighlight(player.name)}
                onMouseLeave={() => setHighlight(null)}
              >
                <span
                  className="gms-graphs-player-dot"
                  style={{ background: colorForName(player.name) }}
                />
                <span className="gms-graphs-total-name">{player.name}</span>
                <span className="gms-graphs-player-total">+{formatQty(player.totalGain)}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function chartHint(chart: ChartKind, wholeGroup: boolean) {
  if (TIME_CHARTS.includes(chart)) {
    return 'Drag across the chart to zoom · scroll to zoom · drag the timeline to pan · double-click to reset · hover a name to highlight it';
  }
  if (chart === 'pie') {
    return wholeGroup
      ? 'Share of the group’s XP this period'
      : 'Share of this member’s XP by skill';
  }
  return wholeGroup
    ? 'XP per member this period, biggest first'
    : 'XP per skill for this member, biggest first';
}

type SkillKey = keyof typeof SKILL_BY_ID;
type GraphPlayer = XpHistoryResponse['players'][number];

function PlayerBreakdown({ player }: { player: GraphPlayer }) {
  const color = colorForName(player.name);
  const maxSkill = Math.max(1, ...player.skills.map((s) => s.gain));

  return (
    <article className="gms-graphs-player">
      <header className="gms-graphs-player-head">
        <span className="gms-graphs-player-dot" style={{ background: color }} />
        <strong>{player.name}</strong>
        <span className="gms-graphs-player-total">+{formatQty(player.totalGain)}</span>
      </header>
      {player.skills.length > 0 && (
        <ul className="gms-graphs-skill-list">
          {player.skills.slice(0, 12).map((row) => {
            const def = SKILL_BY_ID[row.id as SkillKey];
            return (
              <li key={row.id} className="gms-graphs-skill-row">
                <img
                  className="gms-graphs-skill-icon"
                  src={`/skills/${def?.icon ?? `${row.id}.png`}`}
                  alt=""
                  width={18}
                  height={18}
                />
                <span className="gms-graphs-skill-name">{row.name}</span>
                <div className="gms-graphs-skill-bar-track">
                  <div
                    className="gms-graphs-skill-bar"
                    style={{
                      width: `${Math.max(4, (row.gain / maxSkill) * 100)}%`,
                      background: color,
                    }}
                  />
                </div>
                <span className="gms-graphs-skill-gain">+{formatQty(row.gain)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}
