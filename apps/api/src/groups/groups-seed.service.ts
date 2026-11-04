import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isProduction, seedDemo } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { buildSyntheticAchievements } from './achievements';
import { groupNameKey } from './group-access.service';
import {
  normalizeColor,
  normalizeDiscordId,
  normalizeNickname,
  normalizeUseDiscordAvatar,
  parseAppearance,
  parseGroupMode,
  playableCount,
} from './group-fields';
import {
  MAX_MEMBERS,
  MIN_MEMBERS,
  SHARED_MEMBER,
  type StoreFile,
} from './group.types';
import {
  WIRE_INVENTORIES,
  coordsFromArray,
  pairsToRows,
  statsFromArray,
  totalsByItemId,
} from './item-codec';
import { normalizeSeedSkills } from './skill-codec';
import { XpHistoryService } from './xp-history.service';

/** Rows per createMany chunk. One statement per table would exceed Postgres' parameter limit. */
const SEED_CHUNK = 5000;

/**
 * Demo data for an empty database, plus the dev-only reset endpoint behind it.
 *
 * Separate from GroupsService because none of it runs on a path players hit: it
 * is bulk-insert plumbing that would otherwise be a fifth of the file serving
 * live traffic.
 */
@Injectable()
export class GroupsSeedService implements OnModuleInit {
  private readonly logger = new Logger(GroupsSeedService.name);
  private readonly seedPath = join(process.cwd(), 'data', 'seed.json');

  constructor(
    private readonly prisma: PrismaService,
    private readonly xpHistory: XpHistoryService,
  ) {}

  async onModuleInit() {
    try {
      await this.seedIfEmpty();
    } catch (err) {
      // A failed seed must not stop the API booting, but it has to be visible:
      // the alternative is an empty database that looks like an app bug.
      this.logger.error('demo seed failed; starting without it', err);
    }
  }

  async resetFromSeed() {
    if (!existsSync(this.seedPath)) {
      throw new NotFoundException('data/seed.json missing');
    }
    const seed = JSON.parse(readFileSync(this.seedPath, 'utf8')) as StoreFile;

    // Build every row up front (ids generated here so FKs can be wired without
    // round-trips), then bulk insert per table inside one transaction.
    const groupRows: Prisma.GroupCreateManyInput[] = [];
    const memberRows: Prisma.MemberCreateManyInput[] = [];
    const playerRows: Prisma.PlayerCreateManyInput[] = [];
    const playerUsernameHistoryRows: Prisma.PlayerUsernameHistoryCreateManyInput[] =
      [];
    const inventoryRows: Prisma.MemberInventoryCreateManyInput[] = [];
    const itemRows: Prisma.MemberInventoryItemCreateManyInput[] = [];
    const groupInventoryRows: Prisma.GroupInventoryCreateManyInput[] = [];
    const groupItemRows: Prisma.GroupInventoryItemCreateManyInput[] = [];
    const skillRows: Prisma.MemberSkillCreateManyInput[] = [];
    const sampleRows: Prisma.SkillXpSampleCreateManyInput[] = [];
    const ledgerRows: Prisma.SharedBankEntryCreateManyInput[] = [];
    const achievementRows: Prisma.AchievementCreateManyInput[] = [];
    const seedNow = new Date();

    for (const group of seed.groups) {
      const playable = playableCount(group.members);
      const slots = Math.min(
        MAX_MEMBERS,
        Math.max(MIN_MEMBERS, group.member_slots ?? playable ?? MIN_MEMBERS),
      );

      const groupId = randomUUID();
      groupRows.push({
        id: groupId,
        name: group.name,
        nameKey: groupNameKey(group.name),
        // Never use the token from seed.json: it is committed to the repo, so
        // a fresh random one keeps seeded groups from having a public
        // credential. The demo group is read-only and needs no token anyway.
        token: randomUUID(),
        mode: parseGroupMode(group.mode),
        appearance: parseAppearance(group.appearance),
        memberSlots: slots,
        createdAt: group.created_at ? new Date(group.created_at) : undefined,
      });

      for (const member of group.members) {
        // The seed still describes the shared bank as a "@SHARED" member for
        // readability; it is stored as the group's bank inventory.
        if (member.name === SHARED_MEMBER) {
          const pairs = member.bank?.length ? member.bank : member.shared_bank;
          const items = pairsToRows(pairs, WIRE_INVENTORIES.bank);
          if (items.length) {
            const inventoryId = randomUUID();
            groupInventoryRows.push({
              id: inventoryId,
              groupId,
              key: WIRE_INVENTORIES.bank,
              updatedAt: member.last_updated
                ? new Date(member.last_updated)
                : seedNow,
            });
            for (const item of items)
              groupItemRows.push({ ...item, inventoryId });
          }
          continue;
        }

        const memberId = randomUUID();
        let discordId: string | null = null;
        try {
          discordId = normalizeDiscordId(member.discord_id);
        } catch {
          discordId = null;
        }
        let color: string | null = null;
        try {
          color = normalizeColor(member.color);
        } catch {
          color = null;
        }

        const playerId = randomUUID();
        playerRows.push({
          id: playerId,
          currentUsername: member.name,
          usernameKey: member.name.toLowerCase(),
          createdAt: member.last_updated
            ? new Date(member.last_updated)
            : seedNow,
        });
        playerUsernameHistoryRows.push({
          id: randomUUID(),
          playerId,
          username: member.name,
          firstSeenAt: member.last_updated
            ? new Date(member.last_updated)
            : seedNow,
          lastSeenAt: member.last_updated
            ? new Date(member.last_updated)
            : seedNow,
        });

        memberRows.push({
          id: memberId,
          groupId,
          playerId,
          name: member.name,
          nickname: normalizeNickname(member.nickname),
          discordId,
          color,
          useDiscordAvatar: normalizeUseDiscordAvatar(
            member.use_discord_avatar,
          ),
          online: member.online === true,
          lastUpdated: member.last_updated
            ? new Date(member.last_updated)
            : seedNow,
          ...statsFromArray(member.stats),
          ...coordsFromArray(member.coordinates),
        });

        for (const [field, key] of Object.entries(WIRE_INVENTORIES)) {
          const pairs = member[field as keyof typeof WIRE_INVENTORIES];
          const items = pairsToRows(pairs, key);
          if (!items.length) continue;
          const inventoryId = randomUUID();
          inventoryRows.push({
            id: inventoryId,
            memberId,
            key,
            updatedAt: seedNow,
          });
          for (const item of items) itemRows.push({ ...item, inventoryId });
        }

        const skills = normalizeSeedSkills(member.skills);
        for (const skill of skills) {
          skillRows.push({ ...skill, memberId });
        }
        if (skills.length) {
          sampleRows.push(
            ...this.xpHistory.buildSyntheticSamples(
              memberId,
              skills.map((s) => ({ skillId: s.skillId, xp: s.xp })),
              seedNow,
            ),
          );
        }
      }

      // Synthetic shared-bank movement history so the demo shows a real ledger.
      const sharedSeed = group.members.find((m) => m.name === SHARED_MEMBER);
      const sharedItemIds = [
        ...totalsByItemId(sharedSeed?.bank ?? sharedSeed?.shared_bank).keys(),
      ];
      const playerNames = group.members
        .filter((m) => m.name !== SHARED_MEMBER)
        .map((m) => m.name);
      ledgerRows.push(
        ...buildSyntheticLedgerEntries(
          groupId,
          group.name,
          playerNames,
          sharedItemIds,
          seedNow,
        ),
      );

      // Synthetic achievement history. Drops reference item ids that really
      // exist somewhere in this group's data.
      const groupItemIds = new Set<number>(sharedItemIds);
      for (const member of group.members) {
        for (const id of totalsByItemId(member.bank).keys()) {
          groupItemIds.add(id);
        }
        for (const id of totalsByItemId(member.equipment).keys()) {
          groupItemIds.add(id);
        }
      }
      achievementRows.push(
        ...buildSyntheticAchievements(
          groupId,
          group.name,
          playerNames,
          [...groupItemIds],
          seedNow,
        ),
      );
    }

    await this.prisma.$transaction(
      async (tx) => {
        // Cascades handle members/items/skills/samples, but be explicit.
        await tx.achievement.deleteMany();
        await tx.sharedBankEntry.deleteMany();
        await tx.skillXpSample.deleteMany();
        await tx.memberSkill.deleteMany();
        await tx.memberInventoryItem.deleteMany();
        await tx.memberInventory.deleteMany();
        await tx.groupInventoryItem.deleteMany();
        await tx.groupInventory.deleteMany();
        await tx.member.deleteMany();
        await tx.group.deleteMany();
        await tx.player.deleteMany();

        if (groupRows.length) await tx.group.createMany({ data: groupRows });
        if (playerRows.length) await tx.player.createMany({ data: playerRows });
        if (playerUsernameHistoryRows.length) {
          await tx.playerUsernameHistory.createMany({
            data: playerUsernameHistoryRows,
          });
        }
        if (memberRows.length) await tx.member.createMany({ data: memberRows });
        for (const chunk of chunked(inventoryRows, SEED_CHUNK)) {
          await tx.memberInventory.createMany({ data: chunk });
        }
        for (const chunk of chunked(itemRows, SEED_CHUNK)) {
          await tx.memberInventoryItem.createMany({ data: chunk });
        }
        if (groupInventoryRows.length) {
          await tx.groupInventory.createMany({ data: groupInventoryRows });
        }
        for (const chunk of chunked(groupItemRows, SEED_CHUNK)) {
          await tx.groupInventoryItem.createMany({ data: chunk });
        }
        for (const chunk of chunked(skillRows, SEED_CHUNK)) {
          await tx.memberSkill.createMany({ data: chunk });
        }
        for (const chunk of chunked(sampleRows, SEED_CHUNK)) {
          await tx.skillXpSample.createMany({ data: chunk });
        }
        for (const chunk of chunked(ledgerRows, SEED_CHUNK)) {
          await tx.sharedBankEntry.createMany({ data: chunk });
        }
        for (const chunk of chunked(achievementRows, SEED_CHUNK)) {
          await tx.achievement.createMany({ data: chunk });
        }
      },
      { maxWait: 10_000, timeout: 120_000 },
    );

    return { ok: true, groups: seed.groups.length };
  }

  /** Seeds demo data only into a database with no groups at all. */
  async seedIfEmpty() {
    if (isProduction() && !seedDemo()) return;
    const count = await this.prisma.group.count();
    if (count === 0 && existsSync(this.seedPath)) {
      await this.resetFromSeed();
    }
  }
}

/** Window covered by the synthetic demo ledger. */
const LEDGER_SEED_DAYS = 14;
const LEDGER_SEED_MIN = 40;
const LEDGER_SEED_SPREAD = 21; // 40–60 entries

function seedHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Plausible shared-bank movements over the last ~14 days, spread across the
 * group's real members and the item ids actually present in its shared bank.
 * Deterministic (hashed off the group name) so reseeding is reproducible.
 */
export function buildSyntheticLedgerEntries(
  groupId: string,
  groupName: string,
  memberNames: string[],
  itemIds: number[],
  endAt = new Date(),
): Prisma.SharedBankEntryCreateManyInput[] {
  if (!memberNames.length || !itemIds.length) return [];

  const base = seedHash(groupName);
  const count = LEDGER_SEED_MIN + (base % LEDGER_SEED_SPREAD);
  const windowMs = LEDGER_SEED_DAYS * 24 * 60 * 60 * 1000;
  const rows: Prisma.SharedBankEntryCreateManyInput[] = [];

  for (let i = 0; i < count; i++) {
    const h = seedHash(`${groupName}:${i}`);
    const memberName =
      memberNames[seedHash(`m${i}${groupName}`) % memberNames.length];
    const itemId = itemIds[seedHash(`i${i}${groupName}`) % itemIds.length];
    // ~65% deposits, 35% withdrawals.
    const deposit = seedHash(`d${i}${groupName}`) % 100 < 65;
    const magnitude = 1 + (seedHash(`q${i}${groupName}`) % 40);
    // Coins-like stackables move in much larger amounts.
    const scale =
      itemId === 995 ? 25_000 * (1 + (seedHash(`s${i}${groupName}`) % 40)) : 1;
    const delta = (deposit ? 1 : -1) * magnitude * scale;
    // Evenly spread across the window, then jittered within its own slice so
    // the timeline looks organic instead of metronomic.
    const slice = 1 / count;
    const agoFraction = Math.min(
      1,
      (count - 1 - i) * slice + ((h % 1000) / 1000) * slice,
    );
    const createdAt = new Date(
      endAt.getTime() - Math.floor(agoFraction * windowMs),
    );
    rows.push({ groupId, memberName, itemId, delta, createdAt });
  }

  rows.sort((a, b) => +(a.createdAt as Date) - +(b.createdAt as Date));
  return rows;
}

function* chunked<T>(rows: T[], size: number): Generator<T[]> {
  for (let i = 0; i < rows.length; i += size) {
    yield rows.slice(i, i + size);
  }
}
