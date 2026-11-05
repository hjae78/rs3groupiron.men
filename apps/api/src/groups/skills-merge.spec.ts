import { AppearanceTheme, GroupMode } from '@prisma/client';
import { GroupChangeNotifier } from './group-change-notifier.service';
import { GamevalsService } from '../gamevals/gamevals.service';
import { PrismaService } from '../prisma/prisma.service';
import { GroupAccessService } from './group-access.service';
import { GroupsService } from './groups.service';
import { InventoryStorageService } from './inventory-storage.service';
import { XpHistoryService } from './xp-history.service';
import type { PlayerVerificationService } from './player-verification.service';

const TOKEN = 'group-token-value';
const MEMBER = 'IronJackery';

/**
 * The plugin sends only the skills that changed, so a skills payload is a
 * merge: skills it does not mention must survive untouched.
 */
function makeService(
  stored: Array<{
    skillId: string;
    xp: bigint;
    level: number;
    baseLevel: number;
  }>,
) {
  const tx = {
    member: { update: jest.fn().mockResolvedValue({ id: 'm1' }) },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    memberSkill: {
      findMany: jest.fn().mockResolvedValue(stored),
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

const STORED = [
  { skillId: 'attack', xp: 13_034_431n, level: 99, baseLevel: 99 },
  { skillId: 'mining', xp: 737_627n, level: 60, baseLevel: 60 },
];

describe('skills payload merging', () => {
  it('a single changed skill rewrites only that skill', async () => {
    const { groups, tx } = makeService(STORED);

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      skills: { mining: { xp: 740_000, level: 60 } },
    });

    expect(tx.memberSkill.deleteMany).toHaveBeenCalledWith({
      where: { memberId: 'm1', skillId: { in: ['mining'] } },
    });
    expect(tx.memberSkill.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ skillId: 'mining', xp: 740_000n })],
    });
  });

  it('an unchanged skill writes nothing', async () => {
    const { groups, tx } = makeService(STORED);

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      skills: { attack: { xp: 13_034_431, level: 99 } },
    });

    expect(tx.memberSkill.deleteMany).not.toHaveBeenCalled();
    expect(tx.memberSkill.createMany).not.toHaveBeenCalled();
  });

  it('a milestone is detected against the stored skill', async () => {
    const { groups, tx } = makeService(STORED);

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      skills: { mining: { xp: 13_034_431, level: 99 } },
    });

    expect(tx.achievement.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ title: '99 Mining', skillId: 'mining' }),
        ]) as unknown[],
      }),
    );
  });
});
