import { lookupItemName } from './itemNames';
import { PRESENCE_TIMEOUT_MS } from './polling';
import {
  LIFE_POINTS_PER_LEVEL,
  SKILLS,
  lifePointsForLevel,
  type SkillCurve,
  type SkillId,
} from './skills';

/**
 * Life points, not a Constitution level.
 *
 * Maximum is always derived from the Constitution level (100 per level), so
 * the bar is right even when a client reports the cap oddly. The current value
 * is what the client sent, clamped to the maximum.
 *
 * A client that reports the level rather than life points (99 where 9900 is
 * expected) is scaled up, so the bar is never stuck near empty.
 */
function healthFromStats(
  stats: number[],
  skills: PlayerSkill[],
): { current: number; max: number } {
  const constitution = skills.find((s) => s.id === 'constitution');
  let current = Math.max(0, Math.floor(stats[0] ?? 0));
  let max = Math.max(0, Math.floor(stats[1] ?? 0));

  if (max > 0) {
    // The plugin reports its own maximum, which beats guessing from the skill
    // table. Any cap below the level-10 minimum is levels, not life points —
    // a real life point maximum starts at 1000.
    if (max < lifePointsForLevel(0)) {
      current *= LIFE_POINTS_PER_LEVEL;
      max *= LIFE_POINTS_PER_LEVEL;
    }
    return { current: Math.min(current, max), max };
  }

  max = lifePointsForLevel(constitution?.baseLevel ?? 0);
  // Below a tenth of the cap almost certainly means levels, not life points.
  if (current > 0 && current * LIFE_POINTS_PER_LEVEL <= max) {
    current *= LIFE_POINTS_PER_LEVEL;
  }
  return { current: Math.min(current, max), max };
}

export type WireSkill = {
  id: string;
  xp: number;
  level: number;
  baseLevel: number;
};

export type WireMember = {
  name: string;
  nickname?: string;
  discord_id?: string;
  color?: string;
  use_discord_avatar?: boolean;
  online?: boolean;
  /** False when the member opted out of the live map; coordinates arrive empty. */
  share_location?: boolean;
  /** Online but on the lobby screen, so there is no position to plot. */
  in_lobby?: boolean;
  /** Set when the plugin last sent its login baseline, so catch-up XP is known. */
  baseline_at?: string;
  /** What this member is fighting right now, absent when they are not. */
  target?: { name: string; hp?: number; percent?: number; at: string };
  last_updated?: string;
  stats?: number[];
  coordinates?: number[];
  inventory?: number[];
  bank?: number[];
  equipment?: number[];
  /** Any further inventories keyed by RS3 inv gameval (e.g. money_pouch). */
  inventories?: Record<string, number[]>;
  skills?: WireSkill[];
  verified?: boolean;
};

/** Delta-poll placeholder: member unchanged since `from_time`. */
export type WireMemberStub = { name: string };

/**
 * Delta-poll partial: the member moved (or their vitals/profile changed) but
 * their inventories and skills did not, so those are omitted and merged from
 * the cached copy. Only sent when the request asked for `split=1`.
 */
export type WirePartialMember = {
  name: string;
  partial: true;
  nickname?: string;
  discord_id?: string;
  color?: string;
  use_discord_avatar?: boolean;
  online?: boolean;
  share_location?: boolean;
  in_lobby?: boolean;
  baseline_at?: string;
  target?: { name: string; hp?: number; percent?: number; at: string };
  last_updated?: string;
  stats?: number[];
  coordinates?: number[];
  verified?: boolean;
};

export type WireEntry = WireMember | WireMemberStub | WirePartialMember;

export function isPartialMember(
  member: WireEntry,
): member is WirePartialMember {
  return 'partial' in member && member.partial === true;
}

export function isFullMember(member: WireEntry): member is WireMember {
  // Partial entries also carry last_updated, so they must be excluded first or
  // they would be mistaken for complete members and wipe the cached items.
  return !isPartialMember(member) && 'last_updated' in member;
}

export type ItemStack = {
  id: number;
  quantity: number;
};

export type PlayerSkill = {
  id: SkillId;
  name: string;
  icon: string;
  xp: number;
  level: number;
  baseLevel: number;
  maxLevel: number;
  /** Elite skills need their own curve for "XP to next level". */
  curve?: SkillCurve;
};

export type PlayerView = {
  name: string;
  nickname: string | null;
  displayName: string;
  discordId: string | null;
  /** Discord CDN URL when available; display uses avatarUrl. */
  discordAvatarUrl: string | null;
  /** Resolved avatar for map/panel (null when Discord avatar is off). */
  avatarUrl: string | null;
  useDiscordAvatar: boolean;
  verified: boolean;
  online: boolean;
  /** Online but on the lobby screen: shown as "lobby" instead of a position. */
  inLobby: boolean;
  /** Timestamp of the plugin's last login baseline, or null. */
  baselineAt: string | null;
  /** The NPC this member is fighting, or null when they are not. */
  target: { name: string; hp: number | null; percent: number | null } | null;
  /** Game world the member is on, or 0 when the plugin hasn't reported one. */
  world: number;
  lastSeen: string | null;
  avatarColor: string;
  health: { current: number; max: number };
  prayer: { current: number; max: number };
  summoning: { current: number; max: number };
  /** Carried weight in kilograms; negative with weight-reducing gear. */
  weight: number;
  coordinates: number[];
  inventory: ItemStack[];
  bank: ItemStack[];
  equipment: ItemStack[];
  /** Same items with empty slots kept, for the fixed-grid panels. */
  inventorySlots: Array<ItemStack | null>;
  equipmentSlots: Array<ItemStack | null>;
  /** Coins in the money pouch, shown under the inventory grid. */
  moneyPouch: number;
  skills: PlayerSkill[];
  totalLevel: number;
  /** Change key used by membersToPlayers() to reuse unchanged views. */
  viewKey?: string;
};

export type GroupItemShare = {
  player: string;
  quantity: number;
};

export type GroupItem = {
  id: number;
  name: string;
  quantity: number;
  shares: GroupItemShare[];
};

const SHARED = '@SHARED';

const ITEM_NAMES: Record<number, string> = {
  995: 'Coins',
  4151: 'Abyssal whip',
  11694: 'Armadyl godsword',
  1127: 'Rune platebody',
  1079: 'Rune platelegs',
  1351: 'Bronze axe',
  1265: 'Bronze pickaxe',
  1511: 'Logs',
  440: 'Iron ore',
  554: 'Fire rune',
  560: 'Death rune',
  565: 'Blood rune',
  6685: 'Saradomin brew',
  3024: 'Super restore',
  15259: 'Dragon hatchet',
  2434: 'Prayer potion',
  23351: 'Elder overload',
  23354: 'Holy agony',
};

/**
 * Served by our API rather than straight from the renderer: that origin sends
 * no Cache-Control, ETag or Last-Modified, so a browser re-fetches every icon
 * on every page load. The API fetches each once and serves it with cache
 * headers.
 */
export function itemIconUrl(itemId: number) {
  return `/api/items/icon/${itemId}`;
}

/**
 * The catalogue covers every item in the game but arrives asynchronously, so
 * the small built-in table above still backs the first render. Components that
 * show names call useItemNames() to redraw once it has loaded.
 */
export function itemName(itemId: number) {
  return lookupItemName(itemId) ?? ITEM_NAMES[itemId] ?? `Item ${itemId}`;
}

/** Backpack capacity: the panel always draws this many slots. */
export const BACKPACK_SLOTS = 28;

/** RS3 inv gameval for the coin pouch, carried in the generic map. */
const MONEY_POUCH_KEY = 'money_pouch';

/**
 * The pouch holds more than a 32-bit stack can count, so the game splits it:
 * one slot of plain coins and one of `coins_b`, where each counts a billion.
 * Both arrive as sent — collapsing them before storage would overflow the
 * server's integer column — so the total is worked out here.
 */
const COINS = 995;
const COINS_BILLION = 54830;
const BILLION = 1_000_000_000;

export function moneyPouchTotal(member: WireMember): number {
  const pairs = member.inventories?.[MONEY_POUCH_KEY];
  if (!pairs?.length) return 0;
  let total = 0;
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const id = pairs[i] ?? 0;
    const quantity = pairs[i + 1] ?? 0;
    if (id === COINS_BILLION) total += quantity * BILLION;
    else if (id === COINS) total += quantity;
  }
  return total;
}

/**
 * Pairs with their empty slots kept, so a panel can draw a fixed grid and the
 * items stay where they are instead of shifting left as things are used.
 */
export function unpackSlots(
  pairs: number[] | undefined,
  slots?: number,
): Array<ItemStack | null> {
  const out: Array<ItemStack | null> = [];
  if (pairs?.length) {
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const id = pairs[i] ?? 0;
      const quantity = pairs[i + 1] ?? 0;
      out.push(id > 0 && quantity > 0 ? { id, quantity } : null);
    }
  }
  if (slots === undefined) return out;
  while (out.length < slots) out.push(null);
  return out.slice(0, slots);
}

export function unpackPairs(pairs: number[] | undefined): ItemStack[] {
  if (!pairs?.length) return [];
  const out: ItemStack[] = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const id = pairs[i] ?? 0;
    const quantity = pairs[i + 1] ?? 0;
    if (id > 0 && quantity > 0) out.push({ id, quantity });
  }
  return out;
}

export function colorForName(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++)
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hues = [120, 85, 40, 200, 280, 160];
  const h = hues[hash % hues.length];
  return hslToHex(h, 42, 38);
}

function hslToHex(h: number, s: number, l: number) {
  const sat = s / 100;
  const light = l / 100;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = light - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function resolveAvatarColor(name: string, color?: string | null) {
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) return color.toLowerCase();
  return colorForName(name);
}

/** Discord default avatar from snowflake (custom avatars need the Discord API). */
export function discordAvatarUrl(
  discordId: string | null | undefined,
): string | null {
  if (!discordId || !/^\d{17,20}$/.test(discordId)) return null;
  const index = Number((BigInt(discordId) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

export function toPlayerView(member: WireMember): PlayerView | null {
  if (!member.name || member.name === SHARED) return null;
  const stats = member.stats ?? [];
  const skillById = new Map((member.skills ?? []).map((s) => [s.id, s]));
  const skills: PlayerSkill[] = SKILLS.map((def) => {
    const row = skillById.get(def.id);
    return {
      id: def.id,
      name: def.name,
      icon: def.icon,
      xp: row?.xp ?? 0,
      // Constitution starts at 10; every other skill at 1.
      level: Math.max(def.minLevel ?? 1, row?.level ?? 1),
      baseLevel: Math.max(def.minLevel ?? 1, row?.baseLevel ?? 1),
      maxLevel: def.maxLevel,
      curve: def.curve,
    };
  });
  const nickname = member.nickname?.trim() || null;
  const discordId = member.discord_id?.trim() || null;
  const discordUrl = discordAvatarUrl(discordId);
  const useDiscordAvatar = member.use_discord_avatar !== false;

  return {
    name: member.name,
    nickname,
    displayName: nickname || member.name,
    discordId,
    discordAvatarUrl: discordUrl,
    useDiscordAvatar,
    avatarUrl: useDiscordAvatar ? discordUrl : null,
    verified: member.verified === true,
    online: member.online === true,
    inLobby: member.in_lobby === true,
    baselineAt: member.baseline_at ?? null,
    target: member.target
      ? {
          name: member.target.name,
          hp: member.target.hp ?? null,
          percent: member.target.percent ?? null,
        }
      : null,
    world: stats[6] ?? 0,
    lastSeen: member.last_updated ?? null,
    avatarColor: resolveAvatarColor(member.name, member.color),
    health: healthFromStats(stats, skills),
    prayer: { current: stats[2] ?? 0, max: stats[3] ?? 0 },
    summoning: { current: stats[4] ?? 0, max: stats[5] ?? 0 },
    weight: stats[7] ?? 0,
    coordinates: member.coordinates ?? [],
    inventory: unpackPairs(member.inventory),
    bank: unpackPairs(member.bank),
    equipment: unpackPairs(member.equipment),
    inventorySlots: unpackSlots(member.inventory, BACKPACK_SLOTS),
    equipmentSlots: unpackSlots(member.equipment),
    moneyPouch: moneyPouchTotal(member),
    skills,
    totalLevel: skills.reduce((sum, s) => sum + s.baseLevel, 0),
  };
}

/**
 * Identity of everything that feeds a PlayerView. Profile edits don't bump
 * last_updated on the server, so they are part of the key too.
 */
function memberViewKey(member: WireMember) {
  return [
    member.last_updated ?? '',
    member.nickname ?? '',
    member.discord_id ?? '',
    member.color ?? '',
    member.use_discord_avatar === false ? '0' : '1',
    member.online === true ? '1' : '0',
    member.verified === true ? '1' : '0',
    member.target ? `${member.target.name}:${member.target.hp ?? ''}` : '',
  ].join('|');
}

/**
 * Convert wire members to PlayerViews (shared bank skipped). When `prev` is
 * given, members whose data hasn't changed keep their previous PlayerView
 * object so memoised children don't re-render.
 *
 * Sorted by username so the roster never reshuffles: the payload arrives in
 * whatever order the members last updated, which would otherwise reorder every
 * list on screen each poll.
 */
export function membersToPlayers(
  members: WireMember[],
  prev: PlayerView[] = [],
): PlayerView[] {
  const prevByName = new Map(prev.map((p) => [p.name, p]));
  const out: PlayerView[] = [];
  for (const member of members) {
    const key = memberViewKey(member);
    const cached = prevByName.get(member.name);
    if (cached && cached.viewKey === key) {
      out.push(cached);
      continue;
    }
    const view = toPlayerView(member);
    if (view) out.push({ ...view, viewKey: key });
  }
  out.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  return out;
}

export function withPresenceTimeout(
  players: PlayerView[],
  now: number,
): PlayerView[] {
  let changed = false;
  const next = players.map((p) => {
    if (!p.online) return p;
    const lastSeenAt = p.lastSeen ? Date.parse(p.lastSeen) : NaN;
    if (Number.isFinite(lastSeenAt) && now - lastSeenAt < PRESENCE_TIMEOUT_MS) {
      return p;
    }
    changed = true;
    return { ...p, online: false, inLobby: false };
  });
  return changed ? next : players;
}

export type ItemSource = 'bank' | 'inventory' | 'equipment';

export const ITEM_SOURCES: ItemSource[] = ['bank', 'inventory', 'equipment'];

const SOURCE_FIELD: Record<ItemSource, keyof WireMember> = {
  bank: 'bank',
  inventory: 'inventory',
  equipment: 'equipment',
};

/**
 * Aggregate items across members for the Items tab, plus the group's shared
 * bank. `sources` picks which containers count, so a total can mean the bank
 * alone or everything a group owns.
 */
export function aggregateGroupItems(
  members: WireMember[],
  sources: ReadonlyArray<ItemSource> = ITEM_SOURCES,
): GroupItem[] {
  const map = new Map<number, Map<string, number>>();

  for (const member of members) {
    const label = member.name === SHARED ? 'Shared bank' : member.name;
    for (const source of sources) {
      // Only the shared bank has a bank; carried items belong to a member.
      const stacks = unpackPairs(
        member[SOURCE_FIELD[source]] as number[] | undefined,
      );
      for (const stack of stacks) {
        let byPlayer = map.get(stack.id);
        if (!byPlayer) {
          byPlayer = new Map();
          map.set(stack.id, byPlayer);
        }
        byPlayer.set(label, (byPlayer.get(label) ?? 0) + stack.quantity);
      }
    }
  }

  const items: GroupItem[] = [];
  for (const [id, byPlayer] of map) {
    const shares = [...byPlayer.entries()]
      .map(([player, quantity]) => ({ player, quantity }))
      .sort((a, b) => b.quantity - a.quantity);
    items.push({
      id,
      name: itemName(id),
      quantity: shares.reduce((sum, s) => sum + s.quantity, 0),
      shares,
    });
  }

  return items.sort(
    (a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name),
  );
}

export function formatQty(n: number) {
  return n.toLocaleString();
}

/**
 * Stack count as the game draws it in a slot: plain below 100K, then K, then M.
 * Keeps the overlay inside a 38px slot without truncating.
 */
export function formatStack(n: number) {
  if (n < 100_000) return String(n);
  if (n < 10_000_000) return `${Math.floor(n / 1000)}K`;
  return `${Math.floor(n / 1_000_000)}M`;
}
