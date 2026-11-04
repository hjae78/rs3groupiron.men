import { BadRequestException } from '@nestjs/common';
import {
  DELETION_SUPPRESSION_COOLDOWN_MS,
  ACCESS_TOKEN_FRESHNESS_MS,
  PLAYER_DELETION_GRACE_MS,
  hashUsernameKey,
  isCredentialFresh,
  isSuppressionActive,
  playerDeletionDueAt,
  playerDeletionStatus,
  suppressionCooldownUntil,
} from './player-deletion';
import { PlayerDeletionService } from './player-deletion.service';
import type { PrismaService } from '../prisma/prisma.service';

describe('hashUsernameKey', () => {
  it('is deterministic', () => {
    expect(hashUsernameKey('woox')).toBe(hashUsernameKey('woox'));
    expect(hashUsernameKey('woox')).not.toBe(hashUsernameKey('wooxx'));
  });
});

describe('suppressionCooldownUntil', () => {
  it('lands 7 days after suppression', () => {
    const from = new Date('2026-10-19T12:00:00.000Z');
    expect(suppressionCooldownUntil(from).toISOString()).toBe(
      '2026-10-26T12:00:00.000Z',
    );
    expect(DELETION_SUPPRESSION_COOLDOWN_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('isSuppressionActive', () => {
  it('is active before the cooldown ends', () => {
    expect(
      isSuppressionActive(
        { cooldownUntil: new Date('2026-10-26T12:00:00.000Z') },
        new Date('2026-10-20T00:00:00.000Z'),
      ),
    ).toBe(true);
  });

  it('is inactive after the cooldown ends', () => {
    expect(
      isSuppressionActive(
        { cooldownUntil: new Date('2026-10-26T12:00:00.000Z') },
        new Date('2026-10-27T00:00:00.000Z'),
      ),
    ).toBe(false);
  });
});

describe('isCredentialFresh', () => {
  it('accepts a credential issued moments ago', () => {
    const now = new Date('2026-10-19T12:10:00.000Z');
    expect(isCredentialFresh(new Date('2026-10-19T12:00:00.000Z'), now)).toBe(
      true,
    );
    expect(ACCESS_TOKEN_FRESHNESS_MS).toBe(30 * 60 * 1000);
  });

  it('rejects a credential older than the freshness window', () => {
    const now = new Date('2026-10-19T13:00:00.000Z');
    expect(isCredentialFresh(new Date('2026-10-19T12:00:00.000Z'), now)).toBe(
      false,
    );
  });
});

describe('playerDeletionDueAt', () => {
  it('lands 24 hours after the request, separate from the group grace period', () => {
    const from = new Date('2026-11-04T12:00:00.000Z');
    expect(playerDeletionDueAt(from).toISOString()).toBe(
      '2026-11-05T12:00:00.000Z',
    );
    expect(PLAYER_DELETION_GRACE_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('playerDeletionStatus', () => {
  it('reports not pending when deleteAfter is null', () => {
    expect(
      playerDeletionStatus({ deletionRequestedAt: null, deleteAfter: null }),
    ).toEqual({ pending: false, requested_at: null, delete_after: null });
  });

  it('reports pending with ISO timestamps when set', () => {
    const requestedAt = new Date('2026-11-04T12:00:00.000Z');
    const deleteAfter = new Date('2026-11-05T12:00:00.000Z');
    expect(
      playerDeletionStatus({
        deletionRequestedAt: requestedAt,
        deleteAfter,
      }),
    ).toEqual({
      pending: true,
      requested_at: requestedAt.toISOString(),
      delete_after: deleteAfter.toISOString(),
    });
  });
});

function buildService(overrides: {
  player?: {
    id: string;
    usernameKey: string;
    currentUsername: string;
    deletionRequestedAt?: Date | null;
    deleteAfter?: Date | null;
  } | null;
}) {
  const deletedMembers = { count: 2 };
  const player = overrides.player
    ? {
        deletionRequestedAt: null,
        deleteAfter: null,
        ...overrides.player,
      }
    : null;

  const prisma = {
    player: {
      findUniqueOrThrow: jest.fn(() => {
        if (!player) throw new Error('not found');
        return Promise.resolve(player);
      }),
      update: jest.fn(
        (args: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...player, ...args.data }),
      ),
      delete: jest.fn(() => Promise.resolve({})),
    },
    member: {
      deleteMany: jest.fn(() => Promise.resolve(deletedMembers)),
    },
    deletionSuppression: {
      create: jest.fn(() => Promise.resolve({})),
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaService;

  return { service: new PlayerDeletionService(prisma), prisma };
}

describe('PlayerDeletionService.requestDeletion', () => {
  it('rejects a mismatched confirmation username', async () => {
    const { service } = buildService({
      player: { id: 'p1', usernameKey: 'woox', currentUsername: 'Woox' },
    });
    await expect(
      service.requestDeletion('p1', 'SomeoneElse'),
    ).rejects.toThrow(BadRequestException);
  });

  it('starts a pending 24h window without touching any data yet', async () => {
    const { service, prisma } = buildService({
      player: { id: 'p1', usernameKey: 'woox', currentUsername: 'Woox' },
    });

    const result = await service.requestDeletion('p1', '  woox  ');

    expect(result.pending).toBe(true);
    expect(result.delete_after).not.toBeNull();
    expect(prisma.member.deleteMany).not.toHaveBeenCalled();
    expect(prisma.player.delete).not.toHaveBeenCalled();
    const updateArgs = (prisma.player.update as jest.Mock).mock.calls[0][0];
    expect(updateArgs.data.deleteAfter.getTime()).toBe(
      updateArgs.data.deletionRequestedAt.getTime() + 24 * 60 * 60 * 1000,
    );
  });

  it('does not push the date back on a repeat request', async () => {
    const deleteAfter = new Date('2026-11-05T00:00:00.000Z');
    const { service, prisma } = buildService({
      player: {
        id: 'p1',
        usernameKey: 'woox',
        currentUsername: 'Woox',
        deletionRequestedAt: new Date('2026-11-04T00:00:00.000Z'),
        deleteAfter,
      },
    });

    const result = await service.requestDeletion('p1', 'Woox');

    expect(result.delete_after).toBe(deleteAfter.toISOString());
    expect(prisma.player.update).not.toHaveBeenCalled();
  });
});

describe('PlayerDeletionService.cancelDeletion', () => {
  it('clears a pending request', async () => {
    const { service, prisma } = buildService({
      player: {
        id: 'p1',
        usernameKey: 'woox',
        currentUsername: 'Woox',
        deletionRequestedAt: new Date(),
        deleteAfter: new Date(Date.now() + 60_000),
      },
    });

    const result = await service.cancelDeletion('p1');

    expect(result.pending).toBe(false);
    expect(prisma.player.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { deletionRequestedAt: null, deleteAfter: null },
      select: { deletionRequestedAt: true, deleteAfter: true },
    });
  });

  it('is a no-op when nothing is pending', async () => {
    const { service, prisma } = buildService({
      player: { id: 'p1', usernameKey: 'woox', currentUsername: 'Woox' },
    });

    const result = await service.cancelDeletion('p1');

    expect(result.pending).toBe(false);
    expect(prisma.player.update).not.toHaveBeenCalled();
  });
});

describe('PlayerDeletionService.purgePlayer', () => {
  it('deletes everything and records a suppression, regardless of pending status', async () => {
    const { service, prisma } = buildService({
      player: { id: 'p1', usernameKey: 'woox', currentUsername: 'Woox' },
    });

    await service.purgePlayer('p1');

    expect(prisma.member.deleteMany).toHaveBeenCalledWith({
      where: { playerId: 'p1' },
    });
    expect(prisma.player.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    expect(
      (prisma.deletionSuppression.create as jest.Mock).mock.calls[0][0].data
        .usernameKeyHash,
    ).toBe(hashUsernameKey('woox'));
  });
});

describe('PlayerDeletionService.isUsernameSuppressed', () => {
  it('returns false when no suppression row exists', async () => {
    const { service } = buildService({});
    await expect(service.isUsernameSuppressed('woox')).resolves.toBe(false);
  });

  it('returns true for an active cooldown', async () => {
    const { service, prisma } = buildService({});
    (prisma.deletionSuppression.findFirst as jest.Mock).mockResolvedValueOnce({
      cooldownUntil: new Date(Date.now() + 60_000),
    });
    await expect(service.isUsernameSuppressed('woox')).resolves.toBe(true);
  });

  it('returns false once the cooldown has passed', async () => {
    const { service, prisma } = buildService({});
    (prisma.deletionSuppression.findFirst as jest.Mock).mockResolvedValueOnce({
      cooldownUntil: new Date(Date.now() - 60_000),
    });
    await expect(service.isUsernameSuppressed('woox')).resolves.toBe(false);
  });
});
