/**
 * The JSON shape get-group-data and the SSE stream return.
 *
 * Field names are the plugin's, not the schema's: `inventory`/`bank`/
 * `equipment` instead of the inv/worn/bank gameval keys, snake_case instead of
 * camelCase. Changing any of them breaks every shipped plugin build, so the
 * mapping is written out rather than derived from the models.
 */
import type { Member, MemberSkill } from '@prisma/client';
import { isFullScope, type ShareScope } from './group-access.service';
import { SHARED_MEMBER } from './group.types';
import {
  WIRE_INVENTORIES,
  WORLD_STAT_INDEX,
  rowsToPairs,
  statsFromArray,
  statsToArray,
} from './item-codec';
import { skillsToWire } from './skill-codec';

/**
 * A plugin that crashes or loses its connection never sends its logout, so
 * `online` alone can stay true forever. The plugin heartbeats every 5 minutes
 * while idle; a member quiet for longer than this is shown offline.
 */
export const ONLINE_STALE_MS = 12 * 60 * 1000;

export function isOnline(
  member: { online: boolean; lastUpdated: Date },
  now: number = Date.now(),
): boolean {
  return member.online && now - member.lastUpdated.getTime() < ONLINE_STALE_MS;
}

type InventoryRowLike = { slot: number; itemId: number; quantity: number };

/** Any inventory with its contents, member-owned or group-owned. */
type InventoryLike = { key: string; items: InventoryRowLike[] };

type VerifiableMember = {
  player: { verificationStatus: string } | null;
};

export type MemberWithData = Member & {
  inventories: InventoryLike[];
  skills: MemberSkill[];
} & VerifiableMember;

function isVerified(member: VerifiableMember): boolean {
  return member.player?.verificationStatus === 'plugin_verified';
}

/** Inventory keys that already have a named wire field. */
const STANDARD_INVENTORY_KEYS: ReadonlySet<string> = new Set(
  Object.values(WIRE_INVENTORIES),
);

/**
 * Inventories as wire fields: inv/worn/bank under their historical names,
 * anything else in a generic `inventories` map keyed by gameval, omitted
 * entirely when there is nothing extra.
 */
export function inventoriesToWire(inventories: InventoryLike[]) {
  const byKey = new Map<string, number[]>();
  for (const inventory of inventories) {
    byKey.set(inventory.key, rowsToPairs(inventory.items));
  }
  const extra: Record<string, number[]> = {};
  for (const [key, pairs] of byKey) {
    if (!STANDARD_INVENTORY_KEYS.has(key)) extra[key] = pairs;
  }
  return {
    inventory: byKey.get(WIRE_INVENTORIES.inventory) ?? [],
    bank: byKey.get(WIRE_INVENTORIES.bank) ?? [],
    equipment: byKey.get(WIRE_INVENTORIES.equipment) ?? [],
    ...(Object.keys(extra).length ? { inventories: extra } : {}),
  };
}

/**
 * A member who opted out of the live map — or who is sitting in the lobby —
 * reports no position at all. The empty array is what the clients already treat
 * as "nothing to plot", so hiding costs them no extra branch.
 */
export function wireCoordinates(member: {
  x: number;
  y: number;
  plane: number;
  shareLocation: boolean;
  inLobby: boolean;
}) {
  if (!member.shareLocation || member.inLobby) return [];
  return [member.x, member.y, member.plane];
}

/**
 * A target only counts while it is fresh: a plugin that crashes mid-fight
 * would otherwise leave the member shown as fighting forever.
 */
export const TARGET_STALE_MS = 30 * 1000;

export function wireTarget(
  member: {
    targetName: string | null;
    targetHp: number | null;
    targetPercent: number | null;
    targetAt: Date | null;
  },
  now: number = Date.now(),
) {
  if (!member.targetName || !member.targetAt) return undefined;
  if (now - member.targetAt.getTime() >= TARGET_STALE_MS) return undefined;
  return {
    name: member.targetName,
    hp: member.targetHp ?? undefined,
    percent: member.targetPercent ?? undefined,
    at: member.targetAt.toISOString(),
  };
}

export function toWireMember(member: MemberWithData) {
  return {
    name: member.name,
    nickname: member.nickname ?? undefined,
    discord_id: member.discordId ?? undefined,
    color: member.color ?? undefined,
    use_discord_avatar: member.useDiscordAvatar,
    online: isOnline(member),
    last_updated: member.lastUpdated.toISOString(),
    stats: statsToArray(member),
    coordinates: wireCoordinates(member),
    share_location: member.shareLocation,
    in_lobby: member.inLobby,
    target: wireTarget(member),
    baseline_at: member.baselineAt?.toISOString(),
    verified: isVerified(member),
    ...inventoriesToWire(member.inventories),
    skills: skillsToWire(member.skills),
  };
}

/**
 * A member whose light fields changed but whose inventories and skills did
 * not. Only sent when the caller opted in with `split=1`.
 *
 * `partial: true` is what tells the client to merge these fields onto its
 * cached copy instead of replacing it — without the marker, an absent `bank`
 * would be indistinguishable from an empty one.
 */
export function toPartialWireMember(member: Member & VerifiableMember) {
  return {
    name: member.name,
    partial: true as const,
    nickname: member.nickname ?? undefined,
    discord_id: member.discordId ?? undefined,
    color: member.color ?? undefined,
    use_discord_avatar: member.useDiscordAvatar,
    online: isOnline(member),
    last_updated: member.lastUpdated.toISOString(),
    stats: statsToArray(member),
    coordinates: wireCoordinates(member),
    share_location: member.shareLocation,
    in_lobby: member.inLobby,
    target: wireTarget(member),
    baseline_at: member.baselineAt?.toISOString(),
    verified: isVerified(member),
  };
}

/** The group's inventories presented as the "@SHARED" pseudo-member. */
export function toSharedWireMember(
  inventories: InventoryLike[],
  updatedAt: Date,
) {
  return {
    name: SHARED_MEMBER,
    nickname: undefined,
    discord_id: undefined,
    color: undefined,
    use_discord_avatar: false,
    online: false,
    last_updated: updatedAt.toISOString(),
    stats: statsToArray({ ...statsFromArray([]), world: 0, weight: 0 }),
    coordinates: [0, 0, 0],
    verified: false,
    ...inventoriesToWire(inventories),
    skills: skillsToWire([]),
  };
}

/** One entry in the payload: a full member, light fields only, or a name-only stub. */
export type WireEntry =
  | { name: string }
  | ReturnType<typeof toWireMember>
  | ReturnType<typeof toPartialWireMember>;

export function redactWireEntries(
  entries: WireEntry[],
  scope: ShareScope,
): WireEntry[] {
  if (isFullScope(scope)) return entries;
  return entries.map((entry) => {
    if (!('last_updated' in entry)) return entry;
    const hidden: Record<string, unknown> = {};
    if (!scope.map) {
      hidden.coordinates = [];
      hidden.target = undefined;
      if (Array.isArray(entry.stats)) {
        const stats = [...(entry.stats as number[])];
        stats[WORLD_STAT_INDEX] = 0;
        hidden.stats = stats;
      }
    }
    if (!scope.items && 'bank' in entry) {
      hidden.inventory = [];
      hidden.bank = [];
      hidden.equipment = [];
      hidden.inventories = undefined;
    }
    if (!scope.skills && 'skills' in entry) hidden.skills = {};
    return { ...entry, ...hidden };
  });
}
