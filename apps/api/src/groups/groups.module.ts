import { Module } from '@nestjs/common';
import { R2Module } from '../uploads/r2.module';
import { GroupAchievementsService } from './achievements.service';
import { GroupAccessService } from './group-access.service';
import { GroupChangeNotifier } from './group-change-notifier.service';
import { GroupEventsService } from './group-events.service';
import { GroupExportService } from './group-export.service';
import { GroupPurgeService } from './group-purge.service';
import { GroupSnapshotService } from './group-snapshot.service';
import { InventoryStorageService } from './inventory-storage.service';
import { MemberActivityService } from './member-activity.service';
import { GroupQuestsService } from './quests.service';
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
    GroupChangeNotifier,
    GroupsService,
    GroupsSeedService,
    GroupExportService,
    GroupPurgeService,
    GroupSnapshotService,
    MemberActivityService,
    GroupQuestsService,
    GroupAchievementsService,
    InventoryStorageService,
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
  // write, so it gets GroupChangeNotifier (to raise the change broadcast) and
  // GroupPurgeService (to erase a group on demand).
  exports: [
    GroupAccessService,
    GroupChangeNotifier,
    GroupEventsService,
    GroupsService,
    GroupPurgeService,
  ],
})
export class GroupsModule {}
