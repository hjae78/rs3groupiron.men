import { AppearanceTheme, GroupMode, QuestState } from '@prisma/client';
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
 * A member can opt out of the group achievement feed in the plugin. The data
 * itself still syncs; only the feed entries derived from it are skipped.
 */
function makeService() {
  const tx = {
    member: { update: jest.fn().mockResolvedValue({ id: 'm1' }) },
    memberSkill: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { skillId: 'mining', xp: 737_627n, level: 60, baseLevel: 60 },
        ]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    memberQuest: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { gameval: 'cabinfever', state: QuestState.started },
        ]),
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
  // The quest path resolves gamevals, which are only loaded on module init.
  const gamevals = new GamevalsService();
  gamevals.onModuleInit();
  const questCatalog = new QuestCatalogService();
  questCatalog.onModuleInit();

  const groups = new GroupsService(
    prisma,
    new GroupAccessService(prisma),
    {
      recordXpSamples: jest.fn().mockResolvedValue(undefined),
    } as unknown as XpHistoryService,
    gamevals,
    questCatalog,
    rareItems(),
    {} as PlayerVerificationService,
  );
  return { groups, tx };
}

/** Crossing 99 Mining, which is a milestone by default. */
const MAXED_MINING = { mining: { xp: 13_034_431, level: 99 } };

function rareItems() {
  const service = new RareItemsService();
  service.load('data/rare-items.json');
  return service;
}

describe('achievements opt-out', () => {
  it('records a skill milestone by default', async () => {
    const { groups, tx } = makeService();

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      skills: MAXED_MINING,
    });

    expect(tx.achievement.createMany).toHaveBeenCalledTimes(1);
  });

  it('skips the milestone but still stores the skill when opted out', async () => {
    const { groups, tx } = makeService();

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      skills: MAXED_MINING,
      achievements: false,
    });

    expect(tx.achievement.createMany).not.toHaveBeenCalled();
    expect(tx.memberSkill.createMany).toHaveBeenCalledTimes(1);
  });

  it('skips a finished quest feed entry but still stores the quest', async () => {
    const { groups, tx } = makeService();

    await groups.updateMemberQuests('Group', TOKEN, {
      name: MEMBER,
      quests: [{ gameval: 'cabinfever', state: 'finished' }],
      achievements: false,
    });

    expect(tx.achievement.createMany).not.toHaveBeenCalled();
    expect(tx.memberQuest.createMany).toHaveBeenCalledTimes(1);
  });

  it('records a finished quest in the feed by default', async () => {
    const { groups, tx } = makeService();

    await groups.updateMemberQuests('Group', TOKEN, {
      name: MEMBER,
      quests: [{ gameval: 'cabinfever', state: 'finished' }],
    });

    expect(tx.achievement.createMany).toHaveBeenCalledTimes(1);
  });
});
