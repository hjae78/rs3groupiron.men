import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  fetchLeaderboard,
  fetchPublicGroups,
  type LeaderboardEntry,
  type PublicGroup,
} from '../api/groupClient';
import { LegalFooter } from '../components/LegalFooter';
import { MarketingLayout, useFormTheme } from '../components/MarketingLayout';
import { ThemeToggle } from '../components/ThemeToggle';
import { MAX_GROUP_NAME, PAGE_SEO, SITE_NAME } from '../lib/constants';
import { errorMessage } from '../lib/errors';
import { formatNumber } from '../lib/format';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useLatestRequest } from '../hooks/useLatestRequest';
import { useUrlText } from '../hooks/useUrlState';
import '../styles/discover.css';

const BOARD_LIMIT = 8;

const groupUrl = (name: string) => `/g/${encodeURIComponent(name)}`;

const modeLabel = (mode: string) => (mode === 'competitive' ? 'Competitive' : 'Normal');

type RowData = {
  name: string;
  members: number;
  verified: number;
  mode: string;
  value: number;
  label: string;
};

function boardRow(entry: LeaderboardEntry, kind: 'views' | 'level'): RowData {
  return {
    name: entry.name,
    members: entry.member_count,
    verified: entry.verified_count,
    mode: entry.mode,
    value: kind === 'level' ? entry.total_level : entry.views,
    label: kind === 'level' ? 'TOTAL LEVEL' : 'VIEWS',
  };
}

export function BrowsePage() {
  useDocumentTitle(PAGE_SEO.browse.title, {
    canonicalPath: '/discover',
    description: PAGE_SEO.browse.description,
  });
  const navigate = useNavigate();
  const formTheme = useFormTheme();
  const [query, setQuery] = useUrlText('q');
  const searching = query.trim().length > 0;

  return (
    <MarketingLayout
      topLeft={
        <Link className="hero-back" to="/">
          ← Home
        </Link>
      }
      topRight={<ThemeToggle />}
    >
      <div className="dsc">
        <div className="dsc-title dsc-up">
          <img src="/logo-512.png" alt="" width={64} height={64} />
          <div className="dsc-title-text">
            <span className="dsc-eyebrow">{SITE_NAME.toUpperCase()}</span>
            <h1 className="dsc-h1">Discover groups</h1>
          </div>
        </div>

        <p className="dsc-lede dsc-up dsc-d1">
          Find a group by name, or browse the most viewed and highest levelled groups.
        </p>

        {}
        <div className={`dsc-themed ${formTheme}`}>
          <SearchField
            query={query}
            onQuery={setQuery}
            onSubmitFirst={(name) => navigate(groupUrl(name))}
          />

          {}
          {searching ? <Results query={query} /> : <Boards />}
        </div>

        <LegalFooter />
      </div>
    </MarketingLayout>
  );
}

type SearchFieldProps = {
  query: string;
  onQuery: (value: string) => void;
  onSubmitFirst: (name: string) => void;
};

function SearchField({ query, onQuery, onSubmitFirst }: SearchFieldProps) {
  const [best, setBest] = useState<string | null>(null);
  const request = useLatestRequest();

  useEffect(() => {
    if (!query.trim()) {
      setBest(null);
      return;
    }
    let live = true;
    void (async () => {
      const settled = await request((signal) => fetchPublicGroups(query, { signal }));
      if (!settled || !live) return;
      setBest(settled.ok ? (rankMatches(settled.value.groups, query)[0]?.name ?? null) : null);
    })();
    return () => {
      live = false;
    };
  }, [query, request]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (best) onSubmitFirst(best);
  }

  return (
    <form className="dsc-search dsc-up dsc-d2" role="search" onSubmit={onSubmit}>
      <span className="dsc-search-icon" aria-hidden />
      <input
        type="search"
        value={query}
        maxLength={MAX_GROUP_NAME}
        placeholder="Search a group name"
        aria-label="Search a group name"
        spellCheck={false}
        autoComplete="off"
        autoFocus
        onChange={(e) => onQuery(e.target.value)}
      />
      <button type="submit" disabled={!best}>
        View
      </button>
    </form>
  );
}

function rankMatches(groups: PublicGroup[], query: string): PublicGroup[] {
  const q = query.trim().toLowerCase();
  return [...groups].sort(
    (a, b) =>
      Number(b.name.toLowerCase() === q) - Number(a.name.toLowerCase() === q) ||
      b.views - a.views,
  );
}

function Results({ query }: { query: string }) {
  const [groups, setGroups] = useState<PublicGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useLatestRequest();

  useEffect(() => {
    let live = true;
    void (async () => {
      const settled = await request((signal) => fetchPublicGroups(query, { signal }));
      if (!settled || !live) return;
      if (settled.ok) {
        setGroups(rankMatches(settled.value.groups, query));
        setError(null);
      } else {
        setError(errorMessage(settled.error, 'Could not search groups'));
      }
    })();
    return () => {
      live = false;
    };
  }, [query, request]);

  const found = groups?.length ?? 0;

  return (
    <section className="dsc-panel dsc-results" aria-live="polite">
      <h2>
        {error
          ? 'Search failed'
          : groups === null
            ? 'Searching…'
            : found
              ? `${found} ${found === 1 ? 'group' : 'groups'} found`
              : 'No results'}
      </h2>

      {error && <p className="dsc-empty-body">{error}</p>}

      {!error && !!groups?.length && (
        <ul className="dsc-list">
          {groups.slice(0, BOARD_LIMIT).map((group) => (
            <Row
              key={group.name}
              data={{
                name: group.name,
                members: group.member_count,
                verified: group.verified_count,
                mode: group.mode,
                value: group.views,
                label: 'VIEWS',
              }}
            />
          ))}
        </ul>
      )}

      {!error && groups?.length === 0 && (
        <div className="dsc-empty">
          <span className="dsc-empty-title">No group called “{query.trim()}”</span>
          <span className="dsc-empty-body">
            Check the spelling, or the group may be private or not on the hiscores yet.
          </span>
          <Link className="dsc-ghost-btn" to="/get-started">
            Create a group
          </Link>
        </div>
      )}
    </section>
  );
}

function Boards() {
  const [views, setViews] = useState<LeaderboardEntry[] | null>(null);
  const [levels, setLevels] = useState<LeaderboardEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const [byViews, byLevel] = await Promise.all([
          fetchLeaderboard('views', { period: 'all', limit: BOARD_LIMIT, signal: ac.signal }),
          fetchLeaderboard('total_level', { limit: BOARD_LIMIT, signal: ac.signal }),
        ]);
        setViews(byViews.entries);
        setLevels(byLevel.entries);
        setError(null);
      } catch (err) {
        if (ac.signal.aborted) return;
        setError(errorMessage(err, 'Could not load the leaderboards'));
      }
    })();
    return () => ac.abort();
  }, []);

  return (
    <div className="dsc-boards dsc-up dsc-d3">
      <Board
        title="Most viewed"
        entries={views}
        kind="views"
        error={error}
        emptyBody="No groups have been viewed yet. Once groups go public, the most visited show up here."
      />
      <Board
        title="Highest total level"
        entries={levels}
        kind="level"
        error={error}
        emptyBody="No groups on the hiscores yet. Groups appear here once their members sync their stats."
      />
    </div>
  );
}

type BoardProps = {
  title: string;
  entries: LeaderboardEntry[] | null;
  kind: 'views' | 'level';
  error: string | null;
  emptyBody: string;
};

function Board({ title, entries, kind, error, emptyBody }: BoardProps) {
  return (
    <section className="dsc-panel">
      <h2>{title}</h2>

      {error && <p className="dsc-empty-body">{error}</p>}

      {!error && !!entries?.length && (
        <ul className="dsc-list">
          {entries.map((entry) => (
            <Row key={entry.name} rank={entry.rank} data={boardRow(entry, kind)} />
          ))}
        </ul>
      )}

      {!error && entries?.length === 0 && (
        <div className="dsc-empty">
          <img src="/logo-512.png" alt="" width={48} height={48} />
          <span className="dsc-empty-title">No groups yet</span>
          <span className="dsc-empty-body">{emptyBody}</span>
        </div>
      )}
    </section>
  );
}

function Row({ rank, data }: { rank?: number; data: RowData }) {
  const rankClass = rank && rank <= 3 ? `dsc-rank dsc-rank--${rank}` : 'dsc-rank';
  return (
    <li>
      <Link className="dsc-row" to={groupUrl(data.name)} title={`View ${data.name}`}>
        <span className={rankClass}>{rank ?? ''}</span>
        <span className="dsc-row-main">
          <span className="dsc-row-name">{data.name}</span>
          <span className="dsc-row-sub">
            {data.members} {data.members === 1 ? 'member' : 'members'} · {modeLabel(data.mode)}
            {data.members > 0 &&
              ` · ${data.verified}/${data.members} verified${
                data.verified === data.members ? ' — Fully Verified' : ''
              }`}
          </span>
        </span>
        <span className="dsc-row-stat">
          <span className="dsc-row-value">{formatNumber(data.value)}</span>
          <span className="dsc-row-label">{data.label}</span>
        </span>
      </Link>
    </li>
  );
}
