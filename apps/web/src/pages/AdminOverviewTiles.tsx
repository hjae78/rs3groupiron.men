import type { AdminOverview } from '../api/adminClient';
import { DELETION_GRACE_DAYS } from '../lib/constants';
import { formatNumber } from '../lib/format';

export function AdminOverviewTiles({ overview }: { overview: AdminOverview | null }) {
  return (
    <section className="adm-tiles">
      <Tile label="Total groups" value={overview?.groups_total} />
      <Tile label="Created today" value={overview?.created_today} sub="UTC day" />
      <Tile label="Last 7 days" value={overview?.created_7d} />
      <Tile label="Last 30 days" value={overview?.created_30d} />
      <Tile
        label="Public groups"
        value={overview?.groups_public}
        sub={overview ? `${formatNumber(overview.groups_private)} private` : undefined}
      />
      <Tile label="Members" value={overview?.members_total} />
      <Tile
        label="Pending deletion"
        value={overview?.pending_deletion}
        sub={`${DELETION_GRACE_DAYS}-day grace`}
      />
    </section>
  );
}

function Tile({ label, value, sub }: { label: string; value?: number; sub?: string }) {
  return (
    <div className="adm-tile">
      <span className="adm-tile-label">{label}</span>
      <span className="adm-tile-value">{value == null ? '—' : formatNumber(value)}</span>
      {sub && <span className="adm-tile-sub">{sub}</span>}
    </div>
  );
}
