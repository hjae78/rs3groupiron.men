import { Prisma } from '@prisma/client';
import { SHARED_MEMBER } from './group.types';

export const LEADERBOARD_METRICS = ['views', 'total_level'] as const;
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];

export const LEADERBOARD_PERIODS = ['7d', '30d', 'all'] as const;
export type LeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];

const PERIOD_DAYS: Record<Exclude<LeaderboardPeriod, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
};

export const DEFAULT_LEADERBOARD_LIMIT = 10;
const MAX_LEADERBOARD_LIMIT = 50;

export const DEFAULT_LEADERBOARD_PERIOD: LeaderboardPeriod = '30d';

export const DEFAULT_LEADERBOARD_METRIC: LeaderboardMetric = 'views';

export function parseLeaderboardMetric(raw?: string): LeaderboardMetric {
  return (LEADERBOARD_METRICS as readonly string[]).includes(raw ?? '')
    ? (raw as LeaderboardMetric)
    : DEFAULT_LEADERBOARD_METRIC;
}

export function parseLeaderboardPeriod(raw?: string): LeaderboardPeriod {
  return (LEADERBOARD_PERIODS as readonly string[]).includes(raw ?? '')
    ? (raw as LeaderboardPeriod)
    : DEFAULT_LEADERBOARD_PERIOD;
}

export function parseLeaderboardLimit(raw?: string): number {
  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_LEADERBOARD_LIMIT;
  return Math.min(Math.floor(limit), MAX_LEADERBOARD_LIMIT);
}

export function startOfUtcDay(at: Date): Date {
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
}

export function periodStart(
  period: LeaderboardPeriod,
  now: Date = new Date(),
): Date | null {
  if (period === 'all') return null;
  const start = startOfUtcDay(now);
  start.setUTCDate(start.getUTCDate() - (PERIOD_DAYS[period] - 1));
  return start;
}

export type LeaderboardRow = {
  name: string;
  mode: string;
  member_count: bigint | number;
  verified_count: bigint | number;
  views_total: number;
  recent_views: bigint | number;
  total_level: bigint | number;
  created_at: Date;
};

export type LeaderboardEntry = {
  rank: number;
  name: string;
  mode: string;
  member_count: number;
  verified_count: number;
  views: number;
  recent_views: number;
  total_level: number;
  created_at: string;
};

export function toLeaderboardEntries(
  rows: LeaderboardRow[],
): LeaderboardEntry[] {
  return rows.map((row, index) => ({
    rank: index + 1,
    name: row.name,
    mode: row.mode,
    member_count: Number(row.member_count),
    verified_count: Number(row.verified_count),
    views: row.views_total,
    recent_views: Number(row.recent_views),
    total_level: Number(row.total_level),
    created_at: row.created_at.toISOString(),
  }));
}

export function leaderboardQuery(
  metric: LeaderboardMetric,
  since: Date | null,
  limit: number,
): Prisma.Sql {
  const recentViews = since
    ? Prisma.sql`
        COALESCE((
          SELECT SUM(v."views")
          FROM "group_view_days" v
          WHERE v."group_id" = g."id" AND v."day" >= ${since}
        ), 0)`
    : Prisma.sql`g."views_total"`;

  const totalLevel = Prisma.sql`
    COALESCE((
      SELECT SUM(ms."base_level")
      FROM "members" m
      JOIN "member_skills" ms ON ms."member_id" = m."id"
      WHERE m."group_id" = g."id" AND m."name" <> ${SHARED_MEMBER}
    ), 0)`;

  const order =
    metric === 'views'
      ? Prisma.sql`t."recent_views" DESC, t."views_total" DESC, t."created_at" ASC`
      : Prisma.sql`t."total_level" DESC, t."created_at" ASC`;

  const visible =
    metric === 'total_level'
      ? Prisma.sql`AND g."public_skills" = true`
      : Prisma.empty;

  const scored =
    metric === 'views'
      ? Prisma.sql`t."recent_views" > 0`
      : Prisma.sql`t."total_level" > 0`;

  return Prisma.sql`
    SELECT * FROM (
      SELECT
        g."name",
        g."mode"::text AS "mode",
        g."views_total",
        g."created_at",
        ${recentViews} AS "recent_views",
        ${totalLevel} AS "total_level",
        (
          SELECT COUNT(*)
          FROM "members" m2
          WHERE m2."group_id" = g."id" AND m2."name" <> ${SHARED_MEMBER}
        ) AS "member_count",
        (
          SELECT COUNT(*)
          FROM "members" m3
          JOIN "players" p ON p."id" = m3."player_id"
          WHERE m3."group_id" = g."id"
            AND p."verification_status" = 'plugin_verified'::"PlayerVerificationStatus"
        ) AS "verified_count"
      FROM "groups" g
      WHERE g."visibility" = 'public'::"GroupVisibility" ${visible}
    ) t
    WHERE ${scored}
    ORDER BY ${order}
    LIMIT ${limit}
  `;
}
