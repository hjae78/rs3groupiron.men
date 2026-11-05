import { BadRequestException } from '@nestjs/common';
import { AchievementKind, type Prisma } from '@prisma/client';
import { deterministicHash } from '../common/hash';
import { spreadTimestamp } from '../common/spread-timestamp';
import {
  MAX_SKILL_XP,
  SKILLS,
  SKILL_BY_ID,
  type SkillId,
} from '../skills/skills.catalog';

/** Level milestones worth an achievement, if the skill can reach them. */
export const LEVEL_MILESTONES = [99, 110, 120] as const;

/** XP milestone (the RS3 per-skill cap). */
export const XP_MILESTONE = MAX_SKILL_XP;

/**
 * Total level milestones. Coarse at the bottom where levels come quickly and
 * every hundred at the top, so the feed marks real effort rather than noise.
 */
export const TOTAL_LEVEL_MILESTONES = [
  500, 1000, 1500, 1750, 2000, 2200, 2400, 2600, 2800, 3000, 3100, 3200, 3300,
  3400, 3480,
] as const;

export const ACHIEVEMENT_KINDS = [
  'level',
  'drop',
  'quest',
  'diary',
  'other',
] as const;

export type AchievementKindName = (typeof ACHIEVEMENT_KINDS)[number];

export const ACHIEVEMENT_LIMIT_DEFAULT = 50;
export const ACHIEVEMENT_LIMIT_MIN = 1;
export const ACHIEVEMENT_LIMIT_MAX = 100;

/** How far into the future a client-supplied `achieved_at` may sit. */
export const ACHIEVEMENT_FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/** Minimal shape of a stored/incoming skill row used for crossing detection. */
export type SkillSnapshot = {
  skillId: string;
  xp: bigint | number;
  level: number;
  baseLevel?: number;
};

/** A detected milestone, ready to be turned into an Achievement row. */
export type DetectedMilestone = {
  memberName: string;
  kind: 'level';
  title: string;
  detail: string;
  /** Absent for milestones that belong to no single skill, like total level. */
  skillId?: string;
  dedupeKey: string;
};

function xpOf(row: SkillSnapshot): number {
  return typeof row.xp === 'bigint' ? Number(row.xp) : Number(row.xp ?? 0);
}

/** Unboosted level is the real milestone; fall back to `level` when absent. */
function levelOf(row: SkillSnapshot): number {
  const base = row.baseLevel ?? row.level ?? 1;
  return Number.isFinite(base) ? base : 1;
}

export function levelDedupeKey(
  memberName: string,
  skillId: string,
  milestone: number,
): string {
  return `level:${memberName}:${skillId}:${milestone}`;
}

export function xpDedupeKey(memberName: string, skillId: string): string {
  return `xp200m:${memberName}:${skillId}`;
}

export function totalLevelDedupeKey(
  memberName: string,
  milestone: number,
): string {
  return `total:${memberName}:${milestone}`;
}

/** Unboosted levels only; a boosted total is not an achievement. */
function totalLevelOf(rows: SkillSnapshot[]): number {
  let total = 0;
  for (const row of rows) {
    if (SKILL_BY_ID[row.skillId as SkillId]) total += levelOf(row);
  }
  return total;
}

/**
 * Milestones crossed between two skill snapshots for one member.
 *
 * `previous` is the member's last stored snapshot. An empty/absent previous
 * snapshot is treated as the BASELINE (a brand-new member's first-ever sync),
 * so nothing is recorded — otherwise a maxed account would emit dozens of rows
 * on its first sync. Pure and allocation-light: this runs on the plugin's hot
 * skill-sync path.
 */
export function detectSkillMilestones(
  memberName: string,
  previous: SkillSnapshot[] | null | undefined,
  next: SkillSnapshot[] | null | undefined,
): DetectedMilestone[] {
  if (!previous?.length || !next?.length) return [];

  const before = new Map<string, SkillSnapshot>();
  for (const row of previous) before.set(row.skillId, row);

  const out: DetectedMilestone[] = [];

  for (const row of next) {
    const def = SKILL_BY_ID[row.skillId as SkillId];
    if (!def) continue;

    const prev = before.get(row.skillId);
    // The member already has a snapshot, so a skill missing from it is a
    // genuine 1 / 0xp starting point rather than a first-ever sync.
    const prevLevel = prev ? levelOf(prev) : 1;
    const prevXp = prev ? xpOf(prev) : 0;
    const nextLevel = levelOf(row);
    const nextXp = xpOf(row);

    for (const milestone of LEVEL_MILESTONES) {
      if (milestone > def.maxLevel) continue;
      if (prevLevel < milestone && nextLevel >= milestone) {
        out.push({
          memberName,
          kind: 'level',
          title: `${milestone} ${def.name}`,
          detail: `Reached level ${milestone}`,
          skillId: def.id,
          dedupeKey: levelDedupeKey(memberName, def.id, milestone),
        });
      }
    }

    if (prevXp < XP_MILESTONE && nextXp >= XP_MILESTONE) {
      out.push({
        memberName,
        kind: 'level',
        title: `200M ${def.name} XP`,
        detail: 'Reached 200,000,000 XP',
        skillId: def.id,
        dedupeKey: xpDedupeKey(memberName, def.id),
      });
    }
  }

  // The update may carry only the skills that changed, so the totals are taken
  // from the stored snapshot with those skills overlaid.
  const merged = new Map<string, SkillSnapshot>();
  for (const row of previous) merged.set(row.skillId, row);
  const beforeTotal = totalLevelOf([...merged.values()]);
  for (const row of next) merged.set(row.skillId, row);
  const afterTotal = totalLevelOf([...merged.values()]);

  for (const milestone of TOTAL_LEVEL_MILESTONES) {
    if (beforeTotal < milestone && afterTotal >= milestone) {
      out.push({
        memberName,
        kind: 'level',
        title: `${milestone} total level`,
        detail: `Reached a total level of ${milestone.toLocaleString()}`,
        dedupeKey: totalLevelDedupeKey(memberName, milestone),
      });
    }
  }

  return out;
}

/** Clamp to 1–100; anything unparseable falls back to the default. */
export function parseAchievementLimit(raw?: string): number {
  if (raw == null || raw === '') return ACHIEVEMENT_LIMIT_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return ACHIEVEMENT_LIMIT_DEFAULT;
  const int = Math.trunc(n);
  if (int < ACHIEVEMENT_LIMIT_MIN) return ACHIEVEMENT_LIMIT_MIN;
  if (int > ACHIEVEMENT_LIMIT_MAX) return ACHIEVEMENT_LIMIT_MAX;
  return int;
}

/** Unknown kinds are ignored (no filter) rather than rejected. */
export function parseAchievementKind(
  raw?: string,
): AchievementKind | undefined {
  if (!raw) return undefined;
  return (ACHIEVEMENT_KINDS as readonly string[]).includes(raw)
    ? (raw as AchievementKind)
    : undefined;
}

/** Exact-name member filter; blank/oversized values are ignored. */
export function parseAchievementMember(raw?: string): string | undefined {
  const name = raw?.trim();
  if (!name || name.length > 50) return undefined;
  return name;
}

/**
 * Origins accepted for `image_url`, parsed from CDN_BASE_URL (comma separated).
 * Unset/garbage yields an empty list, which rejects every image_url.
 */
export function cdnAllowedOrigins(cdnBaseUrl?: string): string[] {
  if (!cdnBaseUrl) return [];
  const origins: string[] = [];
  for (const part of cdnBaseUrl.split(',')) {
    const raw = part.trim();
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      if (!origins.includes(url.origin)) origins.push(url.origin);
    } catch {
      // Ignore unparseable allow-list entries.
    }
  }
  return origins;
}

/**
 * Only URLs whose origin exactly matches the CDN allow-list are stored.
 * Returns null for an absent value; throws 400 for anything else.
 */
export function validateImageUrl(
  raw: string | undefined | null,
  cdnBaseUrl?: string,
): string | null {
  const value = raw?.trim();
  if (!value) return null;

  const allowed = cdnAllowedOrigins(cdnBaseUrl);
  if (!allowed.length) {
    throw new BadRequestException(
      'image_url is not accepted: no CDN_BASE_URL is configured',
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('image_url must be an absolute URL');
  }
  if (!allowed.includes(url.origin)) {
    throw new BadRequestException(
      `image_url must be hosted on ${allowed.join(' or ')}`,
    );
  }
  return url.toString();
}

/**
 * Client-supplied timestamp. Unparseable values fall back to `now`; dates far
 * in the future are rejected so a bad client can't pin itself to the top.
 */
export function parseAchievedAt(raw: string | undefined, now = new Date()) {
  if (!raw) return now;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return now;
  if (ms > now.getTime() + ACHIEVEMENT_FUTURE_SLACK_MS) {
    throw new BadRequestException('achieved_at is too far in the future');
  }
  return new Date(ms);
}

/** Wire shape shared by the read and write endpoints. Absent values are null. */
export type AchievementEntry = {
  id: string;
  name: string;
  kind: AchievementKind;
  title: string;
  detail: string | null;
  skill_id: string | null;
  item_id: number | null;
  /** Stack size for drops, so the feed can draw the item as the game does. */
  quantity: number | null;
  /** RS3 gameval name for quests/diaries (stable across cache revisions). */
  gameval: string | null;
  image_url: string | null;
  at: string;
};

export function toAchievementEntry(row: {
  id: string;
  memberName: string;
  kind: AchievementKind;
  title: string;
  detail: string | null;
  skillId: string | null;
  itemId: number | null;
  quantity?: number | null;
  gameval?: string | null;
  imageUrl: string | null;
  achievedAt: Date;
}): AchievementEntry {
  return {
    id: row.id,
    name: row.memberName,
    kind: row.kind,
    title: row.title,
    detail: row.detail ?? null,
    skill_id: row.skillId ?? null,
    item_id: row.itemId ?? null,
    quantity: row.quantity ?? null,
    gameval: row.gameval ?? null,
    image_url: row.imageUrl ?? null,
    at: row.achievedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ seed */

const ACHIEVEMENT_SEED_DAYS = 60;
const ACHIEVEMENT_SEED_MIN = 25;
const ACHIEVEMENT_SEED_SPREAD = 11; // 25–35 entries

const SEED_QUESTS = [
  'The World Wakes',
  'Nomad’s Elegy',
  'Desert Treasure',
  'Fate of the Gods',
  'Dishonour among Thieves',
  'Plague’s End',
  'Sliske’s Endgame',
  'Children of Mah',
  'While Guthix Sleeps',
  'City of Senntisten',
];

const SEED_DIARIES = [
  'Ardougne Achievements',
  'Falador Achievements',
  'Karamja Achievements',
  'Varrock Achievements',
  'Desert Achievements',
  'Fremennik Achievements',
  'Morytania Achievements',
  'Seers’ Village Achievements',
];

const SEED_DROP_NAMES = [
  'Rare drop',
  'Boss unique',
  'Pet drop',
  'Clue scroll reward',
  'Raid unique',
];

/**
 * Sample screenshots shipped with the web app (apps/web/public/demo-shots).
 * Seed-only: real achievements must use a CDN-hosted image_url.
 */
const DEMO_IMAGE_BY_KIND: Record<string, string> = {
  level: '/demo-shots/levelup.png',
  drop: '/demo-shots/drop.png',
  quest: '/demo-shots/quest.png',
  diary: '/demo-shots/diary.png',
};

function demoImageForKind(kind: AchievementKind): string | null {
  return DEMO_IMAGE_BY_KIND[kind] ?? null;
}

/**
 * Plausible achievement history over the last ~60 days across the group's real
 * members. Deterministic (hashed off the group name) like the synthetic
 * shared-bank ledger so reseeding is reproducible.
 */
export function buildSyntheticAchievements(
  groupId: string,
  groupName: string,
  memberNames: string[],
  itemIds: number[],
  endAt = new Date(),
): Prisma.AchievementCreateManyInput[] {
  if (!memberNames.length) return [];

  const base = deterministicHash(groupName);
  const count = ACHIEVEMENT_SEED_MIN + (base % ACHIEVEMENT_SEED_SPREAD);
  const windowMs = ACHIEVEMENT_SEED_DAYS * 24 * 60 * 60 * 1000;
  const rows: Prisma.AchievementCreateManyInput[] = [];

  for (let i = 0; i < count; i++) {
    const h = deterministicHash(`ach${i}${groupName}`);
    const memberName =
      memberNames[deterministicHash(`am${i}${groupName}`) % memberNames.length];

    // ~45% level, ~25% drop (only when the group actually owns items),
    // ~15% quest, ~15% diary.
    const roll = deterministicHash(`ar${i}${groupName}`) % 100;
    let kind: AchievementKind;
    if (roll < 45) kind = AchievementKind.level;
    else if (roll < 70 && itemIds.length) kind = AchievementKind.drop;
    else if (roll < 85) kind = AchievementKind.quest;
    else kind = AchievementKind.diary;

    let title: string;
    let detail: string | null = null;
    let skillId: string | null = null;
    let itemId: number | null = null;

    if (kind === AchievementKind.level) {
      const def = SKILLS[deterministicHash(`as${i}${groupName}`) % SKILLS.length];
      const milestone = def.maxLevel >= 120 && h % 3 === 0 ? 120 : 99;
      title = `${milestone} ${def.name}`;
      detail = `Reached level ${milestone}`;
      skillId = def.id;
    } else if (kind === AchievementKind.drop) {
      itemId = itemIds[deterministicHash(`ai${i}${groupName}`) % itemIds.length];
      title = SEED_DROP_NAMES[h % SEED_DROP_NAMES.length];
      detail = `Item ${itemId}`;
    } else if (kind === AchievementKind.quest) {
      title = SEED_QUESTS[h % SEED_QUESTS.length];
      detail = 'Quest complete';
    } else {
      title = SEED_DIARIES[h % SEED_DIARIES.length];
      detail = 'Achievements complete';
    }

    // Evenly spread across the window, jittered within each slice.
    const achievedAt = spreadTimestamp(i, count, windowMs, endAt, h);

    rows.push({
      groupId,
      memberName,
      kind,
      title,
      detail,
      skillId,
      itemId,
      // Every 3rd seeded row carries a sample screenshot so the public demo
      // shows the image feature. These are static files served by the web app,
      // not CDN uploads, so no R2 config is needed to see them.
      imageUrl: i % 3 === 0 ? demoImageForKind(kind) : null,
      // Seeded rows are not auto-detected, so they carry no dedupe key.
      dedupeKey: null,
      achievedAt,
    });
  }

  rows.sort((a, b) => +(a.achievedAt as Date) - +(b.achievedAt as Date));
  return rows;
}
