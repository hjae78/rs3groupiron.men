import { AppearanceTheme, GroupMode } from '@prisma/client';
import { GamevalsService } from '../gamevals/gamevals.service';
import { QuestCatalogService } from '../gamevals/quest-catalog.service';
import { PrismaService } from '../prisma/prisma.service';
import { GroupAccessService } from './group-access.service';
import { GroupsService } from './groups.service';
import {
  WIRE_INVENTORIES,
  inventoryContentHash,
  pairsToRows,
} from './item-codec';
import { XpHistoryService } from './xp-history.service';
import type { PlayerVerificationService } from './player-verification.service';
import { RareItemsService } from '../items/rare-items.service';

const TOKEN = 'group-token-value';
const MEMBER = 'IronJackery';
const BANK = [995, 1_000_000, 1038, 1];

/** The hash the service will compute for `pairs` under `key`. */
const hashFor = (pairs: number[], key: string) =>
  inventoryContentHash(pairsToRows(pairs, key));

/**
 * `dataUpdatedAt` is what tells a polling client "this member's inventories and
 * skills moved, re-download them". Bumping it when nothing changed makes every
 * viewer of the group re-fetch a bank for no reason; failing to bump it when
 * something did change loses the update until the next full refresh. Both
 * directions are covered here.
 */
function makeService(opts: {
  /** Stored content hashes, keyed by inventory key. */
  hashes?: Record<string, string>;
  storedSkills?: Array<{
    skillId: string;
    xp: bigint;
    level: number;
    baseLevel: number;
  }>;
}) {
  const memberUpdates: Array<Record<string, unknown>> = [];

  const tx = {
    member: {
      update: jest.fn((args: { data: Record<string, unknown> }) => {
        memberUpdates.push(args.data);
        return Promise.resolve({ id: 'm1' });
      }),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        memberUpdates.push(args.data);
        return Promise.resolve({ id: 'm1' });
      }),
    },
    $executeRaw: jest.fn((strings: readonly string[]) => {
      if (strings[0].includes('data_updated_at')) {
        memberUpdates.push({ dataUpdatedAt: true });
      }
      return Promise.resolve(1);
    }),
    memberInventory: {
      findUnique: jest.fn(
        ({ where }: { where: { memberId_key: { key: string } } }) =>
          Promise.resolve(
            opts.hashes?.[where.memberId_key.key]
              ? { contentHash: opts.hashes[where.memberId_key.key] }
              : null,
          ),
      ),
      upsert: jest.fn().mockResolvedValue({ id: 'inv1' }),
    },
    memberInventoryItem: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    memberSkill: {
      findMany: jest.fn().mockResolvedValue(opts.storedSkills ?? []),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    achievement: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };

  const prisma = {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    member: { findUnique: jest.fn().mockResolvedValue({ player: null }) },
    group: {
      findUnique: () =>
        Promise.resolve({
          id: 'g1',
          name: 'Group',
          nameKey: 'group',
          token: TOKEN,
          mode: GroupMode.normal,
          appearance: AppearanceTheme.rs3,
          memberSlots: 5,
          members: [{ id: 'm1', name: MEMBER }],
        }),
    },
  } as unknown as PrismaService;

  const groups = new GroupsService(
    prisma,
    new GroupAccessService(prisma),
    {
      recordXpSamples: jest.fn().mockResolvedValue(undefined),
    } as unknown as XpHistoryService,
    new GamevalsService(),
    new QuestCatalogService(),
    rareItems(),
    {} as PlayerVerificationService,
  );

  /** Every `dataUpdatedAt` the write path set, if any. */
  const bumps = () => memberUpdates.filter((d) => 'dataUpdatedAt' in d);
  return { groups, bumps, tx };
}

function rareItems() {
  const service = new RareItemsService();
  service.load('data/rare-items.json');
  return service;
}

describe('dataUpdatedAt', () => {
  it('is not bumped when the plugin resends an identical bank', async () => {
    const { groups, bumps, tx } = makeService({
      hashes: { [WIRE_INVENTORIES.bank]: hashFor(BANK, WIRE_INVENTORIES.bank) },
    });

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      bank: BANK,
    });

    expect(bumps()).toHaveLength(0);
    // The rows are not rewritten either.
    expect(tx.memberInventoryItem.createMany).not.toHaveBeenCalled();
  });

  it('is bumped when the bank contents change', async () => {
    const { groups, bumps } = makeService({
      hashes: { [WIRE_INVENTORIES.bank]: hashFor(BANK, WIRE_INVENTORIES.bank) },
    });

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      bank: [...BANK, 4151, 1],
    });

    expect(bumps()).toHaveLength(1);
  });

  it('is bumped the first time a bank is seen', async () => {
    const { groups, bumps } = makeService({});

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      bank: BANK,
    });

    expect(bumps()).toHaveLength(1);
  });

  it('is not bumped when skills are resent unchanged', async () => {
    const stored = [
      { skillId: 'attack', xp: 13_034_431n, level: 99, baseLevel: 99 },
    ];
    const { groups, bumps } = makeService({ storedSkills: stored });

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      skills: { attack: { xp: 13_034_431, level: 99, baseLevel: 99 } },
    });

    expect(bumps()).toHaveLength(0);
  });

  it('is bumped when xp moves', async () => {
    const stored = [
      { skillId: 'attack', xp: 13_034_431n, level: 99, baseLevel: 99 },
    ];
    const { groups, bumps } = makeService({ storedSkills: stored });

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      skills: { attack: { xp: 13_034_500, level: 99, baseLevel: 99 } },
    });

    expect(bumps()).toHaveLength(1);
  });

  it('is bumped when a new skill appears', async () => {
    const { groups, bumps } = makeService({
      storedSkills: [{ skillId: 'attack', xp: 100n, level: 10, baseLevel: 10 }],
    });

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      skills: {
        attack: { xp: 100, level: 10, baseLevel: 10 },
        mining: { xp: 50, level: 5, baseLevel: 5 },
      },
    });

    expect(bumps()).toHaveLength(1);
  });

  // A position ping must never drag the heavy payload along; that is the whole
  // point of the split delta.
  it('is not bumped by a position-only update', async () => {
    const { groups, bumps } = makeService({});

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      coordinates: [3200, 3200, 0],
    });

    expect(bumps()).toHaveLength(0);
  });

  it('is bumped by a deposit, which changes the bank', async () => {
    const { groups, bumps } = makeService({
      hashes: { [WIRE_INVENTORIES.bank]: hashFor(BANK, WIRE_INVENTORIES.bank) },
    });

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      bank: BANK,
      deposited: [1038, 5],
    });

    expect(bumps()).toHaveLength(1);
  });

  it('is bumped when one of several inventories changes', async () => {
    const { groups, bumps } = makeService({
      hashes: {
        [WIRE_INVENTORIES.bank]: hashFor(BANK, WIRE_INVENTORIES.bank),
        [WIRE_INVENTORIES.inventory]: hashFor(
          [1, 1],
          WIRE_INVENTORIES.inventory,
        ),
      },
    });

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      bank: BANK,
      inventory: [2, 2],
    });

    expect(bumps()).toHaveLength(1);
  });
});
