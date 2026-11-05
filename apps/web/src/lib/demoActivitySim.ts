import type { ItemStack, PlayerView } from './items';

export type DemoSkillGains = Record<string, number>;
export type DemoXpTotals = Record<string, DemoSkillGains>;

export type Heading = { dx: number; dy: number };

const XP_BUCKETS = [12, 24, 50, 84, 132, 220, 360, 540, 920, 1500];

export const LOOT = [
  995, 1050, 1249, 1163, 1127, 4151, 11832, 11834, 1515, 441, 453, 1623, 1631,
  2357, 2363, 561, 565, 560, 384, 391, 7937, 15271, 23351,
];

export const BANK_QUANTITIES = [1, 1, 2, 3, 5, 10, 24, 50, 100, 280, 1000, 5000, 24_000, 150_000];

export function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/** Drifts toward a healthy band so vitals wander without decaying to zero. */
function nudge(current: number, max: number) {
  const target = max * (0.55 + Math.random() * 0.45);
  const drift = (target - current) * 0.25;
  const jitter = (Math.random() - 0.5) * max * 0.08;
  return clamp(Math.round(current + drift + jitter), Math.round(max * 0.1), max);
}

function gainXp(player: PlayerView, log: DemoXpTotals): PlayerView {
  if (!player.skills.length) return player;
  const index = Math.floor(Math.random() * player.skills.length);
  const skill = player.skills[index]!;
  const amount = pick(XP_BUCKETS);
  const levelUp = Math.random() < 0.04 && skill.level < skill.maxLevel;
  const skills = [...player.skills];
  skills[index] = {
    ...skill,
    xp: skill.xp + amount,
    level: levelUp ? skill.level + 1 : skill.level,
  };
  const bySkill = (log[player.name] ??= {});
  bySkill[skill.id] = (bySkill[skill.id] ?? 0) + amount;
  return {
    ...player,
    skills,
    totalLevel: levelUp ? player.totalLevel + 1 : player.totalLevel,
    lastSeen: new Date().toISOString(),
  };
}

/** Keeps a heading per member so they walk a route instead of jittering. */
function move(player: PlayerView, headings: Map<string, Heading>): PlayerView {
  const [x = 3200, y = 3200, plane = 0] = player.coordinates;
  let heading = headings.get(player.name);
  if (!heading || Math.random() < 0.18) {
    const angle = Math.random() * Math.PI * 2;
    heading = { dx: Math.cos(angle), dy: Math.sin(angle) };
  }

  const speed = 2 + Math.random() * 4;
  const wantX = Math.round(x + heading.dx * speed);
  const wantY = Math.round(y + heading.dy * speed);
  const nextX = clamp(wantX, 2000, 3900);
  const nextY = clamp(wantY, 2900, 3800);
  headings.set(
    player.name,
    nextX !== wantX || nextY !== wantY ? { dx: -heading.dx, dy: -heading.dy } : heading,
  );

  return {
    ...player,
    coordinates: [nextX, nextY, plane],
    lastSeen: new Date().toISOString(),
  };
}

function vitals(player: PlayerView): PlayerView {
  return {
    ...player,
    health: { ...player.health, current: nudge(player.health.current, player.health.max) },
    prayer: { ...player.prayer, current: nudge(player.prayer.current, player.prayer.max) },
    summoning: {
      ...player.summoning,
      current: nudge(player.summoning.current, player.summoning.max),
    },
    lastSeen: new Date().toISOString(),
  };
}

function shuffleStacks(stacks: ItemStack[], slots: number): ItemStack[] {
  if (!stacks.length) return stacks;
  const next = [...stacks];
  for (let n = 0; n < slots; n += 1) {
    const index = Math.floor(Math.random() * next.length);
    const current = next[index]!;
    next[index] =
      Math.random() < 0.5
        ? { ...current, id: pick(LOOT) }
        : { ...current, quantity: Math.max(1, Math.round(current.quantity * (0.5 + Math.random()))) };
  }
  return next;
}

/** Mirrors a shuffle onto the slot view so the fixed grids move with it. */
function shuffleSlots(
  slots: Array<ItemStack | null>,
  changes: number,
): Array<ItemStack | null> {
  const filled = slots.filter((slot): slot is ItemStack => slot !== null);
  if (!filled.length) return slots;
  const shuffled = shuffleStacks(filled, changes);
  let next = 0;
  return slots.map((slot) => (slot === null ? null : (shuffled[next++] ?? slot)));
}

function items(player: PlayerView): PlayerView {
  const touchEquipment = Math.random() < 0.35 && player.equipment.length > 0;
  return {
    ...player,
    inventory: touchEquipment ? player.inventory : shuffleStacks(player.inventory, 2),
    equipment: touchEquipment ? shuffleStacks(player.equipment, 1) : player.equipment,
    inventorySlots: touchEquipment ? player.inventorySlots : shuffleSlots(player.inventorySlots, 2),
    equipmentSlots: touchEquipment ? shuffleSlots(player.equipmentSlots, 1) : player.equipmentSlots,
    lastSeen: new Date().toISOString(),
  };
}

/**
 * Moves the money pouch so the coin counter has something to animate. Weighted
 * towards gains, with the occasional spend, and never below zero.
 */
function coins(player: PlayerView): PlayerView {
  // A spend is capped at what is actually in the pouch, so the total drifts
  // around instead of pinning to zero and swallowing every other change.
  const spendable = Math.min(player.moneyPouch, 2500);
  const gain = spendable < 100 || Math.random() < 0.6;
  const amount = gain
    ? Math.round(50 + Math.random() * 4000)
    : -Math.round(50 + Math.random() * spendable);
  const moneyPouch = Math.max(0, player.moneyPouch + amount);
  if (moneyPouch === player.moneyPouch) return player;
  return { ...player, moneyPouch, lastSeen: new Date().toISOString() };
}

function presence(player: PlayerView): PlayerView {
  const online = !player.online;
  return {
    ...player,
    online,
    world: online ? 1 + Math.floor(Math.random() * 140) : player.world,
    lastSeen: new Date().toISOString(),
  };
}

/**
 * Only online members do anything; an offline one can do nothing but log back
 * in. Every online member is stepped on every tick and each effect rolls
 * independently, so a tick can move several people while XP, vitals and loot
 * all land at once.
 */
export function stepPlayer(
  player: PlayerView,
  headings: Map<string, Heading>,
  onlineCount: number,
  log: DemoXpTotals,
): PlayerView {
  if (!player.online) {
    headings.delete(player.name);
    return Math.random() < 0.02 ? presence(player) : player;
  }

  let next = player;
  if (Math.random() < 0.85) next = move(next, headings);
  if (Math.random() < 0.35) next = gainXp(next, log);
  if (Math.random() < 0.3) next = vitals(next);
  if (Math.random() < 0.12) next = items(next);
  if (Math.random() < 0.22) next = coins(next);
  // Never log out the last member, or the demo would go quiet for good.
  if (onlineCount > 1 && Math.random() < 0.012) next = presence(next);
  return next;
}

export function cloneTotals(totals: DemoXpTotals): DemoXpTotals {
  const out: DemoXpTotals = {};
  for (const name of Object.keys(totals)) out[name] = { ...totals[name] };
  return out;
}
