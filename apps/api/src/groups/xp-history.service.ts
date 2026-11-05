import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { deterministicHash } from '../common/hash';
import { SKILL_BY_ID, SKILLS, type SkillId } from '../skills/skills.catalog';
import { PrismaService } from '../prisma/prisma.service';
import { SHARED_MEMBER } from './group.types';

export type XpHistoryPeriod = '24h' | '7d' | '30d' | '365d';

/** Either the root client or an interactive-transaction client. */
export type DbClient = Prisma.TransactionClient | PrismaService;

const PERIOD_MS: Record<XpHistoryPeriod, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '365d': 365 * 24 * 60 * 60 * 1000,
};

/** Skip identical XP samples within this window. */
const DEDUPE_MS = 15 * 60 * 1000;

const SAMPLE_COUNT = 52;

export type SamplePoint = { t: number; xp: number };
type SampleRow = {
  memberId: string;
  skillId: string;
  xp: bigint;
  sampledAt: Date;
};

function pairKey(memberId: string, skillId: string) {
  return `${memberId}:${skillId}`;
}

@Injectable()
export class XpHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async recordXpSamples(
    memberId: string,
    skills: Array<{ skillId: string; xp: bigint | number }>,
    sampledAt = new Date(),
    db: DbClient = this.prisma,
  ) {
    if (!skills.length) return;

    const since = new Date(sampledAt.getTime() - DEDUPE_MS);
    const recent = await db.skillXpSample.findMany({
      where: {
        memberId,
        skillId: { in: skills.map((s) => s.skillId) },
        sampledAt: { gte: since },
      },
      orderBy: { sampledAt: 'desc' },
      select: { skillId: true, xp: true },
    });

    const latestBySkill = new Map<string, bigint>();
    for (const row of recent) {
      if (!latestBySkill.has(row.skillId)) {
        latestBySkill.set(row.skillId, row.xp);
      }
    }

    const toInsert: SampleRow[] = [];

    for (const skill of skills) {
      const xp = BigInt(skill.xp);
      const prev = latestBySkill.get(skill.skillId);
      if (prev !== undefined && prev === xp) continue;
      toInsert.push({
        memberId,
        skillId: skill.skillId,
        xp,
        sampledAt,
      });
    }

    if (toInsert.length) {
      await db.skillXpSample.createMany({ data: toInsert });
    }
  }

  /** Build uneven growth timeline ending at current XP (~1 year). */
  buildSyntheticSamples(
    memberId: string,
    skills: Array<{ skillId: string; xp: bigint | number }>,
    endAt = new Date(),
  ): SampleRow[] {
    return buildSyntheticXpSamples(memberId, skills, endAt);
  }

  async seedHistoryForMember(
    memberId: string,
    skills: Array<{ skillId: string; xp: bigint | number }>,
    endAt = new Date(),
    db: DbClient = this.prisma,
  ) {
    const rows = this.buildSyntheticSamples(memberId, skills, endAt);
    if (rows.length) {
      await db.skillXpSample.createMany({ data: rows });
    }
  }

  async getXpHistory(
    groupName: string,
    token: string | undefined,
    authenticate: (
      groupName: string,
      token: string | undefined,
    ) => Promise<{
      id: string;
      members: Array<{ id: string; name: string }>;
    }>,
    periodRaw?: string,
    skillRaw?: string,
  ) {
    const group = await authenticate(groupName, token);
    const period = parsePeriod(periodRaw);
    const skillFilter = parseSkillFilter(skillRaw);
    const to = new Date();
    const from = new Date(to.getTime() - PERIOD_MS[period]);
    const bucketMs = bucketSizeMs(period);

    const members = group.members.filter((m) => m.name !== SHARED_MEMBER);
    const memberIds = members.map((m) => m.id);
    const skillIds: string[] =
      skillFilter === 'overall' ? SKILLS.map((s) => s.id) : [skillFilter];

    const [baselines, samples] = memberIds.length
      ? await Promise.all([
          this.loadBaselines(memberIds, skillIds, from),
          this.loadSamples(memberIds, skillIds, from, to, period, bucketMs),
        ])
      : ([new Map<string, bigint>(), []] as [Map<string, bigint>, SampleRow[]]);

    // memberId -> skillId -> ascending points (baseline first)
    const byMember = new Map<string, Map<string, SamplePoint[]>>();
    for (const member of members) {
      const bySkill = new Map<string, SamplePoint[]>();
      for (const id of skillIds) {
        const baseXp = Number(baselines.get(pairKey(member.id, id)) ?? 0n);
        bySkill.set(id, [{ t: from.getTime(), xp: baseXp }]);
      }
      byMember.set(member.id, bySkill);
    }
    for (const sample of samples) {
      const list = byMember.get(sample.memberId)?.get(sample.skillId);
      if (!list) continue;
      list.push({ t: sample.sampledAt.getTime(), xp: Number(sample.xp) });
    }

    const series: Array<{
      name: string;
      points: Array<{ t: string; gain: number }>;
    }> = [];
    const players: Array<{
      name: string;
      totalGain: number;
      skills: Array<{ id: string; name: string; gain: number }>;
    }> = [];

    for (const member of members) {
      const bySkill = byMember.get(member.id)!;

      const skillGains: Array<{ id: string; name: string; gain: number }> = [];
      for (const id of skillIds) {
        const points = bySkill.get(id) ?? [];
        const startXp = points[0]?.xp ?? 0;
        const endXp = points[points.length - 1]?.xp ?? startXp;
        const gain = Math.max(0, endXp - startXp);
        const def = SKILL_BY_ID[id as SkillId];
        skillGains.push({
          id,
          name: def?.name ?? id,
          gain,
        });
      }
      skillGains.sort((a, b) => b.gain - a.gain);

      const totalGain =
        skillFilter === 'overall'
          ? skillGains.reduce((sum, s) => sum + s.gain, 0)
          : (skillGains[0]?.gain ?? 0);

      players.push({
        name: member.name,
        totalGain,
        skills:
          skillFilter === 'overall'
            ? skillGains.filter((s) => s.gain > 0)
            : skillGains,
      });

      const points = bucketSeries(bySkill, skillIds, from, to, bucketMs);
      series.push({ name: member.name, points });
    }

    players.sort((a, b) => b.totalGain - a.totalGain);

    return {
      period,
      skill: skillFilter,
      from: from.toISOString(),
      to: to.toISOString(),
      series,
      players,
    };
  }

  /**
   * In-window samples for all members at once. For long periods the rows are
   * downsampled in SQL to one row per (member, skill, bucket) so the amount of
   * data pulled stays bounded regardless of sampling frequency.
   */
  private async loadSamples(
    memberIds: string[],
    skillIds: string[],
    from: Date,
    to: Date,
    period: XpHistoryPeriod,
    bucketMs: number,
  ): Promise<SampleRow[]> {
    if (PERIOD_MS[period] <= PERIOD_MS['7d']) {
      return this.prisma.skillXpSample.findMany({
        where: {
          memberId: { in: memberIds },
          skillId: { in: skillIds },
          sampledAt: { gte: from, lte: to },
        },
        orderBy: { sampledAt: 'asc' },
        select: { memberId: true, skillId: true, xp: true, sampledAt: true },
      });
    }

    const bucketSeconds = Math.max(1, Math.floor(bucketMs / 1000));
    // XP is monotonic, so MAX(xp) is the value at the last sample in the
    // bucket; report it at that sample's timestamp so JS bucketing lines up.
    return this.prisma.$queryRaw<SampleRow[]>`
      SELECT
        "member_id" AS "memberId",
        "skill_id" AS "skillId",
        MAX("xp") AS "xp",
        MAX("sampled_at") AS "sampledAt"
      FROM "skill_xp_samples"
      WHERE "member_id" = ANY(${memberIds}::text[])
        AND "skill_id" = ANY(${skillIds}::text[])
        AND "sampled_at" >= (${from}::timestamptz AT TIME ZONE 'UTC')
        AND "sampled_at" <= (${to}::timestamptz AT TIME ZONE 'UTC')
      GROUP BY
        "member_id",
        "skill_id",
        date_bin(
          make_interval(secs => ${bucketSeconds}),
          "sampled_at",
          (${from}::timestamptz AT TIME ZONE 'UTC')
        )
      ORDER BY "sampledAt" ASC
    `;
  }

  /**
   * Latest sample at or before `from` for every (member, skill) pair in one
   * query; falls back to the current member_skills row when no history exists.
   */
  private async loadBaselines(
    memberIds: string[],
    skillIds: string[],
    from: Date,
  ) {
    const baselines = new Map<string, bigint>();

    const rows = await this.prisma.$queryRaw<
      Array<{ memberId: string; skillId: string; xp: bigint }>
    >`
      SELECT DISTINCT ON ("member_id", "skill_id")
        "member_id" AS "memberId",
        "skill_id" AS "skillId",
        "xp"
      FROM "skill_xp_samples"
      WHERE "member_id" = ANY(${memberIds}::text[])
        AND "skill_id" = ANY(${skillIds}::text[])
        AND "sampled_at" <= (${from}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "member_id", "skill_id", "sampled_at" DESC
    `;
    for (const row of rows) {
      baselines.set(pairKey(row.memberId, row.skillId), BigInt(row.xp));
    }

    // Nothing before the window means tracking started inside it, so the
    // earliest sample we do have is the baseline (otherwise every gain would
    // clamp to zero). Still nothing at all means the member has no visible
    // history, so their current XP is the baseline. Neither fallback depends
    // on the other's result, so when the first query didn't cover every
    // pair, both run together instead of one after the other.
    if (memberIds.length * skillIds.length - baselines.size > 0) {
      const [inWindow, current] = await Promise.all([
        this.prisma.$queryRaw<
          Array<{ memberId: string; skillId: string; xp: bigint }>
        >`
          SELECT DISTINCT ON ("member_id", "skill_id")
            "member_id" AS "memberId",
            "skill_id" AS "skillId",
            "xp"
          FROM "skill_xp_samples"
          WHERE "member_id" = ANY(${memberIds}::text[])
            AND "skill_id" = ANY(${skillIds}::text[])
            AND "sampled_at" > (${from}::timestamptz AT TIME ZONE 'UTC')
          ORDER BY "member_id", "skill_id", "sampled_at" ASC
        `,
        this.prisma.memberSkill.findMany({
          where: {
            memberId: { in: memberIds },
            skillId: { in: skillIds },
          },
          select: { memberId: true, skillId: true, xp: true },
        }),
      ]);

      // Applied in priority order: a sample just inside the window beats the
      // member's current (possibly since-changed) skill row.
      for (const row of inWindow) {
        const key = pairKey(row.memberId, row.skillId);
        if (!baselines.has(key)) baselines.set(key, BigInt(row.xp));
      }
      for (const row of current) {
        const key = pairKey(row.memberId, row.skillId);
        if (!baselines.has(key)) baselines.set(key, row.xp);
      }
    }

    return baselines;
  }
}

function parsePeriod(raw?: string): XpHistoryPeriod {
  if (raw === '24h' || raw === '7d' || raw === '30d' || raw === '365d') {
    return raw;
  }
  if (!raw) return '24h';
  throw new BadRequestException('Invalid period (use 24h|7d|30d|365d)');
}

function parseSkillFilter(raw?: string): 'overall' | SkillId {
  if (!raw || raw === 'overall') return 'overall';
  if (SKILL_BY_ID[raw as SkillId]) return raw as SkillId;
  throw new BadRequestException('Invalid skill id');
}

export function bucketSizeMs(period: XpHistoryPeriod): number {
  switch (period) {
    case '24h':
      return 60 * 60 * 1000;
    case '7d':
      return 6 * 60 * 60 * 1000;
    case '30d':
      return 24 * 60 * 60 * 1000;
    case '365d':
      return 7 * 24 * 60 * 60 * 1000;
  }
}

export function bucketSeries(
  bySkill: Map<string, SamplePoint[]>,
  skillIds: string[],
  from: Date,
  to: Date,
  bucketMs: number,
): Array<{ t: string; gain: number }> {
  const baselines = new Map<string, number>();
  for (const id of skillIds) {
    baselines.set(id, bySkill.get(id)?.[0]?.xp ?? 0);
  }

  const gainAt = (time: number) => {
    let totalGain = 0;
    for (const id of skillIds) {
      const series = bySkill.get(id) ?? [];
      const xp = xpAtOrBefore(series, time);
      const base = baselines.get(id) ?? 0;
      totalGain += Math.max(0, xp - base);
    }
    return totalGain;
  };

  const points: Array<{ t: string; gain: number }> = [];
  for (let t = from.getTime(); t < to.getTime(); t += bucketMs) {
    points.push({ t: new Date(t).toISOString(), gain: gainAt(t) });
  }
  points.push({ t: to.toISOString(), gain: gainAt(to.getTime()) });

  return points;
}

function xpAtOrBefore(series: SamplePoint[], time: number): number {
  let xp = series[0]?.xp ?? 0;
  for (const point of series) {
    if (point.t <= time) xp = point.xp;
    else break;
  }
  return xp;
}

/** Standalone helper used by Nest service and prisma/seed.ts */
export function buildSyntheticXpSamples(
  memberId: string,
  skills: Array<{ skillId: string; xp: bigint | number }>,
  endAt = new Date(),
): SampleRow[] {
  const yearMs = PERIOD_MS['365d'];
  const rows: SampleRow[] = [];

  for (const skill of skills) {
    const endXp = Number(skill.xp);
    if (endXp <= 0) {
      rows.push({
        memberId,
        skillId: skill.skillId,
        xp: 0n,
        sampledAt: endAt,
      });
      continue;
    }

    const hash = deterministicHash(`${memberId}:${skill.skillId}`);
    const startRatio = 0.35 + (hash % 36) / 100;
    const startXp = Math.floor(endXp * startRatio);
    const totalGain = endXp - startXp;

    const burst1End = 0.45;
    const quietEnd = 0.72;
    const weights: number[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const t = i / (SAMPLE_COUNT - 1);
      let w = 0.15;
      if (t < burst1End) w = 0.55 + ((hash >> (i % 8)) & 3) * 0.08;
      else if (t < quietEnd) w = 0.05;
      else w = 1.1 + ((hash >> ((i + 3) % 8)) & 3) * 0.15;
      weights.push(w);
    }
    const weightSum = weights.reduce((a, b) => a + b, 0);

    let accrued = 0;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const t = i / (SAMPLE_COUNT - 1);
      accrued += (weights[i] / weightSum) * totalGain;
      const xp = Math.min(endXp, Math.round(startXp + accrued));
      const jitter = ((hash + i * 17) % 11) * 60 * 60 * 1000;
      const sampledAt = new Date(endAt.getTime() - yearMs * (1 - t) - jitter);
      rows.push({
        memberId,
        skillId: skill.skillId,
        xp: BigInt(xp),
        sampledAt,
      });
    }

    const recentHours = 36;
    const recentStartXp = Math.max(
      startXp,
      Math.floor(endXp - totalGain * 0.04),
    );
    for (let h = recentHours; h >= 0; h--) {
      const progress = 1 - h / recentHours;
      const xp = Math.round(
        recentStartXp + (endXp - recentStartXp) * progress * progress,
      );
      rows.push({
        memberId,
        skillId: skill.skillId,
        xp: BigInt(Math.min(endXp, xp)),
        sampledAt: new Date(endAt.getTime() - h * 60 * 60 * 1000),
      });
    }
  }

  return rows;
}
