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

type Row = { slot: number; itemId: number; quantity: number };

/**
 * While the bank is open the plugin sends per-item deltas instead of the
 * whole bank. These must patch the stored rows, keep the content hash in
 * step, and feed the shared-storage ledger exactly like a snapshot would.
 */
function makeService(memberBank: Row[], sharedBank: Row[]) {
  const tx = {
    member: { update: jest.fn().mockResolvedValue({ id: 'm1' }) },
    memberInventory: {
      upsert: jest.fn().mockResolvedValue({ id: 'inv-bank' }),
      update: jest.fn().mockResolvedValue({ id: 'inv-bank' }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    memberInventoryItem: {
      findMany: jest.fn().mockResolvedValue(memberBank),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    groupInventory: {
      upsert: jest.fn().mockResolvedValue({ id: 'ginv-bank' }),
      update: jest.fn().mockResolvedValue({ id: 'ginv-bank' }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    groupInventoryItem: {
      findMany: jest.fn().mockResolvedValue(sharedBank),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    sharedBankEntry: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
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

const BANK: Row[] = [
  { slot: 0, itemId: 995, quantity: 1_000_000 },
  { slot: 1, itemId: 4151, quantity: 1 },
];

function rareItems() {
  const service = new RareItemsService();
  service.load('data/rare-items.json');
  return service;
}

describe('inventory_changes', () => {
  it('patches only the named items and bumps dataUpdatedAt', async () => {
    const { groups, tx } = makeService(BANK, []);

    const result = await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      inventory_changes: { bank: [995, 1_000_500, 11802, 1] },
    });

    expect(tx.memberInventoryItem.deleteMany).toHaveBeenCalledWith({
      where: { inventoryId: 'inv-bank', itemId: { in: [995] } },
    });
    expect(tx.memberInventoryItem.createMany).toHaveBeenCalledWith({
      data: [
        { slot: 0, itemId: 995, quantity: 1_000_500, inventoryId: 'inv-bank' },
        { slot: 2, itemId: 11802, quantity: 1, inventoryId: 'inv-bank' },
      ],
    });
    expect(tx.memberInventory.update).toHaveBeenCalledTimes(1);
    expect(tx.member.update).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: true,
      applied: ['inventory_changes'],
      data_changed: true,
    });
  });

  it('a delta that matches the stored totals writes nothing', async () => {
    const { groups, tx } = makeService(BANK, []);

    const result = await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      inventory_changes: { bank: [4151, 1] },
    });

    expect(tx.memberInventoryItem.deleteMany).not.toHaveBeenCalled();
    expect(tx.memberInventoryItem.createMany).not.toHaveBeenCalled();
    expect(tx.member.update).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ data_changed: false });
  });

  it('shared storage deltas feed the ledger', async () => {
    const { groups, tx } = makeService([], BANK);

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      inventory_changes: { shared_bank: [4151, 0, 1038, 3] },
    });

    expect(tx.sharedBankEntry.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ itemId: 1038, delta: 3, memberName: MEMBER }),
        expect.objectContaining({
          itemId: 4151,
          delta: -1,
          memberName: MEMBER,
        }),
      ],
    });
  });

  it('a full snapshot in the same request wins over its deltas', async () => {
    const { groups, tx } = makeService(BANK, []);

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      bank: [995, 5],
      inventory_changes: { bank: [995, 999] },
    });

    // Snapshot path: upsert + wholesale delete; the delta path never ran.
    expect(tx.memberInventoryItem.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.memberInventoryItem.deleteMany).toHaveBeenCalledWith({
      where: { inventoryId: 'inv-bank' },
    });
  });

  it('rejects deltas for the positional backpack', async () => {
    const { groups } = makeService(BANK, []);

    await expect(
      groups.updateGroupMember('Group', TOKEN, {
        name: MEMBER,
        inventory_changes: { inventory: [995, 1] },
      }),
    ).rejects.toThrow(/not a known inventory/);
  });
});
