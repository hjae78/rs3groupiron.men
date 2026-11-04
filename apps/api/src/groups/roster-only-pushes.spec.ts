import { NotFoundException } from '@nestjs/common';
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

/**
 * The group token is shared by every member, so a plugin push must never be
 * able to grow the roster: a member logged into an alt would otherwise add
 * that alt to the group. Pushes update known names only.
 */
function makeService() {
  const tx = {
    member: {
      update: jest.fn().mockResolvedValue({ id: 'm1' }),
      create: jest.fn().mockResolvedValue({ id: 'm2' }),
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
          members: [{ id: 'm1', name: 'IronJackery' }],
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

describe('plugin pushes and the roster', () => {
  it('rejects an unknown name with 404 and creates nothing', async () => {
    const { groups, tx } = makeService();

    await expect(
      groups.updateGroupMember('Group', TOKEN, {
        name: 'SomeAlt',
        coordinates: [3200, 3200, 0],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(tx.member.create).not.toHaveBeenCalled();
    expect(tx.member.update).not.toHaveBeenCalled();
  });

  it('matches roster names case-insensitively', async () => {
    const { groups, tx } = makeService();

    await groups.updateGroupMember('Group', TOKEN, {
      name: 'ironjackery',
      coordinates: [3200, 3200, 0],
    });

    expect(tx.member.update).toHaveBeenCalledTimes(1);
    expect(tx.member.create).not.toHaveBeenCalled();
  });
});
