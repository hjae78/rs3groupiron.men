import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  generateUnverifiedPlaceholder,
  generateVerificationToken,
  hashTrackingId,
  hashVerificationToken,
  isVerificationTokenUsable,
  VERIFICATION_TOKEN_TTL_MS,
  verificationTokenExpiresAt,
} from './player-verification';
import { PlayerVerificationService } from './player-verification.service';
import type { GroupAccessService } from './group-access.service';
import type { PlayerAccessService } from './player-access.service';
import type { PlayerDeletionService } from './player-deletion.service';
import type { PrismaService } from '../prisma/prisma.service';

describe('hashVerificationToken', () => {
  it('is deterministic', () => {
    expect(hashVerificationToken('abc')).toBe(hashVerificationToken('abc'));
    expect(hashVerificationToken('abc')).not.toBe(hashVerificationToken('abd'));
  });
});

describe('generateVerificationToken', () => {
  it('returns a token whose hash matches the stored hash', () => {
    const { token, tokenHash } = generateVerificationToken();
    expect(hashVerificationToken(token)).toBe(tokenHash);
  });

  it('never repeats across calls', () => {
    const a = generateVerificationToken();
    const b = generateVerificationToken();
    expect(a.token).not.toBe(b.token);
  });
});

describe('verificationTokenExpiresAt', () => {
  it('lands 10 minutes after issuance', () => {
    const from = new Date('2026-10-19T12:00:00.000Z');
    expect(verificationTokenExpiresAt(from).toISOString()).toBe(
      '2026-10-19T12:10:00.000Z',
    );
    expect(VERIFICATION_TOKEN_TTL_MS).toBe(10 * 60 * 1000);
  });
});

describe('isVerificationTokenUsable', () => {
  const now = new Date('2026-10-19T12:05:00.000Z');

  it('accepts an unconsumed, unexpired token', () => {
    expect(
      isVerificationTokenUsable(
        { expiresAt: new Date('2026-10-19T12:10:00.000Z'), consumedAt: null },
        now,
      ),
    ).toBe(true);
  });

  it('rejects an expired token', () => {
    expect(
      isVerificationTokenUsable(
        { expiresAt: new Date('2026-10-19T12:00:00.000Z'), consumedAt: null },
        now,
      ),
    ).toBe(false);
  });

  it('rejects an already-consumed token, even if not expired', () => {
    expect(
      isVerificationTokenUsable(
        {
          expiresAt: new Date('2026-10-19T12:10:00.000Z'),
          consumedAt: new Date('2026-10-19T12:01:00.000Z'),
        },
        now,
      ),
    ).toBe(false);
  });
});

describe('generateUnverifiedPlaceholder', () => {
  it('matches the documented Unverified-<hex> shape and never repeats', () => {
    const a = generateUnverifiedPlaceholder();
    const b = generateUnverifiedPlaceholder();
    expect(a).toMatch(/^Unverified-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});

describe('hashTrackingId', () => {
  it('is deterministic', () => {
    expect(hashTrackingId('abc')).toBe(hashTrackingId('abc'));
    expect(hashTrackingId('abc')).not.toBe(hashTrackingId('abd'));
  });
});

function buildService(overrides: {
  member?: { playerId: string | null } | null;
  tokenRow?: {
    id: string;
    playerId: string;
    memberId?: string;
    tokenHash: string;
    expiresAt: Date;
    consumedAt: Date | null;
    trackingIdHash?: string | null;
  } | null;
  player?: {
    id: string;
    usernameKey: string;
    currentUsername: string;
    verificationStatus?: string;
  };
  conflicts?: Array<{ id: string }>;
  updateFinalThrows?: unknown;
  usernameSuppressed?: boolean;
  canonicalPlayer?: {
    id: string;
    currentUsername?: string;
    verificationStatus?: string;
    trackingIdHash?: string | null;
  } | null;
}) {
  const txPlayer = {
    findUniqueOrThrow: jest.fn(() => Promise.resolve(overrides.player)),
    findMany: jest.fn(() => Promise.resolve(overrides.conflicts ?? [])),
    update: jest.fn(
      (args: { where: { id: string }; data: Record<string, unknown> }) => {
        if (
          overrides.updateFinalThrows &&
          args.where.id === overrides.player?.id
        ) {
          throw overrides.updateFinalThrows;
        }
        return Promise.resolve({
          id: args.where.id,
          currentUsername:
            (args.data.currentUsername as string | undefined) ??
            overrides.player?.currentUsername ??
            'Woox',
          verificationStatus: 'plugin_verified',
        });
      },
    ),
  };
  const txToken = { update: jest.fn(() => Promise.resolve({})) };
  const txHistory = { create: jest.fn(() => Promise.resolve({})) };

  const memberUpdate = jest.fn(() => Promise.resolve({}));

  const prisma = {
    member: {
      findUnique: jest.fn(() => Promise.resolve(overrides.member)),
      update: memberUpdate,
    },
    player: {
      findUniqueOrThrow: jest.fn(() => Promise.resolve(overrides.player)),
      findFirst: jest.fn(() =>
        Promise.resolve(overrides.canonicalPlayer ?? null),
      ),
      update: jest.fn(() => Promise.resolve({})),
    },
    playerVerificationToken: {
      create: jest.fn(() => Promise.resolve({})),
      findFirst: jest.fn(() => Promise.resolve(overrides.tokenRow ?? null)),
      update: jest.fn(() => Promise.resolve({})),
    },
    $transaction: jest.fn((arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return (arg as (tx: unknown) => unknown)({
        player: txPlayer,
        playerVerificationToken: txToken,
        playerUsernameHistory: txHistory,
      });
    }),
  } as unknown as PrismaService;

  const access = {
    write: jest.fn(() =>
      Promise.resolve({
        id: 'g1',
        members: [{ id: 'm1', name: 'Woox' }],
      }),
    ),
    read: jest.fn(() =>
      Promise.resolve({
        id: 'g1',
        members: [{ id: 'm1', name: 'Woox' }],
      }),
    ),
  } as unknown as GroupAccessService;

  const playerAccess = {
    issue: jest.fn(() =>
      Promise.resolve({
        token: 'session-token',
        expiresAt: new Date('2026-11-18T00:00:00.000Z'),
      }),
    ),
  } as unknown as PlayerAccessService;

  const playerDeletion = {
    isUsernameSuppressed: jest.fn(() =>
      Promise.resolve(overrides.usernameSuppressed ?? false),
    ),
  } as unknown as PlayerDeletionService;

  return {
    service: new PlayerVerificationService(
      prisma,
      access,
      playerAccess,
      playerDeletion,
    ),
    prisma,
    access,
    playerAccess,
    playerDeletion,
    txPlayer,
    txToken,
    txHistory,
    memberUpdate,
  };
}

describe('PlayerVerificationService.requestToken', () => {
  it('rejects a name that is not in the group', async () => {
    const { service } = buildService({});
    await expect(
      service.requestToken('Iron Crew', 'tok', 'NotAMember'),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects a member with no linked player', async () => {
    const { service } = buildService({ member: { playerId: null } });
    await expect(
      service.requestToken('Iron Crew', 'tok', 'Woox'),
    ).rejects.toThrow('Member has no linked player identity');
  });

  it('refuses to issue a code for a username still in its deletion cooldown', async () => {
    const { service } = buildService({
      member: { playerId: 'p1' },
      usernameSuppressed: true,
    });
    await expect(
      service.requestToken('Iron Crew', 'tok', 'Woox'),
    ).rejects.toThrow('recently deleted');
  });

  it('issues a plaintext token and stores only its hash', async () => {
    const { service, prisma } = buildService({ member: { playerId: 'p1' } });
    const result = await service.requestToken('Iron Crew', 'tok', 'Woox');
    expect(result.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      (prisma.playerVerificationToken.create as jest.Mock).mock.calls[0][0].data
        .tokenHash,
    ).toBe(hashVerificationToken(result.token));
  });

  it('stores the hashed tracking id when the plugin provides one', async () => {
    const { service, prisma } = buildService({ member: { playerId: 'p1' } });
    await service.requestToken('Iron Crew', 'tok', 'Woox', 'track-123');
    expect(
      (prisma.playerVerificationToken.create as jest.Mock).mock.calls[0][0].data
        .trackingIdHash,
    ).toBe(hashTrackingId('track-123'));
  });

  it('omits the tracking id hash when none is provided', async () => {
    const { service, prisma } = buildService({ member: { playerId: 'p1' } });
    await service.requestToken('Iron Crew', 'tok', 'Woox');
    expect(
      (prisma.playerVerificationToken.create as jest.Mock).mock.calls[0][0]
        .data,
    ).not.toHaveProperty('trackingIdHash');
  });
});

describe('PlayerVerificationService.redeem', () => {
  it('rejects an unknown code', async () => {
    const { service } = buildService({ tokenRow: null });
    await expect(
      service.redeem('00000000-0000-0000-0000-000000000000', 'Woox'),
    ).rejects.toThrow('Invalid or expired code');
  });

  it('rejects an expired code', async () => {
    const { service } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() - 1000),
        consumedAt: null,
      },
    });
    await expect(
      service.redeem('00000000-0000-0000-0000-000000000000', 'Woox'),
    ).rejects.toThrow('Invalid or expired code');
  });

  it('rejects an already-consumed code', async () => {
    const { service } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: new Date(),
      },
    });
    await expect(
      service.redeem('00000000-0000-0000-0000-000000000000', 'Woox'),
    ).rejects.toThrow('Invalid or expired code');
  });

  it('rejects a mismatched RSN and does not consume the token', async () => {
    const { service, txToken } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      },
      player: { id: 'p1', usernameKey: 'woox', currentUsername: 'Woox' },
    });

    await expect(
      service.redeem('00000000-0000-0000-0000-000000000000', 'SomeoneElse'),
    ).rejects.toThrow('Invalid or expired code');
    expect(txToken.update).not.toHaveBeenCalled();
  });

  it('accepts the RSN case- and whitespace-insensitively', async () => {
    const { service } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      },
      player: { id: 'p1', usernameKey: 'woox', currentUsername: 'Woox' },
    });

    const result = await service.redeem(
      '00000000-0000-0000-0000-000000000000',
      '  woox  ',
    );
    expect(result.verification_status).toBe('plugin_verified');
  });

  it('verifies the player and renames unverified username conflicts', async () => {
    const { service, txPlayer, playerAccess } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      },
      player: { id: 'p1', usernameKey: 'woox', currentUsername: 'Woox' },
      conflicts: [{ id: 'p2' }, { id: 'p3' }],
    });

    const result = await service.redeem(
      '00000000-0000-0000-0000-000000000000',
      'Woox',
    );

    expect(result.verification_status).toBe('plugin_verified');
    expect(result.access_token).toBe('session-token');
    expect(result.access_token_expires_at).toBe('2026-11-18T00:00:00.000Z');
    expect(playerAccess.issue).toHaveBeenCalledWith('p1');
    expect(txPlayer.update).toHaveBeenCalledTimes(3);
    const conflictCalls = (txPlayer.update as jest.Mock).mock.calls.filter(
      ([args]: [{ where: { id: string } }]) =>
        args.where.id === 'p2' || args.where.id === 'p3',
    );
    expect(conflictCalls).toHaveLength(2);
    for (const [args] of conflictCalls) {
      expect(args.data.currentUsername).toMatch(/^Unverified-[0-9a-f]{8}$/);
    }
  });

  it('translates a unique-constraint race into a 409', async () => {
    const prismaError = Object.assign(
      new Prisma.PrismaClientKnownRequestError('conflict', {
        code: 'P2002',
        clientVersion: '0',
      }),
      {},
    );
    const { service } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      },
      player: { id: 'p1', usernameKey: 'woox', currentUsername: 'Woox' },
      updateFinalThrows: prismaError,
    });

    await expect(
      service.redeem('00000000-0000-0000-0000-000000000000', 'Woox'),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects a mismatched RSN for a first-time (unverified) claim', async () => {
    const { service, txPlayer } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      },
      player: {
        id: 'p1',
        usernameKey: 'woox',
        currentUsername: 'Woox',
        verificationStatus: 'unverified',
      },
    });

    await expect(
      service.redeem('00000000-0000-0000-0000-000000000000', 'NewName'),
    ).rejects.toThrow('Invalid or expired code');
    expect(txPlayer.update).not.toHaveBeenCalled();
  });

  it('treats a mismatched RSN from an already-verified player as a rename', async () => {
    const { service, txPlayer, txHistory } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      },
      player: {
        id: 'p1',
        usernameKey: 'woox',
        currentUsername: 'Woox',
        verificationStatus: 'plugin_verified',
      },
    });

    const result = await service.redeem(
      '00000000-0000-0000-0000-000000000000',
      'NewName',
    );

    expect(result.username).toBe('NewName');
    expect(txHistory.create).toHaveBeenCalledWith({
      data: { playerId: 'p1', username: 'NewName' },
    });
    const finalUpdate = (txPlayer.update as jest.Mock).mock.calls.find(
      ([args]: [{ where: { id: string } }]) => args.where.id === 'p1',
    );
    expect(finalUpdate[0].data).toMatchObject({
      currentUsername: 'NewName',
      usernameKey: 'newname',
    });
  });

  it('does not treat a mere case/whitespace difference as a rename', async () => {
    const { service, txHistory } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      },
      player: {
        id: 'p1',
        usernameKey: 'woox',
        currentUsername: 'Woox',
        verificationStatus: 'plugin_verified',
      },
    });

    const result = await service.redeem(
      '00000000-0000-0000-0000-000000000000',
      '  woox  ',
    );

    expect(result.verification_status).toBe('plugin_verified');
    expect(txHistory.create).not.toHaveBeenCalled();
  });

  it('checks for an unverified conflict on the *new* username, not the old one', async () => {
    const { service, txPlayer } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      },
      player: {
        id: 'p1',
        usernameKey: 'woox',
        currentUsername: 'Woox',
        verificationStatus: 'plugin_verified',
      },
      conflicts: [{ id: 'p2' }],
    });

    await service.redeem('00000000-0000-0000-0000-000000000000', 'NewName');

    expect(
      (txPlayer.findMany as jest.Mock).mock.calls[0][0].where,
    ).toMatchObject({ usernameKey: 'newname' });
    expect(txPlayer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p2' },
        data: expect.objectContaining({
          currentUsername: expect.stringMatching(/^Unverified-[0-9a-f]{8}$/),
        }),
      }),
    );
  });

  it('carries the tracking id hash from the token onto the player', async () => {
    const { service, txPlayer } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
        trackingIdHash: hashTrackingId('track-123'),
      },
      player: { id: 'p1', usernameKey: 'woox', currentUsername: 'Woox' },
    });

    await service.redeem('00000000-0000-0000-0000-000000000000', 'Woox');

    const finalUpdate = (txPlayer.update as jest.Mock).mock.calls.find(
      ([args]: [{ where: { id: string } }]) => args.where.id === 'p1',
    );
    expect(finalUpdate[0].data.trackingIdHash).toBe(
      hashTrackingId('track-123'),
    );
  });

  it('re-homes onto an existing verified player instead of conflicting, when the tracking id matches', async () => {
    const { service, prisma, memberUpdate, txPlayer } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        memberId: 'm1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
        trackingIdHash: hashTrackingId('track-123'),
      },
      player: { id: 'p1', usernameKey: 'woox', currentUsername: 'Woox' },
      canonicalPlayer: {
        id: 'canonical',
        currentUsername: 'Woox',
        verificationStatus: 'plugin_verified',
        trackingIdHash: hashTrackingId('track-123'),
      },
    });

    const result = await service.redeem(
      '00000000-0000-0000-0000-000000000000',
      'Woox',
    );

    expect(result.player_id).toBe('canonical');
    expect(result.access_token).toBe('session-token');
    expect(memberUpdate).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { playerId: 'canonical' },
    });
    expect(txPlayer.update).not.toHaveBeenCalled();
    expect(
      (prisma.player.findFirst as jest.Mock).mock.calls[0][0].where,
    ).toMatchObject({
      usernameKey: 'woox',
      verificationStatus: 'plugin_verified',
      id: { not: 'p1' },
    });
  });

  it('re-homes onto a legacy verified player with no tracking id on file, and backfills it', async () => {
    const { service, prisma, memberUpdate } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        memberId: 'm1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
        trackingIdHash: hashTrackingId('track-123'),
      },
      player: { id: 'p1', usernameKey: 'woox', currentUsername: 'Woox' },
      canonicalPlayer: {
        id: 'canonical',
        currentUsername: 'Woox',
        verificationStatus: 'plugin_verified',
        trackingIdHash: null,
      },
    });

    const result = await service.redeem(
      '00000000-0000-0000-0000-000000000000',
      'Woox',
    );

    expect(result.player_id).toBe('canonical');
    expect(memberUpdate).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { playerId: 'canonical' },
    });
    const backfill = (prisma.player.update as jest.Mock).mock.calls.find(
      ([args]: [{ where: { id: string } }]) => args.where.id === 'canonical',
    );
    expect(backfill[0].data).toEqual({
      trackingIdHash: hashTrackingId('track-123'),
    });
  });

  it('re-homes onto a legacy verified player even with no tracking id on either side', async () => {
    const { service, memberUpdate, prisma } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        memberId: 'm1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      },
      player: { id: 'p1', usernameKey: 'woox', currentUsername: 'Woox' },
      canonicalPlayer: {
        id: 'canonical',
        currentUsername: 'Woox',
        verificationStatus: 'plugin_verified',
        trackingIdHash: null,
      },
    });

    const result = await service.redeem(
      '00000000-0000-0000-0000-000000000000',
      'Woox',
    );

    expect(result.player_id).toBe('canonical');
    expect(memberUpdate).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { playerId: 'canonical' },
    });
    expect(prisma.player.update).not.toHaveBeenCalled();
  });

  it('falls through to the normal (conflicting) path when tracking ids disagree', async () => {
    const prismaError = Object.assign(
      new Prisma.PrismaClientKnownRequestError('conflict', {
        code: 'P2002',
        clientVersion: '0',
      }),
      {},
    );
    const { service } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        memberId: 'm1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
        trackingIdHash: hashTrackingId('track-123'),
      },
      player: { id: 'p1', usernameKey: 'woox', currentUsername: 'Woox' },
      canonicalPlayer: {
        id: 'canonical',
        currentUsername: 'Woox',
        verificationStatus: 'plugin_verified',
        trackingIdHash: hashTrackingId('a-different-account'),
      },
      updateFinalThrows: prismaError,
    });

    await expect(
      service.redeem('00000000-0000-0000-0000-000000000000', 'Woox'),
    ).rejects.toThrow(ConflictException);
  });

  it('falls through to the normal (conflicting) path when no other verified player exists at all', async () => {
    const prismaError = Object.assign(
      new Prisma.PrismaClientKnownRequestError('conflict', {
        code: 'P2002',
        clientVersion: '0',
      }),
      {},
    );
    const { service } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        memberId: 'm1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      },
      player: { id: 'p1', usernameKey: 'woox', currentUsername: 'Woox' },
      canonicalPlayer: null,
      updateFinalThrows: prismaError,
    });

    await expect(
      service.redeem('00000000-0000-0000-0000-000000000000', 'Woox'),
    ).rejects.toThrow(ConflictException);
  });

  it('leaves trackingIdHash untouched when the token carried none', async () => {
    const { service, txPlayer } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      },
      player: { id: 'p1', usernameKey: 'woox', currentUsername: 'Woox' },
    });

    await service.redeem('00000000-0000-0000-0000-000000000000', 'Woox');

    const finalUpdate = (txPlayer.update as jest.Mock).mock.calls.find(
      ([args]: [{ where: { id: string } }]) => args.where.id === 'p1',
    );
    expect(finalUpdate[0].data).not.toHaveProperty('trackingIdHash');
  });
});

describe('PlayerVerificationService.tryAutoVerify', () => {
  it('re-homes the member onto the matching verified player', async () => {
    const { service, prisma, memberUpdate } = buildService({
      canonicalPlayer: { id: 'canonical' },
    });

    const result = await service.tryAutoVerify('m1', 'p1', 'woox', 'track-123');

    expect(result).toBe(true);
    expect(
      (prisma.player.findFirst as jest.Mock).mock.calls[0][0].where,
    ).toMatchObject({
      usernameKey: 'woox',
      trackingIdHash: hashTrackingId('track-123'),
      verificationStatus: 'plugin_verified',
      id: { not: 'p1' },
    });
    expect(memberUpdate).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { playerId: 'canonical' },
    });
  });

  it('returns false and makes no change when nothing matches', async () => {
    const { service, memberUpdate } = buildService({ canonicalPlayer: null });

    const result = await service.tryAutoVerify('m1', 'p1', 'woox', 'track-123');

    expect(result).toBe(false);
    expect(memberUpdate).not.toHaveBeenCalled();
  });
});

describe('PlayerVerificationService.checkTokenStatus', () => {
  it('reports unconsumed for an unknown code', async () => {
    const { service } = buildService({ tokenRow: null });
    const result = await service.checkTokenStatus('Iron Crew', 'tok', 'x');
    expect(result).toEqual({ consumed: false });
  });

  it('reports unconsumed while the code is still outstanding', async () => {
    const { service } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      },
    });
    const result = await service.checkTokenStatus('Iron Crew', 'tok', 'x');
    expect(result).toEqual({ consumed: false });
  });

  it('reports consumed once the code has been redeemed', async () => {
    const { service } = buildService({
      tokenRow: {
        id: 't1',
        playerId: 'p1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: new Date(),
      },
    });
    const result = await service.checkTokenStatus('Iron Crew', 'tok', 'x');
    expect(result).toEqual({ consumed: true });
  });

  it('requires group read access, not write', async () => {
    const { service, access } = buildService({ tokenRow: null });
    await service.checkTokenStatus('Iron Crew', 'tok', 'x');
    expect(access.read).toHaveBeenCalledWith('Iron Crew', 'tok');
    expect(access.write).not.toHaveBeenCalled();
  });
});
