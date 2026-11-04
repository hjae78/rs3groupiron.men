import { GamevalsService } from '../gamevals/gamevals.service';
import { QuestCatalogService } from '../gamevals/quest-catalog.service';
import { PrismaService } from '../prisma/prisma.service';
import { GroupAccessService } from './group-access.service';
import { GroupsService } from './groups.service';
import { XpHistoryService } from './xp-history.service';
import type { PlayerVerificationService } from './player-verification.service';
import { RareItemsService } from '../items/rare-items.service';

const GROUP = 'group-1';

/**
 * Counts member reads, the first query of every payload build, so it stands in
 * for "how many times did the expensive path actually run".
 */
function makeService() {
  const memberFindMany = jest.fn().mockResolvedValue([]);
  const prisma = {
    member: { findMany: memberFindMany },
    memberInventory: { findMany: jest.fn().mockResolvedValue([]) },
    memberSkill: { findMany: jest.fn().mockResolvedValue([]) },
    groupInventory: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;

  const groups = new GroupsService(
    prisma,
    new GroupAccessService(prisma),
    {} as XpHistoryService,
    new GamevalsService(),
    new QuestCatalogService(),
    rareItems(),
    {} as PlayerVerificationService,
  );
  return { groups, memberFindMany };
}

function rareItems() {
  const service = new RareItemsService();
  service.load('data/rare-items.json');
  return service;
}

describe('full snapshot sharing', () => {
  it('builds once for callers arriving together', async () => {
    const { groups, memberFindMany } = makeService();

    await Promise.all(
      Array.from({ length: 25 }, () => groups.buildGroupData(GROUP, 0)),
    );

    expect(memberFindMany).toHaveBeenCalledTimes(1);
  });

  it('builds once for callers arriving within the window', async () => {
    const { groups, memberFindMany } = makeService();

    await groups.buildGroupData(GROUP, 0);
    await groups.buildGroupData(GROUP, 0);

    expect(memberFindMany).toHaveBeenCalledTimes(1);
  });

  // `split` only changes the payload when `since` is set, so a full build must
  // not be duplicated per split flag.
  it('shares one build across both split flags', async () => {
    const { groups, memberFindMany } = makeService();

    await groups.buildGroupData(GROUP, 0, true);
    await groups.buildGroupData(GROUP, 0, false);

    expect(memberFindMany).toHaveBeenCalledTimes(1);
  });

  it('keeps groups separate', async () => {
    const { groups, memberFindMany } = makeService();

    await groups.buildGroupData(GROUP, 0);
    await groups.buildGroupData('group-2', 0);

    expect(memberFindMany).toHaveBeenCalledTimes(2);
  });

  // The live map runs on deltas; caching those would freeze player positions.
  it('never caches a delta', async () => {
    const { groups, memberFindMany } = makeService();

    await groups.buildGroupData(GROUP, 1_000, true);
    await groups.buildGroupData(GROUP, 1_000, true);

    expect(memberFindMany).toHaveBeenCalledTimes(2);
  });

  it('rebuilds once the window has passed', async () => {
    const { groups, memberFindMany } = makeService();
    const realNow = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(realNow);

    await groups.buildGroupData(GROUP, 0);
    now.mockReturnValue(realNow + 1_001);
    await groups.buildGroupData(GROUP, 0);

    expect(memberFindMany).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  // A rejected build must not be handed to everyone asking for the rest of the
  // window; the next caller should get a fresh attempt.
  it('does not cache a failed build', async () => {
    const { groups, memberFindMany } = makeService();
    memberFindMany.mockRejectedValueOnce(new Error('connection lost'));

    await expect(groups.buildGroupData(GROUP, 0)).rejects.toThrow(
      'connection lost',
    );
    await expect(groups.buildGroupData(GROUP, 0)).resolves.toEqual([]);

    expect(memberFindMany).toHaveBeenCalledTimes(2);
  });
});
