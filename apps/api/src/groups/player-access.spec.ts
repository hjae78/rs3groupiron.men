import {
  ACCESS_TOKEN_TTL_MS,
  accessTokenExpiresAt,
  generateAccessToken,
  hashAccessToken,
  isAccessCredentialUsable,
} from './player-access';
import { PlayerAccessService } from './player-access.service';
import type { PrismaService } from '../prisma/prisma.service';

describe('hashAccessToken', () => {
  it('is deterministic', () => {
    expect(hashAccessToken('abc')).toBe(hashAccessToken('abc'));
    expect(hashAccessToken('abc')).not.toBe(hashAccessToken('abd'));
  });
});

describe('generateAccessToken', () => {
  it('returns a token whose hash matches the stored hash', () => {
    const { token, tokenHash } = generateAccessToken();
    expect(hashAccessToken(token)).toBe(tokenHash);
  });
});

describe('accessTokenExpiresAt', () => {
  it('lands effectively never (100 years out) — tokens no longer expire', () => {
    const from = new Date('2026-10-19T12:00:00.000Z');
    expect(accessTokenExpiresAt(from).getTime() - from.getTime()).toBe(
      ACCESS_TOKEN_TTL_MS,
    );
    expect(ACCESS_TOKEN_TTL_MS).toBe(100 * 365 * 24 * 60 * 60 * 1000);
  });
});

describe('isAccessCredentialUsable', () => {
  const now = new Date('2026-10-19T12:05:00.000Z');

  it('accepts an unrevoked, unexpired credential', () => {
    expect(
      isAccessCredentialUsable(
        { expiresAt: new Date('2026-10-19T12:10:00.000Z'), revokedAt: null },
        now,
      ),
    ).toBe(true);
  });

  it('rejects an expired credential', () => {
    expect(
      isAccessCredentialUsable(
        { expiresAt: new Date('2026-10-19T12:00:00.000Z'), revokedAt: null },
        now,
      ),
    ).toBe(false);
  });

  it('rejects a revoked credential, even if not expired', () => {
    expect(
      isAccessCredentialUsable(
        {
          expiresAt: new Date('2026-10-19T12:10:00.000Z'),
          revokedAt: new Date('2026-10-19T12:01:00.000Z'),
        },
        now,
      ),
    ).toBe(false);
  });
});

function buildService(
  rows: Array<{
    id: string;
    playerId: string;
    tokenHash: string;
    expiresAt: Date;
    revokedAt: Date | null;
    createdAt?: Date;
  }>,
  playerOverrides: {
    player?: {
      id: string;
      currentUsername: string;
      usernameKey: string;
      verificationStatus: string;
      verifiedAt: Date | null;
      usernameHistory: Array<{ username: string; firstSeenAt: Date }>;
    };
  } = {},
) {
  const store = [...rows];
  const prisma = {
    playerAccessCredential: {
      create: jest.fn(
        (args: {
          data: { playerId: string; tokenHash: string; expiresAt: Date };
        }) => {
          const row = {
            id: `new-${store.length}`,
            revokedAt: null,
            createdAt: new Date(),
            lastUsedAt: null,
            ...args.data,
          };
          store.push(row);
          return Promise.resolve(row);
        },
      ),
      findFirst: jest.fn((args: { where: { tokenHash: string } }) =>
        Promise.resolve(
          store.find((r) => r.tokenHash === args.where.tokenHash) ?? null,
        ),
      ),
      findMany: jest.fn((args: { where: { playerId: string } }) =>
        Promise.resolve(
          store.filter(
            (r) =>
              r.playerId === args.where.playerId &&
              r.revokedAt == null &&
              r.expiresAt.getTime() > Date.now(),
          ),
        ),
      ),
      update: jest.fn(
        (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = store.find((r) => r.id === args.where.id);
          if (row) Object.assign(row, args.data);
          return Promise.resolve(row);
        },
      ),
      updateMany: jest.fn(
        (args: {
          where: {
            tokenHash?: string;
            id?: string;
            playerId?: string;
            revokedAt: null;
          };
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const row of store) {
            if (row.revokedAt != null) continue;
            if (args.where.tokenHash && row.tokenHash !== args.where.tokenHash)
              continue;
            if (args.where.id && row.id !== args.where.id) continue;
            if (args.where.playerId && row.playerId !== args.where.playerId)
              continue;
            Object.assign(row, args.data);
            count += 1;
          }
          return Promise.resolve({ count });
        },
      ),
    },
    player: {
      findUniqueOrThrow: jest.fn(() => {
        if (!playerOverrides.player) throw new Error('not found');
        return Promise.resolve(playerOverrides.player);
      }),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaService;

  return { service: new PlayerAccessService(prisma), prisma, store };
}

describe('PlayerAccessService', () => {
  it('issues a credential whose plaintext hashes to the stored hash', async () => {
    const { service, store } = buildService([]);
    const { token } = await service.issue('p1');
    expect(store).toHaveLength(1);
    expect(store[0].tokenHash).toBe(hashAccessToken(token));
    expect(store[0].playerId).toBe('p1');
  });

  it('validates a live token and returns its playerId and createdAt', async () => {
    const { service } = buildService([]);
    const { token } = await service.issue('p1');
    const result = await service.validate(token);
    expect(result?.playerId).toBe('p1');
    expect(result?.createdAt).toBeInstanceOf(Date);
  });

  it('rejects an unknown token', async () => {
    const { service } = buildService([]);
    await expect(
      service.validate('00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeNull();
  });

  it('rejects an expired token', async () => {
    const { service, store } = buildService([]);
    const { token } = await service.issue('p1');
    store[0].expiresAt = new Date(Date.now() - 1000);
    await expect(service.validate(token)).resolves.toBeNull();
  });

  it('rejects a revoked token', async () => {
    const { service } = buildService([]);
    const { token } = await service.issue('p1');
    await service.revoke(token);
    await expect(service.validate(token)).resolves.toBeNull();
  });

  it('revoke is idempotent for an unknown token', async () => {
    const { service } = buildService([]);
    await expect(
      service.revoke('00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeUndefined();
  });

  it('rotate issues a new token and invalidates the old one', async () => {
    const { service } = buildService([]);
    const { token: original } = await service.issue('p1');

    const rotated = await service.rotate(original);

    expect(rotated).not.toBeNull();
    expect(rotated!.token).not.toBe(original);
    await expect(service.validate(original)).resolves.toBeNull();
    const revalidated = await service.validate(rotated!.token);
    expect(revalidated?.playerId).toBe('p1');
  });

  it('rotate returns null for an invalid token', async () => {
    const { service } = buildService([]);
    await expect(
      service.rotate('00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeNull();
  });
});

describe('PlayerAccessService.getProfile', () => {
  it('excludes the current username from previous_usernames', async () => {
    const { service } = buildService([], {
      player: {
        id: 'p1',
        currentUsername: 'Woox',
        usernameKey: 'woox',
        verificationStatus: 'plugin_verified',
        verifiedAt: new Date('2026-10-19T12:00:00.000Z'),
        usernameHistory: [
          {
            username: 'OldWoox',
            firstSeenAt: new Date('2026-09-01T00:00:00.000Z'),
          },
          {
            username: 'Woox',
            firstSeenAt: new Date('2026-10-01T00:00:00.000Z'),
          },
        ],
      },
    });

    const profile = await service.getProfile('p1');

    expect(profile.previous_usernames).toEqual(['OldWoox']);
  });
});

describe('PlayerAccessService.listSessions', () => {
  it('flags the presented token as current and excludes other players', async () => {
    const { service } = buildService([
      {
        id: 's1',
        playerId: 'p1',
        tokenHash: hashAccessToken('mine'),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        createdAt: new Date(),
      },
      {
        id: 's2',
        playerId: 'p1',
        tokenHash: hashAccessToken('other-device'),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        createdAt: new Date(),
      },
      {
        id: 's3',
        playerId: 'p2',
        tokenHash: hashAccessToken('someone-elses'),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        createdAt: new Date(),
      },
    ]);

    const sessions = await service.listSessions('p1', 'mine');

    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.id === 's1')?.current).toBe(true);
    expect(sessions.find((s) => s.id === 's2')?.current).toBe(false);
  });
});

describe('PlayerAccessService.revokeById', () => {
  it('revokes a credential belonging to the player', async () => {
    const { service, store } = buildService([
      {
        id: 's1',
        playerId: 'p1',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
    ]);

    await service.revokeById('p1', 's1');

    expect(store[0].revokedAt).not.toBeNull();
  });

  it('does not revoke a credential belonging to a different player', async () => {
    const { service, store } = buildService([
      {
        id: 's1',
        playerId: 'p2',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
    ]);

    await service.revokeById('p1', 's1');

    expect(store[0].revokedAt).toBeNull();
  });
});
