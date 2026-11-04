import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  accessTokenExpiresAt,
  generateAccessToken,
  hashAccessToken,
  isAccessCredentialUsable,
} from './player-access';
import { playerDeletionStatus } from './player-deletion';

@Injectable()
export class PlayerAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(playerId: string): Promise<{ token: string; expiresAt: Date }> {
    const { token, tokenHash } = generateAccessToken();
    const expiresAt = accessTokenExpiresAt(new Date());
    await this.prisma.playerAccessCredential.create({
      data: { playerId, tokenHash, expiresAt },
    });
    return { token, expiresAt };
  }

  async validate(
    token: string,
  ): Promise<{ playerId: string; createdAt: Date } | null> {
    const tokenHash = hashAccessToken(token);
    const row = await this.prisma.playerAccessCredential.findFirst({
      where: { tokenHash },
    });
    if (!row || !isAccessCredentialUsable(row, new Date())) return null;

    await this.prisma.playerAccessCredential.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    });
    return { playerId: row.playerId, createdAt: row.createdAt };
  }

  async revoke(token: string): Promise<void> {
    const tokenHash = hashAccessToken(token);
    const row = await this.prisma.playerAccessCredential.findFirst({
      where: { tokenHash },
    });
    if (!row || row.revokedAt != null) return;

    await this.prisma.playerAccessCredential.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
  }

  async getProfile(playerId: string) {
    const player = await this.prisma.player.findUniqueOrThrow({
      where: { id: playerId },
      include: {
        usernameHistory: { orderBy: { firstSeenAt: 'asc' } },
      },
    });
    return {
      id: player.id,
      current_username: player.currentUsername,
      previous_usernames: [
        ...new Set(
          player.usernameHistory
            .map((h) => h.username)
            .filter((name) => name.toLowerCase() !== player.usernameKey),
        ),
      ],
      verification_status: player.verificationStatus,
      verified_at: player.verifiedAt?.toISOString() ?? null,
      deletion: playerDeletionStatus(player),
    };
  }

  async listSessions(playerId: string, currentToken: string) {
    const currentHash = hashAccessToken(currentToken);
    const rows = await this.prisma.playerAccessCredential.findMany({
      where: { playerId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      created_at: row.createdAt.toISOString(),
      last_used_at: row.lastUsedAt?.toISOString() ?? null,
      expires_at: row.expiresAt.toISOString(),
      current: row.tokenHash === currentHash,
    }));
  }

  async revokeById(playerId: string, credentialId: string): Promise<void> {
    await this.prisma.playerAccessCredential.updateMany({
      where: { id: credentialId, playerId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async rotate(
    token: string,
  ): Promise<{ token: string; expiresAt: Date } | null> {
    const current = await this.validate(token);
    if (!current) return null;

    const tokenHash = hashAccessToken(token);
    const next = generateAccessToken();
    const expiresAt = accessTokenExpiresAt(new Date());

    await this.prisma.$transaction([
      this.prisma.playerAccessCredential.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.playerAccessCredential.create({
        data: {
          playerId: current.playerId,
          tokenHash: next.tokenHash,
          expiresAt,
        },
      }),
    ]);

    return { token: next.token, expiresAt };
  }
}
