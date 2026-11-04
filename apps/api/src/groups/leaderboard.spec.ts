import {
  DEFAULT_LEADERBOARD_LIMIT,
  leaderboardQuery,
  parseLeaderboardLimit,
  parseLeaderboardMetric,
  parseLeaderboardPeriod,
  periodStart,
  startOfUtcDay,
  toLeaderboardEntries,
  type LeaderboardRow,
} from './leaderboard';

function row(over: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    name: 'Open Group',
    mode: 'normal',
    member_count: 3n,
    verified_count: 1n,
    views_total: 120,
    recent_views: 40n,
    total_level: 4200n,
    created_at: new Date('2026-02-01T00:00:00.000Z'),
    ...over,
  };
}

describe('leaderboard input parsing', () => {
  it('opens on the view board, which is the popular one', () => {
    expect(parseLeaderboardMetric(undefined)).toBe('views');
    expect(parseLeaderboardMetric('nonsense')).toBe('views');
  });

  it('accepts the level board', () => {
    expect(parseLeaderboardMetric('total_level')).toBe('total_level');
  });

  it('clamps rather than rejects a silly limit', () => {
    expect(parseLeaderboardLimit(undefined)).toBe(DEFAULT_LEADERBOARD_LIMIT);
    expect(parseLeaderboardLimit('0')).toBe(DEFAULT_LEADERBOARD_LIMIT);
    expect(parseLeaderboardLimit('abc')).toBe(DEFAULT_LEADERBOARD_LIMIT);
    expect(parseLeaderboardLimit('5')).toBe(5);
    expect(parseLeaderboardLimit('9999')).toBe(50);
  });

  it('falls back to the default window', () => {
    expect(parseLeaderboardPeriod(undefined)).toBe('30d');
    expect(parseLeaderboardPeriod('7d')).toBe('7d');
    expect(parseLeaderboardPeriod('all')).toBe('all');
  });
});

describe('view windows', () => {
  it('buckets to midnight UTC', () => {
    expect(startOfUtcDay(new Date('2026-03-04T23:59:59.000Z')).toISOString()).toBe(
      '2026-03-04T00:00:00.000Z',
    );
  });

  it('counts today as the last day of the window', () => {
    const now = new Date('2026-03-10T12:00:00.000Z');
    expect(periodStart('7d', now)?.toISOString()).toBe('2026-03-04T00:00:00.000Z');
  });

  it('has no lower bound for all time', () => {
    expect(periodStart('all')).toBeNull();
  });
});

describe('leaderboardQuery', () => {
  const since = new Date('2026-03-01T00:00:00.000Z');

  it('only ever considers public groups, on every board and window', () => {
    for (const metric of ['views', 'total_level'] as const) {
      for (const window of [since, null]) {
        expect(leaderboardQuery(metric, window, 10).sql).toContain(
          '"visibility" = \'public\'',
        );
      }
    }
  });

  it('never matches a private group by spelling the enum another way', () => {
    expect(leaderboardQuery('views', since, 10).sql).toContain(
      '\'public\'::"GroupVisibility"',
    );
  });

  it('skips groups hiding their skills on the level board', () => {
    expect(leaderboardQuery('total_level', since, 10).sql).toContain('"public_skills" = true');
  });

  it('does not apply that filter to the view board, which reads no member data', () => {
    expect(leaderboardQuery('views', since, 10).sql).not.toContain('"public_skills"');
  });

  it('ranks each board on its own column', () => {
    expect(leaderboardQuery('views', since, 10).sql).toContain('"recent_views" DESC');
    expect(leaderboardQuery('total_level', since, 10).sql).toContain('"total_level" DESC');
  });

  it('leaves out groups with nothing on the board it ranks', () => {
    expect(leaderboardQuery('views', since, 10).sql).toContain('"recent_views" > 0');
    expect(leaderboardQuery('total_level', since, 10).sql).toContain('"total_level" > 0');
  });

  it('gates each board on its own metric only', () => {
    expect(leaderboardQuery('views', since, 10).sql).not.toContain('"total_level" > 0');
    expect(leaderboardQuery('total_level', since, 10).sql).not.toContain(
      '"recent_views" > 0',
    );
  });

  it('gates the all-time window too, where views come from the stored total', () => {
    expect(leaderboardQuery('views', null, 10).sql).toContain('"recent_views" > 0');
  });

  it('breaks ties on the older group', () => {
    for (const metric of ['views', 'total_level'] as const) {
      expect(leaderboardQuery(metric, since, 10).sql).toContain('"created_at" ASC');
    }
  });

  it('leaves the shared pseudo-member out of the counts', () => {
    expect(leaderboardQuery('total_level', since, 10).values).toContain('@SHARED');
  });

  it('computes verified_count by joining members to players, gated on plugin_verified', () => {
    const sql = leaderboardQuery('views', since, 10).sql;
    expect(sql).toContain('"verified_count"');
    expect(sql).toContain('JOIN "players" p ON p."id" = m3."player_id"');
    expect(sql).toContain('\'plugin_verified\'::"PlayerVerificationStatus"');
  });

  it('reads the stored total when the window is all time', () => {
    const sql = leaderboardQuery('views', null, 10).sql;
    expect(sql).toContain('"views_total" AS "recent_views"');
    expect(sql).not.toContain('"group_view_days"');
  });

  it('passes the window and limit as parameters, not interpolation', () => {
    const query = leaderboardQuery('views', since, 7);
    expect(query.values).toContain(since);
    expect(query.values).toContain(7);
  });
});

describe('toLeaderboardEntries', () => {
  it('numbers the rows from one, in the order given', () => {
    const entries = toLeaderboardEntries([
      row({ name: 'First' }),
      row({ name: 'Second' }),
    ]);
    expect(entries.map((e) => [e.rank, e.name])).toEqual([
      [1, 'First'],
      [2, 'Second'],
    ]);
  });

  it('converts the aggregate bigints to numbers', () => {
    const [entry] = toLeaderboardEntries([row()]);
    expect(entry.recent_views).toBe(40);
    expect(entry.total_level).toBe(4200);
    expect(entry.member_count).toBe(3);
    expect(entry.verified_count).toBe(1);
    expect(() => JSON.stringify(entry)).not.toThrow();
  });

  it('keeps the all-time total alongside the windowed one', () => {
    const [entry] = toLeaderboardEntries([row({ recent_views: 40n, views_total: 120 })]);
    expect(entry.recent_views).toBe(40);
    expect(entry.views).toBe(120);
  });
});
