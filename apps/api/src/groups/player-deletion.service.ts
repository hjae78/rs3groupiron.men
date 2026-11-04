import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  hashUsernameKey,
  isSuppressionActive,
  playerDeletionDueAt,
  playerDeletionStatus,
  suppressionCooldownUntil,
} from './player-deletion';
import { verificationUsernameMatches } from './player-verification';

@Injectable()
export class PlayerDeletionService {
  constructor(private readonly prisma: PrismaService) {}

  async isUsernameSuppressed(usernameKey: string): Promise<boolean> {
    const row = await this.prisma.deletionSuppression.findFirst({
      where: { usernameKeyHash: hashUsernameKey(usernameKey) },
      orderBy: { cooldownUntil: 'desc' },
    });
    return row != null && isSuppressionActive(row, new Date());
  }

  async requestDeletion(playerId: string, confirmUsername: string) {
    const player = await this.prisma.player.findUniqueOrThrow({
      where: { id: playerId },
    });
    if (!verificationUsernameMatches(player.currentUsername, confirmUsername)) {
      throw new BadRequestException(
        'That username does not match your account',
      );
    }

    if (player.deleteAfter) {
      return { ok: true, ...playerDeletionStatus(player) };
    }

    const now = new Date();
    const updated = await this.prisma.player.update({
      where: { id: playerId },
      data: { deletionRequestedAt: now, deleteAfter: playerDeletionDueAt(now) },
      select: { deletionRequestedAt: true, deleteAfter: true },
    });
    return { ok: true, ...playerDeletionStatus(updated) };
  }

  async cancelDeletion(playerId: string) {
    const player = await this.prisma.player.findUniqueOrThrow({
      where: { id: playerId },
    });
    if (!player.deleteAfter) {
      return { ok: true, ...playerDeletionStatus(player) };
    }
    const updated = await this.prisma.player.update({
      where: { id: playerId },
      data: { deletionRequestedAt: null, deleteAfter: null },
      select: { deletionRequestedAt: true, deleteAfter: true },
    });
    return { ok: true, ...playerDeletionStatus(updated) };
  }

  async purgePlayer(playerId: string) {
    const player = await this.prisma.player.findUniqueOrThrow({
      where: { id: playerId },
    });

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.member.deleteMany({ where: { playerId } }),
      this.prisma.deletionSuppression.create({
        data: {
          usernameKeyHash: hashUsernameKey(player.usernameKey),
          suppressedAt: now,
          cooldownUntil: suppressionCooldownUntil(now),
        },
      }),
      this.prisma.player.delete({ where: { id: playerId } }),
    ]);
  }
}
