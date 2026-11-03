/**
 * Turns untrusted request fields into trusted values.
 *
 * The ValidationPipe checks types and sizes from the DTO decorators; anything
 * that needs a format, a range or a game rule is enforced here, so the services
 * can assume what they are handed is already valid. Every failure is a 400 —
 * 409 is reserved for a request that is well formed but conflicts with stored
 * state, which only the services can know about.
 */
import { BadRequestException } from '@nestjs/common';
import { AppearanceTheme, GroupMode, GroupVisibility } from '@prisma/client';
import { DEFAULT_SCOPE } from './group-access.service';
import {
  MAX_BANK,
  MAX_GROUP_NAME_LENGTH,
  MAX_INVENTORIES,
  MAX_NAME_LENGTH,
  MAX_PUBLIC_GROUPS_LIMIT,
  MAX_SEARCH_QUERY,
  PUBLIC_GROUPS_LIMIT,
  SHARED_MEMBER,
  type GroupSharesInput,
  type SkillPayloadValue,
} from './group.types';

/** Max number of keys accepted in an `update-group-member` skills object. */
const MAX_SKILL_KEYS = 64;

export function parseGroupMode(raw?: string): GroupMode {
  if (raw === 'competitive') return GroupMode.competitive;
  return GroupMode.normal;
}

export function parseAppearance(raw?: string): AppearanceTheme {
  if (raw === 'modern') return AppearanceTheme.modern;
  return AppearanceTheme.rs3;
}

export function parseVisibility(raw?: string): GroupVisibility {
  if (raw === 'public') return GroupVisibility.public;
  return GroupVisibility.private;
}

export function sharesToColumns(shares: GroupSharesInput | undefined) {
  return {
    publicMap: shares?.map ?? DEFAULT_SCOPE.map,
    publicSkills: shares?.skills ?? DEFAULT_SCOPE.skills,
    publicItems: shares?.items ?? DEFAULT_SCOPE.items,
    publicQuests: shares?.quests ?? DEFAULT_SCOPE.quests,
    publicAchievements: shares?.achievements ?? DEFAULT_SCOPE.achievements,
  };
}

export function sharesPatch(shares: GroupSharesInput | undefined) {
  if (!shares) return {};
  return {
    ...(shares.map !== undefined ? { publicMap: shares.map } : {}),
    ...(shares.skills !== undefined ? { publicSkills: shares.skills } : {}),
    ...(shares.items !== undefined ? { publicItems: shares.items } : {}),
    ...(shares.quests !== undefined ? { publicQuests: shares.quests } : {}),
    ...(shares.achievements !== undefined
      ? { publicAchievements: shares.achievements }
      : {}),
  };
}

export function parseSearchQuery(raw?: string): string | null {
  const query = (raw ?? '').trim().slice(0, MAX_SEARCH_QUERY);
  return query ? query.toLowerCase() : null;
}

export function parsePublicGroupsLimit(raw?: string): number {
  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit < 1) return PUBLIC_GROUPS_LIMIT;
  return Math.min(Math.floor(limit), MAX_PUBLIC_GROUPS_LIMIT);
}

export function normalizeDiscordId(raw?: string | null): string | null {
  if (raw == null) return null;
  const id = String(raw).trim();
  if (!id) return null;
  if (!/^\d{17,20}$/.test(id)) {
    throw new BadRequestException(
      'Discord user id must be a 17–20 digit snowflake',
    );
  }
  return id;
}

export function normalizeNickname(raw?: string | null): string | null {
  if (raw == null) return null;
  const nick = String(raw).trim();
  return nick ? nick.slice(0, 32) : null;
}

export function normalizeColor(raw?: string | null): string | null {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  const short = /^#([0-9a-fA-F]{3})$/.exec(value);
  if (short) {
    const [r, g, b] = short[1].split('');
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new BadRequestException('Colour must be a hex value like #4a8f3c');
  }
  return value.toLowerCase();
}

export function normalizeUseDiscordAvatar(raw?: boolean): boolean {
  return raw !== false;
}

export function validateDisplayName(
  raw: string | undefined,
  label: string,
  maxLength: number = MAX_NAME_LENGTH,
) {
  const name = raw?.trim() ?? '';
  if (name.length < 1 || name.length > maxLength) {
    throw new BadRequestException(
      `${label} must be 1–${maxLength} characters`,
    );
  }
  return name;
}

export function validateGroupName(raw: string | undefined) {
  return validateDisplayName(raw, 'Group name', MAX_GROUP_NAME_LENGTH);
}

function isValidSkillNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * `skills` is validated loosely by the pipe (@IsObject); enforce the value
 * shape here: `number` or `{ xp?, level?, baseLevel? }` of finite, >= 0 numbers.
 */
export function validateSkillsPayload(
  skills: unknown,
): Record<string, SkillPayloadValue> {
  if (skills === null || typeof skills !== 'object' || Array.isArray(skills)) {
    throw new BadRequestException('skills must be an object keyed by skill id');
  }
  const entries = Object.entries(skills as Record<string, unknown>);
  if (entries.length > MAX_SKILL_KEYS) {
    throw new BadRequestException('skills has too many entries');
  }
  for (const [key, value] of entries) {
    if (isValidSkillNumber(value)) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException(`skills.${key} must be a number or object`);
    }
    for (const field of ['xp', 'level', 'baseLevel'] as const) {
      const v = (value as Record<string, unknown>)[field];
      if (v !== undefined && !isValidSkillNumber(v)) {
        throw new BadRequestException(
          `skills.${key}.${field} must be a finite non-negative number`,
        );
      }
    }
  }
  return skills as Record<string, SkillPayloadValue>;
}

/**
 * `inventories` is validated loosely by the pipe (@IsObject); enforce the
 * shape here: keys are inv gamevals, values are flat non-negative int lists.
 */
export function validateInventoriesPayload(
  raw: unknown,
  isKnownKey: (key: string) => boolean,
): Record<string, number[]> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException(
      'inventories must be an object keyed by inventory gameval',
    );
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_INVENTORIES) {
    throw new BadRequestException('inventories has too many entries');
  }
  const out: Record<string, number[]> = {};
  for (const [rawKey, value] of entries) {
    const key = rawKey.trim().toLowerCase();
    if (!isKnownKey(key)) {
      throw new BadRequestException(
        `inventories.${rawKey} is not a known inventory gameval`,
      );
    }
    if (!Array.isArray(value) || value.length > MAX_BANK) {
      throw new BadRequestException(
        `inventories.${rawKey} must be a list of at most ${MAX_BANK} numbers`,
      );
    }
    for (const n of value) {
      if (!Number.isInteger(n) || n < 0) {
        throw new BadRequestException(
          `inventories.${rawKey} must contain non-negative integers`,
        );
      }
    }
    out[key] = value as number[];
  }
  return out;
}

/** Exact match first, then case-insensitive. */
export function findMemberRef<T extends { name: string }>(
  members: T[],
  name: string,
): T | undefined {
  const exact = members.find((m) => m.name === name);
  if (exact) return exact;
  const key = name.toLowerCase();
  return members.find((m) => m.name.toLowerCase() === key);
}

export function playableCount(members: Array<{ name: string }>) {
  return members.filter((m) => m.name !== SHARED_MEMBER).length;
}
