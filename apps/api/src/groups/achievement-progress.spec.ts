import { AppearanceTheme, GroupMode } from '@prisma/client';
import { GroupChangeNotifier } from './group-change-notifier.service';
import { GamevalsService } from '../gamevals/gamevals.service';
import { PrismaService } from '../prisma/prisma.service';
import { GroupAccessService } from './group-access.service';
import { GroupAchievementsService } from './achievements.service';
import { RareItemsService } from '../items/rare-items.service';

const TOKEN = 'group-token-value';
const MEMBER = 'IronJackery';

type FeedRow = { title: string; gameval: string; memberName: string };

/**
 * The plugin sends every completed achievement on login and only the new ones
 * afterwards. The first sync must establish a baseline silently; later ones
 * post to the group feed.
 */
function makeService(stored: string[]) {
  const tx = {
    memberAchievement: {
      findMany: jest.fn(() =>
        Promise.resolve(stored.map((gameval) => ({ gameval }))),
      ),
      createMany: jest.fn<Promise<unknown>, [{ data: unknown[] }]>(() =>
        Promise.resolve({ count: 0 }),
      ),
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
    memberAchievementTally: {
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
      upsert: jest.fn(() => Promise.resolve({})),
    },
    achievement: {
      createMany: jest.fn<Promise<unknown>, [{ data: FeedRow[] }]>(() =>
        Promise.resolve({ count: 0 }),
      ),
    },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
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

  const gamevals = new GamevalsService();
  gamevals.onModuleInit();
  const groups = new GroupAchievementsService(
    prisma,
    new GroupAccessService(prisma),
    gamevals,
    rareItems(),
    new GroupChangeNotifier(),
  );
  return { groups, tx };
}

const feedTitles = (tx: ReturnType<typeof makeService>['tx']) =>
  tx.achievement.createMany.mock.calls.flatMap((call) =>
    call[0].data.map((row) => row.title),
  );

function rareItems() {
  const service = new RareItemsService();
  service.load('data/rare-items.json');
  return service;
}

describe('achievement sync', () => {
  it('a first sync stores everything and posts nothing to the feed', async () => {
    const { groups, tx } = makeService([]);

    const result = await groups.updateMemberAchievements('Group', TOKEN, {
      name: MEMBER,
      completed: [{ gameval: 'cheevo_all_quests' }, { achievement_id: 2 }],
      full: true,
    });

    expect(tx.memberAchievement.createMany.mock.calls[0][0].data).toHaveLength(
      2,
    );
    expect(tx.achievement.createMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ added: 2, removed: 0, baseline: true });
  });

  it('a later completion posts to the feed with a readable title', async () => {
    const { groups, tx } = makeService(['quest_cooks_assistant']);

    const result = await groups.updateMemberAchievements('Group', TOKEN, {
      name: MEMBER,
      completed: [
        { gameval: 'quest_cooks_assistant' },
        { gameval: 'cheevo_all_quests' },
      ],
    });

    expect(feedTitles(tx)).toEqual(['All quests']);
    expect(result).toMatchObject({ added: 1, baseline: false });
  });

  it('a quest mirror is stored but kept out of the feed', async () => {
    const { groups, tx } = makeService(['cheevo_all_quests']);

    await groups.updateMemberAchievements('Group', TOKEN, {
      name: MEMBER,
      completed: [
        { gameval: 'cheevo_all_quests' },
        { gameval: 'quest_cooks_assistant' },
      ],
    });

    expect(tx.memberAchievement.createMany.mock.calls[0][0].data).toHaveLength(
      1,
    );
    expect(tx.achievement.createMany).not.toHaveBeenCalled();
  });

  it('resending the same list writes nothing', async () => {
    const { groups, tx } = makeService(['cheevo_all_quests']);

    const result = await groups.updateMemberAchievements('Group', TOKEN, {
      name: MEMBER,
      completed: [{ gameval: 'cheevo_all_quests' }],
      full: true,
    });

    expect(tx.memberAchievement.createMany).not.toHaveBeenCalled();
    expect(tx.memberAchievement.deleteMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ added: 0, removed: 0 });
  });

  it('a full snapshot clears a completion it omits', async () => {
    const { groups, tx } = makeService([
      'cheevo_all_quests',
      'miniquest_abyss',
    ]);

    const result = await groups.updateMemberAchievements('Group', TOKEN, {
      name: MEMBER,
      completed: [{ gameval: 'cheevo_all_quests' }],
      full: true,
    });

    expect(tx.memberAchievement.deleteMany).toHaveBeenCalledWith({
      where: { memberId: 'm1', gameval: { in: ['miniquest_abyss'] } },
    });
    expect(result).toMatchObject({ removed: 1 });
  });

  it('opting out of the feed still stores the completion', async () => {
    const { groups, tx } = makeService(['miniquest_abyss']);

    await groups.updateMemberAchievements('Group', TOKEN, {
      name: MEMBER,
      completed: [{ gameval: 'cheevo_all_quests' }],
      achievements: false,
    });

    expect(tx.memberAchievement.createMany).toHaveBeenCalledTimes(1);
    expect(tx.achievement.createMany).not.toHaveBeenCalled();
  });

  it('reports unknown references as a count without failing', async () => {
    const { groups } = makeService([]);

    const result = await groups.updateMemberAchievements('Group', TOKEN, {
      name: MEMBER,
      completed: [
        { gameval: 'cheevo_all_quests' },
        { achievement_id: 999_999 },
      ],
    });

    expect(result).toMatchObject({ skipped: 1 });
  });
});
