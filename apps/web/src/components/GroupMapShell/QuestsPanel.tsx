import { memo, useEffect, useMemo, useState } from 'react';
import { useMemberColor } from '../../hooks/useMemberColor';
import { useUrlState, useUrlText } from '../../hooks/useUrlState';
import {
  MAX_QUEST_POINTS,
  QUEST_CATEGORIES,
  QUEST_CATEGORY_LABEL,
  countQuests,
  questPointsFor,
  questWikiUrl,
  questsInCategory,
  type MemberQuestStates,
  type QuestCategory,
  type QuestDef,
  type QuestState,
} from '../../lib/quests';
import type { MemberBadge } from './memberOptions';
import { LoadMoreButton, PanelStatus } from './PanelChrome';
import { Segmented } from './Segmented';
import { WikiIcon } from './icons';

/** Rows rendered at once; the full quest list stays off the DOM until asked for. */
const PAGE_SIZE = 150;

type Progress = 'all' | 'finished' | 'started' | 'not_started';

const PROGRESS: Array<{ key: Progress; label: string; groupHint: string }> = [
  { key: 'all', label: 'All', groupHint: 'Every quest in this list' },
  { key: 'finished', label: 'Finished', groupHint: 'Finished by every member' },
  { key: 'started', label: 'In progress', groupHint: 'At least one member has started it' },
  { key: 'not_started', label: 'Not started', groupHint: 'Nobody has started it yet' },
];

const PROGRESS_VALUES: Progress[] = PROGRESS.map((p) => p.key);
const CATEGORY_VALUES: Array<QuestCategory | 'all'> = ['all', ...QUEST_CATEGORIES];

function stateOf(states: MemberQuestStates | undefined, quest: QuestDef): QuestState | null {
  return states?.[quest.gameval] ?? null;
}

/**
 */
function groupProgress(
  quest: QuestDef,
  names: string[],
  byMember: Record<string, MemberQuestStates>,
): Exclude<Progress, 'all'> {
  if (!names.length) return 'not_started';
  let finished = 0;
  let touched = 0;
  for (const name of names) {
    const state = stateOf(byMember[name], quest);
    if (state) touched += 1;
    if (state === 'finished') finished += 1;
  }
  if (finished === names.length) return 'finished';
  if (touched > 0) return 'started';
  return 'not_started';
}

type QuestsPanelProps = {
  memberNames: string[];
  members?: ReadonlyArray<MemberBadge>;
  byMember: Record<string, MemberQuestStates>;
  loading?: boolean;
  error?: string | null;
};

export function QuestsPanel({
  memberNames,
  members = [],
  byMember,
  loading = false,
  error = null,
}: QuestsPanelProps) {
  const [query, setQuery] = useUrlText('q');
  const [memberFilter] = useUrlState('member', 'all');
  const [progress, setProgress] = useUrlState<Progress>('progress', 'all', {
    allowed: PROGRESS_VALUES,
  });
  const [category] = useUrlState<QuestCategory | 'all'>('category', 'quest', {
    allowed: CATEGORY_VALUES,
  });

  const columns = useMemo(
    () =>
      memberFilter === 'all' ? memberNames : memberNames.filter((n) => n === memberFilter),
    [memberNames, memberFilter],
  );

  const colorOf = useMemberColor(members);

  const pool = useMemo(() => questsInCategory(category), [category]);
  const poolPoints = useMemo(() => pool.reduce((sum, q) => sum + q.questPoints, 0), [pool]);

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? pool.filter((quest) => quest.name.toLowerCase().includes(q)) : pool;
  }, [pool, query]);

  const progressCounts = useMemo(() => {
    const counts: Record<Progress, number> = {
      all: searched.length,
      finished: 0,
      started: 0,
      not_started: 0,
    };
    for (const quest of searched) counts[groupProgress(quest, columns, byMember)] += 1;
    return counts;
  }, [searched, columns, byMember]);

  const rows = useMemo(
    () =>
      progress === 'all'
        ? searched
        : searched.filter((quest) => groupProgress(quest, columns, byMember) === progress),
    [searched, progress, columns, byMember],
  );

  const stats = useMemo(
    () =>
      Object.fromEntries(
        columns.map((name) => {
          const states = byMember[name];
          return [name, { points: questPointsFor(states), ...countQuests(states, pool) }];
        }),
      ),
    [columns, byMember, pool],
  );

  const singleMember = columns.length === 1;
  const typeLabel =
    category === 'all' ? 'entries' : QUEST_CATEGORY_LABEL[category].toLowerCase();

  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query, progress, category, memberFilter]);
  const visible = useMemo(() => rows.slice(0, visibleCount), [rows, visibleCount]);

  return (
    <section className="gms-quests gms-panel" aria-label="Group quests" aria-busy={loading}>
      <header className="gms-quests-head">
        <div className="gms-quests-heading">
          <h1 className="gms-page-title">Quests</h1>
          <span className="gms-panel-sub">
            {pool.length} {typeLabel}
            {poolPoints > 0 ? ` · ${poolPoints} quest points` : ''}
          </span>
        </div>
        <input
          className="gms-input gms-quests-search"
          value={query}
          placeholder="Search quests"
          aria-label="Search quests"
          onChange={(e) => setQuery(e.target.value)}
        />
      </header>

      <div className="gms-quests-filters">
        <Segmented
          ariaLabel="Filter by progress"
          value={progress}
          options={PROGRESS.map(({ key, label, groupHint }) => ({
            id: key,
            label,
            count: progressCounts[key],
            title: singleMember ? undefined : groupHint,
          }))}
          onChange={setProgress}
        />
        <ul className="gms-quests-legend" aria-hidden>
          <li>
            <Mark state="finished" /> Finished
          </li>
          <li>
            <Mark state="started" /> In progress
          </li>
          <li>
            <Mark state={null} /> Not started
          </li>
        </ul>
      </div>

      <div className="gms-panel-body gms-quests-body">
        <PanelStatus
          error={error}
          loading={loading && memberNames.length === 0}
          empty={!loading && rows.length === 0}
          emptyText="No quests match."
        />
        {rows.length > 0 && (
          <table className="gms-quests-table">
            <thead>
              <tr>
                <th scope="col" className="gms-quests-th">
                  Quest
                </th>
                <th scope="col" className="gms-quests-th gms-quests-th--qp" title="Quest points">
                  QP
                </th>
                {columns.map((name) => {
                  const s = stats[name]!;
                  return (
                    <th key={name} scope="col" className="gms-quests-th gms-quests-th--member">
                      <span className="gms-quests-th-name" title={name}>
                        <span
                          className="gms-dot"
                          style={{ background: colorOf(name) }}
                          aria-hidden
                        />
                        {name}
                      </span>
                      <span
                        className="gms-quests-th-stat"
                        title={`${s.points} of ${MAX_QUEST_POINTS} quest points · ${s.finished} of ${s.total} ${typeLabel} finished · ${s.started} in progress`}
                      >
                        <strong>{s.points}</strong> QP · {s.finished}/{s.total}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visible.map((quest) => (
                <QuestRow
                  key={quest.gameval}
                  quest={quest}
                  columns={columns}
                  byMember={byMember}
                  showCategoryTag={category === 'all'}
                />
              ))}
            </tbody>
          </table>
        )}

        {rows.length > visibleCount && (
          <LoadMoreButton
            loading={false}
            onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
          />
        )}
      </div>
    </section>
  );
}

const STATE_LABEL: Record<string, string> = {
  finished: 'Finished',
  started: 'In progress',
  not_started: 'Not started',
};

const QuestRow = memo(function QuestRow({
  quest,
  columns,
  byMember,
  showCategoryTag,
}: {
  quest: QuestDef;
  columns: string[];
  byMember: Record<string, MemberQuestStates>;
  showCategoryTag: boolean;
}) {
  const rowState = groupProgress(quest, columns, byMember);

  return (
    <tr className={`gms-quests-row gms-quests-row--${rowState}`}>
      <th scope="row" className="gms-quests-name">
        <a
          className="gms-quests-name-text"
          href={questWikiUrl(quest)}
          target="_blank"
          rel="noopener noreferrer"
          title={`${quest.name} on the RuneScape Wiki`}
        >
          {quest.name}
          <WikiIcon />
        </a>
        {showCategoryTag && quest.category !== 'quest' && (
          <span className="gms-quests-tag">{quest.category}</span>
        )}
        {quest.parentName && <span className="gms-quests-parent">{quest.parentName}</span>}
      </th>
      <td className="gms-quests-qp">{quest.questPoints || ''}</td>
      {columns.map((name) => {
        const state = stateOf(byMember[name], quest);
        const label = STATE_LABEL[state ?? 'not_started']!;
        return (
          <td
            key={name}
            className={`gms-quests-cell gms-quests-cell--${state ?? 'not_started'}`}
            data-member={name}
            title={`${name} · ${quest.name} · ${label}`}
          >
            <Mark state={state} label={label} />
          </td>
        );
      })}
    </tr>
  );
});

/** Completion glyph: filled check, half-filled circle, or an empty ring. */
function Mark({ state, label }: { state: QuestState | null; label?: string }) {
  const common = {
    className: `gms-quests-mark gms-quests-mark--${state ?? 'not_started'}`,
    viewBox: '0 0 16 16',
    width: 16,
    height: 16,
    'aria-label': label,
    role: label ? 'img' : undefined,
    'aria-hidden': label ? undefined : true,
    focusable: 'false' as const,
  };
  if (state === 'finished') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path
          d="M4.6 8.3l2.3 2.3 4.6-4.8"
          fill="none"
          stroke="#0e1a12"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (state === 'started') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 1.6A6.4 6.4 0 0 1 8 14.4z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
