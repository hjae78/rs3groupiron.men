import { useMemo } from 'react';
import type { AdminDailyPoint } from '../api/adminClient';
import { formatNumber } from '../lib/format';

const CHART_RANGES = [14, 30, 90] as const;

function shortDay(day: string) {
  const at = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(at.getTime())
    ? day
    : at.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

export function AdminDailyChart({
  daily,
  days,
  onDaysChange,
}: {
  daily: AdminDailyPoint[];
  days: number;
  onDaysChange: (next: number) => void;
}) {
  return (
    <section className="adm-panel">
      <div className="adm-panel-head">
        <h2>Groups created per day</h2>
        <div className="adm-segs" role="group" aria-label="Chart range">
          {CHART_RANGES.map((range) => (
            <button
              key={range}
              type="button"
              className="adm-seg"
              aria-pressed={days === range}
              onClick={() => onDaysChange(range)}
            >
              {range}d
            </button>
          ))}
        </div>
      </div>
      <DailyChart daily={daily} />
    </section>
  );
}

function DailyChart({ daily }: { daily: AdminDailyPoint[] }) {
  const peak = useMemo(() => Math.max(1, ...daily.map((point) => point.groups)), [daily]);
  const made = useMemo(() => daily.reduce((sum, point) => sum + point.groups, 0), [daily]);

  if (daily.length === 0) {
    return <p className="adm-empty">No data yet.</p>;
  }

  const first = daily[0]!;
  const last = daily[daily.length - 1]!;

  return (
    <>
      <div
        className="adm-chart"
        role="img"
        aria-label={`${formatNumber(made)} groups created between ${first.day} and ${last.day}, peaking at ${formatNumber(peak)} in a day`}
      >
        {daily.map((point) => (
          <div
            key={point.day}
            className="adm-chart-col"
            title={`${shortDay(point.day)} · ${formatNumber(point.groups)} ${
              point.groups === 1 ? 'group' : 'groups'
            }`}
          >
            <div
              className={point.groups === 0 ? 'adm-chart-bar adm-chart-bar--zero' : 'adm-chart-bar'}
              style={{ height: `${Math.max(2, (point.groups / peak) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="adm-chart-axis">
        <span>{shortDay(first.day)}</span>
        <span>
          {formatNumber(made)} total · peak {formatNumber(peak)}/day
        </span>
        <span>{shortDay(last.day)}</span>
      </div>
    </>
  );
}
