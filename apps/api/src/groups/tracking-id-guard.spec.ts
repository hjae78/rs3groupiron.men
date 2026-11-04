import { ForbiddenException } from '@nestjs/common';
import { AppearanceTheme, GroupMode } from '@prisma/client';
import { GamevalsService } from '../gamevals/gamevals.service';
import { QuestCatalogService } from '../gamevals/quest-catalog.service';
import { RareItemsService } from '../items/rare-items.service';
import { PrismaService } from '../prisma/prisma.service';
import { GroupAccessService } from './group-access.service';
import { GroupsService } from './groups.service';
import { hashTrackingId } from './player-verification';
import type { PlayerVerificationService } from './player-verification.service';
import { XpHistoryService } from './xp-history.service';

const TOKEN = 'group-token-value';
const MEMBER = 'IronJackery';

function rareItems() {
  const service = new RareItemsService();
  service.load('data/rare-items.json');
  return service;
}

/**
 * A verified member's tracking id, if it has one, is checked against every
 * update-group-member push claiming that name.
 */
function makeService(trackingIdHash: string | null) {
  const tx = {
    member: { update: jest.fn().mockResolvedValue({ id: 'm1' }) },
  };
  const memberFindUnique = jest
    .fn()
    .mockResolvedValue({ player: trackingIdHash ? { trackingIdHash } : null });
  const prisma = {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    member: { findUnique: memberFindUnique },
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
  return { groups, tx, memberFindUnique };
}

describe('updateGroupMember tracking-id guard', () => {
  it('lets an unverified member through with no tracking id at all', async () => {
    const { groups, tx } = makeService(null);

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      stats: [100, 100, 1, 1, 1, 1, 1],
    });

    expect(tx.member.update).toHaveBeenCalled();
  });

  it('lets a verified member through when the tracking id matches', async () => {
    const { groups, tx } = makeService(hashTrackingId('track-123'));

    await groups.updateGroupMember('Group', TOKEN, {
      name: MEMBER,
      stats: [100, 100, 1, 1, 1, 1, 1],
      tracking_id: 'track-123',
    });

    expect(tx.member.update).toHaveBeenCalled();
  });

  it('rejects a push for a verified member with a mismatched tracking id', async () => {
    const { groups, tx } = makeService(hashTrackingId('track-123'));

    await expect(
      groups.updateGroupMember('Group', TOKEN, {
        name: MEMBER,
        stats: [100, 100, 1, 1, 1, 1, 1],
        tracking_id: 'someone-elses-id',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(tx.member.update).not.toHaveBeenCalled();
  });

  it('rejects a push for a verified member with no tracking id at all', async () => {
    const { groups, tx } = makeService(hashTrackingId('track-123'));

    await expect(
      groups.updateGroupMember('Group', TOKEN, {
        name: MEMBER,
        stats: [100, 100, 1, 1, 1, 1, 1],
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(tx.member.update).not.toHaveBeenCalled();
  });
});
