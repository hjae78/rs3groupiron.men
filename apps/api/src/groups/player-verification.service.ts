import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GroupAccessService } from './group-access.service';
import { findMemberRef } from './group-fields';
import { PlayerAccessService } from './player-access.service';
import { PlayerDeletionService } from './player-deletion.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  generateUnverifiedPlaceholder,
  generateVerificationToken,
  hashTrackingId,
  hashVerificationToken,
  isVerificationTokenUsable,
  verificationTokenExpiresAt,
  verificationUsernameMatches,
} from './player-verification';

const INVALID_CODE_MESSAGE = 'Invalid or expired code';

@Injectable()
export class PlayerVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GroupAccessService,
    private readonly playerAccess: PlayerAccessService,
    private readonly playerDeletion: PlayerDeletionService,
  ) {}

  async requestToken(
    groupName: string,
    authorization: string | undefined,
    memberName: string,
    trackingId?: string,
  ) {
    const group = await this.access.write(groupName, authorization);
    const member = findMemberRef(group.members, memberName);
    if (!member) throw new NotFoundException('Member not found');

    if (
      await this.playerDeletion.isUsernameSuppressed(member.name.toLowerCase())
    ) {
      throw new ConflictException(
        'This username was recently deleted and cannot be re-verified yet',
      );
    }

    const full = await this.prisma.member.findUnique({
      where: { id: member.id },
      select: { playerId: true },
    });
    if (!full?.playerId) {
      throw new BadRequestException('Member has no linked player identity');
    }

    const { token, tokenHash } = generateVerificationToken();
    const expiresAt = verificationTokenExpiresAt(new Date());

    await this.prisma.playerVerificationToken.create({
      data: {
        playerId: full.playerId,
        groupId: group.id,
        memberId: member.id,
        tokenHash,
        expiresAt,
        ...(trackingId ? { trackingIdHash: hashTrackingId(trackingId) } : {}),
      },
    });

    return { token, expires_at: expiresAt.toISOString() };
  }

  async redeem(code: string, username: string) {
    const tokenHash = hashVerificationToken(code);
    const row = await this.prisma.playerVerificationToken.findFirst({
      where: { tokenHash },
    });
    if (!row || !isVerificationTokenUsable(row, new Date())) {
      throw new BadRequestException(INVALID_CODE_MESSAGE);
    }

    const player = await this.prisma.player.findUniqueOrThrow({
      where: { id: row.playerId },
    });

    const alreadyVerified = player.verificationStatus === 'plugin_verified';
    const matches = verificationUsernameMatches(
      player.currentUsername,
      username,
    );
    if (!matches && !alreadyVerified) {
      throw new BadRequestException(INVALID_CODE_MESSAGE);
    }

    const renamed = alreadyVerified && !matches;
    const newUsername = username.trim();
    const targetUsernameKey = renamed
      ? newUsername.toLowerCase()
      : player.usernameKey;

    // Only one Player may hold a username verified; re-home onto an existing
    // one unless a stored tracking id actively disagrees.
    const otherVerified = await this.prisma.player.findFirst({
      where: {
        usernameKey: targetUsernameKey,
        verificationStatus: 'plugin_verified',
        id: { not: player.id },
      },
    });
    if (otherVerified) {
      const confirmedSameAccount =
        otherVerified.trackingIdHash == null ||
        (row.trackingIdHash != null &&
          row.trackingIdHash === otherVerified.trackingIdHash);

      if (confirmedSameAccount) {
        const backfillTrackingId =
          row.trackingIdHash && otherVerified.trackingIdHash == null;

        await this.prisma.$transaction([
          this.prisma.playerVerificationToken.update({
            where: { id: row.id },
            data: { consumedAt: new Date() },
          }),
          this.prisma.member.update({
            where: { id: row.memberId },
            data: { playerId: otherVerified.id },
          }),
          ...(backfillTrackingId
            ? [
                this.prisma.player.update({
                  where: { id: otherVerified.id },
                  data: { trackingIdHash: row.trackingIdHash },
                }),
              ]
            : []),
        ]);

        const session = await this.playerAccess.issue(otherVerified.id);

        return {
          player_id: otherVerified.id,
          username: otherVerified.currentUsername,
          verification_status: otherVerified.verificationStatus,
          access_token: session.token,
          access_token_expires_at: session.expiresAt.toISOString(),
        };
      }
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.playerVerificationToken.update({
          where: { id: row.id },
          data: { consumedAt: new Date() },
        });

        const conflicts = await tx.player.findMany({
          where: {
            usernameKey: targetUsernameKey,
            verificationStatus: 'unverified',
            id: { not: player.id },
          },
        });
        for (const conflict of conflicts) {
          const placeholder = generateUnverifiedPlaceholder();
          await tx.player.update({
            where: { id: conflict.id },
            data: {
              currentUsername: placeholder,
              usernameKey: placeholder.toLowerCase(),
            },
          });
        }

        if (renamed) {
          await tx.playerUsernameHistory.create({
            data: { playerId: player.id, username: newUsername },
          });
        }

        return tx.player.update({
          where: { id: player.id },
          data: {
            verificationStatus: 'plugin_verified',
            verifiedAt: new Date(),
            ...(row.trackingIdHash
              ? { trackingIdHash: row.trackingIdHash }
              : {}),
            ...(renamed
              ? { currentUsername: newUsername, usernameKey: targetUsernameKey }
              : {}),
          },
        });
      });

      const session = await this.playerAccess.issue(updated.id);

      return {
        player_id: updated.id,
        username: updated.currentUsername,
        verification_status: updated.verificationStatus,
        access_token: session.token,
        access_token_expires_at: session.expiresAt.toISOString(),
      };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'That username was just verified by another player',
        );
      }
      throw err;
    }
  }

  async tryAutoVerify(
    memberId: string,
    currentPlayerId: string,
    usernameKey: string,
    trackingId: string,
  ): Promise<boolean> {
    const canonical = await this.prisma.player.findFirst({
      where: {
        usernameKey,
        trackingIdHash: hashTrackingId(trackingId),
        verificationStatus: 'plugin_verified',
        id: { not: currentPlayerId },
      },
      select: { id: true },
    });
    if (!canonical) return false;

    await this.prisma.member.update({
      where: { id: memberId },
      data: { playerId: canonical.id },
    });
    return true;
  }

  async checkTokenStatus(
    groupName: string,
    authorization: string | undefined,
    code: string,
  ) {
    await this.access.read(groupName, authorization);

    const tokenHash = hashVerificationToken(code);
    const row = await this.prisma.playerVerificationToken.findFirst({
      where: { tokenHash },
      select: { consumedAt: true },
    });

    return { consumed: row?.consumedAt != null };
  }
}
