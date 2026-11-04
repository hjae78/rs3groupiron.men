import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { R2Service } from '../uploads/r2.service';
import { PlayerDeletionService } from './player-deletion.service';

const DEFAULT_SWEEP_MS = 60 * 60 * 1000;

@Injectable()
export class GroupPurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GroupPurgeService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Service,
    private readonly playerDeletion: PlayerDeletionService,
  ) {}

  private get sweepMs(): number {
    const raw = Number(process.env.GROUP_PURGE_SWEEP_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SWEEP_MS;
  }

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.GROUP_PURGE_DISABLED) {
      return;
    }
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.sweepMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = await this.prisma.group.findMany({
        where: { deleteAfter: { lte: now } },
        select: { id: true, name: true },
      });
      let purged = 0;
      for (const group of due) {
        try {
          await this.purgeGroup(group.id);
          purged += 1;
          this.logger.log(`purged group "${group.name}" (${group.id})`);
        } catch (err) {
          this.logger.error(
            `failed to purge group "${group.name}" (${group.id})`,
            err instanceof Error ? err.stack : undefined,
          );
        }
      }
      purged += await this.sweepPlayers(now);
      return purged;
    } finally {
      this.running = false;
    }
  }

  private async sweepPlayers(now: Date): Promise<number> {
    const due = await this.prisma.player.findMany({
      where: { deleteAfter: { lte: now } },
      select: { id: true, currentUsername: true },
    });
    let purged = 0;
    for (const player of due) {
      try {
        await this.playerDeletion.purgePlayer(player.id);
        purged += 1;
        this.logger.log(
          `purged player "${player.currentUsername}" (${player.id})`,
        );
      } catch (err) {
        this.logger.error(
          `failed to purge player "${player.currentUsername}" (${player.id})`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }
    return purged;
  }

  async purgeGroup(groupId: string) {
    // Most groups never upload a screenshot, so checking first keeps the usual
    // purge off the network entirely.
    const images = await this.prisma.achievement.count({
      where: { groupId, imageUrl: { not: null } },
    });
    if (images > 0) {
      // The database row is the retention promise, so a broken bucket must not
      // keep the group alive past its date. A failure is loud and names the
      // prefix left behind.
      try {
        await this.r2.deleteGroupImages(groupId);
      } catch (err) {
        this.logger.error(
          `uploads left behind for group ${groupId}: delete achievements/${groupId}/ by hand`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }
    await this.prisma.group.delete({ where: { id: groupId } });
  }
}
