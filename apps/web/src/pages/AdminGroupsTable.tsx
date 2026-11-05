import { memo } from 'react';
import { Link } from 'react-router-dom';
import type {
  AdminGroup,
  AdminGroupFilter,
  AdminGroupsPage,
  AdminGroupSort,
  AdminSortDir,
} from '../api/adminClient';
import { DELETION_GRACE_DAYS } from '../lib/constants';
import { formatDate, formatDateTime, formatNumber } from '../lib/format';

export type AdminGroupsTableProps = {
  query: string;
  search: string;
  onSearchChange: (value: string) => void;
  filter: AdminGroupFilter;
  onFilterChange: (value: AdminGroupFilter) => void;
  sort: AdminGroupSort;
  dir: AdminSortDir;
  onSort: (value: AdminGroupSort) => void;
  table: AdminGroupsPage | null;
  tableError: string | null;
  loading: boolean;
  actionError: string | null;
  notice: string | null;
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  pendingId: string | null;
  onSchedule: (group: AdminGroup) => void;
  onCancel: (group: AdminGroup) => void;
  onDeleteRequest: (group: AdminGroup) => void;
};

export function AdminGroupsTable({
  query,
  search,
  onSearchChange,
  filter,
  onFilterChange,
  sort,
  dir,
  onSort,
  table,
  tableError,
  loading,
  actionError,
  notice,
  page,
  pages,
  total,
  pageSize,
  onPageChange,
  pendingId,
  onSchedule,
  onCancel,
  onDeleteRequest,
}: AdminGroupsTableProps) {
  return (
    <section className="adm-panel">
      <div className="adm-panel-head">
        <h2>Groups</h2>
        <span className="adm-stamp">{formatNumber(total)} matching</span>
      </div>

      <div className="adm-controls">
        <div className="adm-search">
          <input
            type="search"
            value={search}
            placeholder="Search by group name"
            aria-label="Search by group name"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        <div className="adm-segs" role="group" aria-label="Filter groups">
          <FilterButton current={filter} value="all" label="All" onPick={onFilterChange} />
          <FilterButton current={filter} value="public" label="Public" onPick={onFilterChange} />
          <FilterButton current={filter} value="private" label="Private" onPick={onFilterChange} />
          <FilterButton
            current={filter}
            value="pending_deletion"
            label="Pending deletion"
            onPick={onFilterChange}
          />
        </div>
      </div>

      {actionError && <p className="adm-error">{actionError}</p>}
      {notice && <p className="adm-ok">{notice}</p>}
      {tableError && <p className="adm-error">{tableError}</p>}

      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              <SortHeader label="Group" value="name" sort={sort} dir={dir} onSort={onSort} />
              <th>Visibility</th>
              <th>Mode</th>
              <SortHeader
                label="Members"
                value="members"
                sort={sort}
                dir={dir}
                onSort={onSort}
                numeric
              />
              <SortHeader
                label="Views"
                value="views"
                sort={sort}
                dir={dir}
                onSort={onSort}
                numeric
              />
              <SortHeader label="Created" value="created_at" sort={sort} dir={dir} onSort={onSort} />
              <th>Last activity</th>
              <th>Deletion</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {table?.groups.map((group) => (
              <GroupRow
                key={group.id}
                group={group}
                busy={pendingId === group.id}
                onSchedule={onSchedule}
                onCancel={onCancel}
                onDelete={onDeleteRequest}
              />
            ))}
          </tbody>
        </table>
      </div>

      {!loading && table?.groups.length === 0 && (
        <p className="adm-empty">
          {query ? `No group matches “${query}”.` : 'No groups match this filter.'}
        </p>
      )}
      {loading && !table && <p className="adm-empty">Loading groups…</p>}

      <div className="adm-foot">
        <span className="adm-stamp">
          {total > 0
            ? `Showing ${formatNumber((page - 1) * pageSize + 1)}–${formatNumber(
                Math.min(page * pageSize, total),
              )} of ${formatNumber(total)}`
            : 'Nothing to show'}
        </span>
        <div className="adm-pager">
          <button
            type="button"
            className="adm-btn adm-btn--sm"
            disabled={page <= 1}
            onClick={() => onPageChange(1)}
          >
            First
          </button>
          <button
            type="button"
            className="adm-btn adm-btn--sm"
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            Prev
          </button>
          <span>
            Page {formatNumber(page)} of {formatNumber(pages)}
          </span>
          <button
            type="button"
            className="adm-btn adm-btn--sm"
            disabled={page >= pages}
            onClick={() => onPageChange(Math.min(pages, page + 1))}
          >
            Next
          </button>
          <button
            type="button"
            className="adm-btn adm-btn--sm"
            disabled={page >= pages}
            onClick={() => onPageChange(pages)}
          >
            Last
          </button>
        </div>
      </div>
    </section>
  );
}

function FilterButton({
  current,
  value,
  label,
  onPick,
}: {
  current: AdminGroupFilter;
  value: AdminGroupFilter;
  label: string;
  onPick: (value: AdminGroupFilter) => void;
}) {
  return (
    <button
      type="button"
      className="adm-seg"
      aria-pressed={current === value}
      onClick={() => onPick(value)}
    >
      {label}
    </button>
  );
}

function SortHeader({
  label,
  value,
  sort,
  dir,
  onSort,
  numeric,
}: {
  label: string;
  value: AdminGroupSort;
  sort: AdminGroupSort;
  dir: AdminSortDir;
  onSort: (value: AdminGroupSort) => void;
  numeric?: boolean;
}) {
  const active = sort === value;
  return (
    <th
      className={numeric ? 'adm-num' : undefined}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button type="button" className="adm-sort" onClick={() => onSort(value)}>
        {label}
        <span aria-hidden>{active ? (dir === 'asc' ? '▲' : '▼') : '·'}</span>
      </button>
    </th>
  );
}

type GroupRowProps = {
  group: AdminGroup;
  busy: boolean;
  onSchedule: (group: AdminGroup) => void;
  onCancel: (group: AdminGroup) => void;
  onDelete: (group: AdminGroup) => void;
};

const GroupRow = memo(function GroupRow({
  group,
  busy,
  onSchedule,
  onCancel,
  onDelete,
}: GroupRowProps) {
  const isPublic = group.visibility === 'public';
  return (
    <tr>
      <td>
        <span className="adm-name">
          <Link to={`/g/${encodeURIComponent(group.name)}`} target="_blank" rel="noreferrer">
            {group.name}
          </Link>
          <span className="adm-name-sub">
            {group.member_names.join(', ') || 'no members yet'}
          </span>
        </span>
      </td>
      <td>
        <span className={isPublic ? 'adm-pill adm-pill--public' : 'adm-pill'}>
          {isPublic ? 'Public' : 'Private'}
        </span>
      </td>
      <td>{group.mode === 'competitive' ? 'Competitive' : 'Normal'}</td>
      <td className="adm-num">
        {group.member_count}/{group.member_slots}
      </td>
      <td className="adm-num">{formatNumber(group.views_total)}</td>
      <td>{formatDate(group.created_at)}</td>
      <td>{formatDate(group.last_activity)}</td>
      <td>
        {group.deletion.pending ? (
          <span className="adm-pill adm-pill--pending" title={formatDateTime(group.deletion.delete_after)}>
            {formatDate(group.deletion.delete_after)}
          </span>
        ) : (
          '—'
        )}
      </td>
      <td>
        <span className="adm-row-actions">
          {group.deletion.pending ? (
            <button
              type="button"
              className="adm-btn adm-btn--sm"
              disabled={busy}
              onClick={() => onCancel(group)}
            >
              Keep
            </button>
          ) : (
            <button
              type="button"
              className="adm-btn adm-btn--sm"
              disabled={busy}
              onClick={() => onSchedule(group)}
              title={`Erase in ${DELETION_GRACE_DAYS} days, cancellable`}
            >
              Schedule
            </button>
          )}
          <button
            type="button"
            className="adm-btn adm-btn--sm adm-btn--danger"
            disabled={busy}
            onClick={() => onDelete(group)}
            title="Erases everything immediately — no grace period, no undo"
          >
            Delete
          </button>
        </span>
      </td>
    </tr>
  );
});
