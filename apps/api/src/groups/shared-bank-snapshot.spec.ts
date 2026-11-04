import { AppearanceTheme, GroupMode } from '@prisma/client';
import { GamevalsService } from '../gamevals/gamevals.service';
import { QuestCatalogService } from '../gamevals/quest-catalog.service';
import { PrismaService } from '../prisma/prisma.service';
import { GroupAccessService } from './group-access.service';
import { GroupsService } from './groups.service';
import { XpHistoryService } from './xp-history.service';
import type { PlayerVerificationService } from './player-verification.service';
import { RareItemsService } from '../items/rare-items.service';

const TOKEN = 'group-token-value';
const MEMBER = 'IronJackery';

/**
 * The plugin sends the group storage as a full snapshot every time it is open
 * and its contents differ. An empty snapshot is as real as any other: it is
 * what the group emptying its storage looks like.
 */
function makeService(
  storedShared: Array<{ slot: number; itemId: number; quantity: number }>,
) {
  const tx = {
    member: {
      update: jest.fn().mockResolvedValue({ id: 'm1' }),
      create: jest.fn().mockResolvedValue({ id: 'm1' }),
    },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    groupInventory: {
      findUnique: jest.fn().mockResolvedValue({ contentHash: 'stale' }),
      upsert: jest.fn().mockResolvedValue({ id: 'ginv1' }),
    },
    groupInventoryItem: {
      findMany: jest.fn().mockResolvedValue(storedShared),
      deleteMany: jest.fn().mockResolvedValue({ count: storedShared.length }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    sharedBankEntry: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
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

  return { groups, tx };
}

function rareItems() {
  const service = new RareItemsService();
  service.load('data/rare-items.json');
  return service;
}

describe('shared_bank snapshots', () => {
  it('an empty snapshot clears the stored storage and logs the withdrawals', async () => {
    const { groups, tx } = makeService([
      { slot: 0, itemId: 1234, quantity: 50 },
      { slot: 1, itemId: 4151, quantity: 1 },
    ]);

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      shared_bank: [],
    });

    expect(tx.groupInventoryItem.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.groupInventoryItem.createMany).not.toHaveBeenCalled();
    expect(tx.sharedBankEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            itemId: 1234,
            delta: -50,
            memberName: MEMBER,
          }),
          expect.objectContaining({
            itemId: 4151,
            delta: -1,
            memberName: MEMBER,
          }),
        ],
      }),
    );
  });

  it('an absent field leaves the storage alone', async () => {
    const { groups, tx } = makeService([
      { slot: 0, itemId: 1234, quantity: 50 },
    ]);

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      coordinates: [3200, 3200, 0],
    });

    expect(tx.groupInventoryItem.deleteMany).not.toHaveBeenCalled();
    expect(tx.sharedBankEntry.createMany).not.toHaveBeenCalled();
  });
});
