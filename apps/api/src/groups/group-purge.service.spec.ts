import { GroupPurgeService } from './group-purge.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { R2Service } from '../uploads/r2.service';
import type { PlayerDeletionService } from './player-deletion.service';

function buildService(overrides: {
  dueGroups?: Array<{ id: string; name: string }>;
  duePlayers?: Array<{ id: string; currentUsername: string }>;
  purgeGroupThrows?: unknown;
  purgePlayerThrows?: unknown;
}) {
  const prisma = {
    group: {
      findMany: jest.fn(() => Promise.resolve(overrides.dueGroups ?? [])),
      delete: jest.fn(() => Promise.resolve({})),
    },
    player: {
      findMany: jest.fn(() => Promise.resolve(overrides.duePlayers ?? [])),
    },
    achievement: {
      count: jest.fn(() => Promise.resolve(0)),
    },
  } as unknown as PrismaService;

  const r2 = {
    deleteGroupImages: jest.fn(() => Promise.resolve()),
  } as unknown as R2Service;

  const playerDeletion = {
    purgePlayer: jest.fn((id: string) => {
      if (overrides.purgePlayerThrows) return Promise.reject(overrides.purgePlayerThrows);
      return Promise.resolve();
    }),
  } as unknown as PlayerDeletionService;

  const service = new GroupPurgeService(prisma, r2, playerDeletion);
  if (overrides.purgeGroupThrows) {
    jest
      .spyOn(service, 'purgeGroup')
      .mockRejectedValue(overrides.purgeGroupThrows);
  }

  return { service, prisma, r2, playerDeletion };
}

describe('GroupPurgeService.sweep', () => {
  it('purges due groups and due players in the same sweep', async () => {
    const { service, playerDeletion } = buildService({
      dueGroups: [{ id: 'g1', name: 'Iron Crew' }],
      duePlayers: [{ id: 'p1', currentUsername: 'Woox' }],
    });

    const purged = await service.sweep();

    expect(purged).toBe(2);
    expect(playerDeletion.purgePlayer).toHaveBeenCalledWith('p1');
  });

  it('a failed player purge does not stop other purges or throw', async () => {
    const { service, playerDeletion } = buildService({
      dueGroups: [],
      duePlayers: [{ id: 'p1', currentUsername: 'Woox' }],
      purgePlayerThrows: new Error('db exploded'),
    });

    await expect(service.sweep()).resolves.toBe(0);
    expect(playerDeletion.purgePlayer).toHaveBeenCalledWith('p1');
  });

  it('does nothing when nothing is due', async () => {
    const { service } = buildService({});
    await expect(service.sweep()).resolves.toBe(0);
  });
});
