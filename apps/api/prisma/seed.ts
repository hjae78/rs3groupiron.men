import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WIRE_INVENTORIES, pairsToRows } from '../src/groups/item-codec';
import { normalizeSeedSkills } from '../src/groups/skill-codec';
import { buildSyntheticXpSamples } from '../src/groups/xp-history.service';

const SHARED = '@SHARED';

type SeedFile = {
  groups: Array<{
    name: string;
    token: string;
    mode?: 'normal' | 'competitive';
    appearance?: 'rs3' | 'modern';
    member_slots?: number;
    created_at?: string;
    members: Array<{
      name: string;
      nickname?: string;
      discord_id?: string;
      color?: string;
      use_discord_avatar?: boolean;
      online?: boolean;
      last_updated?: string;
      stats?: number[];
      coordinates?: number[];
      inventory?: number[];
      bank?: number[];
      equipment?: number[];
      shared_bank?: number[];
      skills?: Record<
        string,
        number | { xp?: number; level?: number; baseLevel?: number }
      >;
    }>;
  }>;
};

function stats(statsArr: number[] | undefined) {
  return {
    hpCurrent: statsArr?.[0] ?? 0,
    hpMax: statsArr?.[1] ?? 0,
    prayerCurrent: statsArr?.[2] ?? 0,
    prayerMax: statsArr?.[3] ?? 0,
    summonCurrent: statsArr?.[4] ?? 0,
    summonMax: statsArr?.[5] ?? 0,
    world: statsArr?.[6] ?? 0,
    weight: statsArr?.[7] ?? 0,
  };
}

function coords(c: number[] | undefined) {
  return { x: c?.[0] ?? 0, y: c?.[1] ?? 0, plane: c?.[2] ?? 0 };
}

async function main() {
  const prisma = new PrismaClient();
  const seedPath = join(process.cwd(), 'data', 'seed.json');
  if (!existsSync(seedPath)) {
    throw new Error(`Missing seed file at ${seedPath}`);
  }

  const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as SeedFile;

  await prisma.skillXpSample.deleteMany();
  await prisma.memberSkill.deleteMany();
  await prisma.memberInventoryItem.deleteMany();
  await prisma.memberInventory.deleteMany();
  await prisma.groupInventoryItem.deleteMany();
  await prisma.groupInventory.deleteMany();
  await prisma.member.deleteMany();
  await prisma.group.deleteMany();
  await prisma.player.deleteMany();

  for (const group of seed.groups) {
    const created = await prisma.group.create({
      data: {
        name: group.name,
        nameKey: group.name.toLowerCase(),
        token: group.token,
        mode: group.mode === 'competitive' ? 'competitive' : 'normal',
        appearance: group.appearance === 'modern' ? 'modern' : 'rs3',
        memberSlots: (() => {
          const playable = group.members.filter(
            (m) => m.name !== SHARED,
          ).length;
          const slots = group.member_slots ?? playable;
          return Math.min(5, Math.max(2, slots || 2));
        })(),
        createdAt: group.created_at ? new Date(group.created_at) : undefined,
      },
    });

    for (const member of group.members) {
      // The seed still describes the shared bank as a "@SHARED" member for
      // readability; it is stored as the group's bank inventory.
      if (member.name === SHARED) {
        const pairs = member.bank?.length ? member.bank : member.shared_bank;
        const items = pairsToRows(pairs, WIRE_INVENTORIES.bank);
        if (items.length) {
          const inventory = await prisma.groupInventory.create({
            data: {
              groupId: created.id,
              key: WIRE_INVENTORIES.bank,
              updatedAt: member.last_updated
                ? new Date(member.last_updated)
                : new Date(),
            },
            select: { id: true },
          });
          await prisma.groupInventoryItem.createMany({
            data: items.map((item) => ({ ...item, inventoryId: inventory.id })),
          });
        }
        continue;
      }

      const player = await prisma.player.create({
        data: {
          currentUsername: member.name,
          usernameKey: member.name.toLowerCase(),
          usernameHistory: { create: { username: member.name } },
        },
        select: { id: true },
      });

      const row = await prisma.member.create({
        data: {
          groupId: created.id,
          playerId: player.id,
          name: member.name,
          nickname: member.nickname?.trim() || null,
          discordId: member.discord_id?.trim() || null,
          color: member.color?.trim() || null,
          useDiscordAvatar: member.use_discord_avatar !== false,
          online: member.online === true,
          lastUpdated: member.last_updated
            ? new Date(member.last_updated)
            : new Date(),
          ...stats(member.stats),
          ...coords(member.coordinates),
        },
      });

      // One inventory row per wire field that has contents; items hang off it.
      for (const [field, key] of Object.entries(WIRE_INVENTORIES)) {
        const items = pairsToRows(
          member[field as keyof typeof WIRE_INVENTORIES],
          key,
        );
        if (!items.length) continue;
        const inventory = await prisma.memberInventory.create({
          data: { memberId: row.id, key },
          select: { id: true },
        });
        await prisma.memberInventoryItem.createMany({
          data: items.map((item) => ({ ...item, inventoryId: inventory.id })),
        });
      }

      const skillRows = normalizeSeedSkills(member.skills).map((skill) => ({
        ...skill,
        memberId: row.id,
      }));
      if (skillRows.length) {
        await prisma.memberSkill.createMany({ data: skillRows });
        const samples = buildSyntheticXpSamples(
          row.id,
          skillRows.map((s) => ({ skillId: s.skillId, xp: s.xp })),
        );
        if (samples.length) {
          await prisma.skillXpSample.createMany({ data: samples });
        }
      }
    }
  }

  console.log(`Seeded ${seed.groups.length} group(s) from data/seed.json`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
