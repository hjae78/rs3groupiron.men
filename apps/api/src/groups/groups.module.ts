import { Module } from '@nestjs/common';
import { R2Module } from '../uploads/r2.module';
import { GroupAccessService } from './group-access.service';
import { GroupEventsService } from './group-events.service';
import { GroupExportService } from './group-export.service';
import { GroupPurgeService } from './group-purge.service';
import { GroupsSeedService } from './groups-seed.service';
import {
  GroupsAuthedController,
  GroupsPublicController,
  PlayersController,
} from './groups.controller';
import { GroupsService } from './groups.service';
import { PlayerAccessService } from './player-access.service';
import { PlayerAuthGuard } from './player-auth.guard';
import { PlayerDataService } from './player-data.service';
import { PlayerDeletionService } from './player-deletion.service';
import { PlayerVerificationService } from './player-verification.service';
import { XpHistoryService } from './xp-history.service';

@Module({
  imports: [R2Module],
  controllers: [GroupsPublicController, GroupsAuthedController, PlayersController],
  providers: [
    GroupAccessService,
    GroupsService,
    GroupsSeedService,
    GroupExportService,
    GroupPurgeService,
    PlayerVerificationService,
    PlayerAccessService,
    PlayerAuthGuard,
    PlayerDeletionService,
    PlayerDataService,
    XpHistoryService,
    GroupEventsService,
  ],
  // The uploads module takes GroupAccessService alone: it needs a permission
  // check, not the write paths. The admin module is the one consumer that does
  // write, so it gets GroupsService (for the change broadcast) and
  // GroupPurgeService (to erase a group on demand).
  exports: [
    GroupAccessService,
    GroupEventsService,
    GroupsService,
    GroupPurgeService,
  ],
})
export class GroupsModule {}
