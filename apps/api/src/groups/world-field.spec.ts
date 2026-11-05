import { AppearanceTheme, GroupMode } from '@prisma/client';
import { GroupChangeNotifier } from './group-change-notifier.service';
import { GamevalsService } from '../gamevals/gamevals.service';
import { PrismaService } from '../prisma/prisma.service';
import { GroupAccessService } from './group-access.service';
import { GroupsService } from './groups.service';
import { InventoryStorageService } from './inventory-storage.service';
import { statsFromArray } from './item-codec';
import { XpHistoryService } from './xp-history.service';
import type { PlayerVerificationService } from './player-verification.service';

const TOKEN = 'group-token-value';
const MEMBER = 'IronJackery';

type MemberUpdate = { data: Record<string, unknown> };

function makeService() {
  const tx = {
    member: {
      update: jest.fn<Promise<{ id: string }>, [MemberUpdate]>(() =>
        Promise.resolve({ id: 'm1' }),
      ),
    },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
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
  const xpHistory = {
    recordXpSamples: jest.fn().mockResolvedValue(undefined),
  } as unknown as XpHistoryService;
  const groups = new GroupsService(
    prisma,
    new GroupAccessService(prisma),
    xpHistory,
    new GamevalsService(),
    {} as PlayerVerificationService,
    new GroupChangeNotifier(),
    new InventoryStorageService(xpHistory),
  );
  return { groups, tx };
}

describe('statsFromArray world slot', () => {
  it('omits world when the array has only the six vitals', () => {
    expect(statsFromArray([100, 990, 10, 100, 1, 10])).not.toHaveProperty(
      'world',
    );
  });

  it('writes world when the array carries a seventh element', () => {
    expect(statsFromArray([100, 990, 10, 100, 1, 10, 84])).toMatchObject({
      world: 84,
    });
  });
});

describe('world field', () => {
  it('is stored on its own', async () => {
    const { groups, tx } = makeService();

    const result = await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      world: 84,
    });

    expect(tx.member.update.mock.calls[0][0].data).toMatchObject({ world: 84 });
    expect(result).toMatchObject({ applied: ['world'] });
  });

  /** The plugin sends six-element vitals, which must not clear the world. */
  it('survives a vitals update that omits it', async () => {
    const { groups, tx } = makeService();

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      stats: [100, 990, 10, 100, 1, 10],
    });

    expect(tx.member.update.mock.calls[0][0].data).not.toHaveProperty('world');
  });

  it('overrides the seventh stats element when both are sent', async () => {
    const { groups, tx } = makeService();

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      stats: [100, 990, 10, 100, 1, 10, 1],
      world: 84,
    });

    expect(tx.member.update.mock.calls[0][0].data).toMatchObject({ world: 84 });
  });
});
