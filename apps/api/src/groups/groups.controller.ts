import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  Sse,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { allowDevReset, isProduction } from '../config/env';
import { GroupAchievementsService } from './achievements.service';
import { GroupAccessService, visibleChangeKind } from './group-access.service';
import { GroupEventsService } from './group-events.service';
import { GroupExportService } from './group-export.service';
import { MemberActivityService } from './member-activity.service';
import { GroupQuestsService } from './quests.service';
import { GroupSnapshotService } from './group-snapshot.service';
import { GroupsSeedService } from './groups-seed.service';
import { redactWireEntries, type WireEntry } from './group-wire';
import {
  AddMemberBody,
  ConfirmGroupDeletionBody,
  CreateAchievementBody,
  CreateGroupBody,
  DropRulesBody,
  MemberNameBody,
  RenameMemberBody,
  ReportKillsBody,
  ReportDropBody,
  UpdateGroupSettingsBody,
  UpdateMemberAchievementsBody,
  UpdateMemberBody,
  UpdateMemberProfileBody,
  UpdateMemberQuestsBody,
  PlayerMovedBody,
  SetLocationSharingBody,
  SyncGroupModeBody,
  SetTargetBody,
  SetMemberOnlineBody,
} from './group.types';
import { GroupsService } from './groups.service';
import { PlayerAccessService } from './player-access.service';
import { PlayerDataService } from './player-data.service';
import { PlayerDeletionService } from './player-deletion.service';
import { ConfirmPlayerDeletionBody } from './player-deletion.types';
import { isCredentialFresh } from './player-deletion';
import { PlayerAuthGuard, type AuthedPlayerRequest } from './player-auth.guard';
import { PlayerVerificationService } from './player-verification.service';
import {
  RedeemVerificationTokenBody,
  RequestVerificationTokenBody,
} from './player-verification.types';

const VERIFY_LIMIT = isProduction() ? 5 : 50;

/**
 * A group name may hold spaces and non-ASCII, neither of which belongs in a
 * download filename, so the stem is reduced to a safe slug.
 */
function exportBasename(groupName: string): string {
  const slug = groupName
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const day = new Date().toISOString().slice(0, 10);
  return `rs3-group-ironman-${slug || 'group'}-${day}`;
}

/** `filename` is ASCII-only by construction, so no RFC 5987 form is needed. */
function contentDisposition(filename: string): string {
  return `attachment; filename="${filename}"`;
}

/**
 * Unauthenticated routes only — rate limited. The authed
 * group/:groupName controller below is intentionally NOT throttled.
 */
@Controller()
@UseGuards(ThrottlerGuard)
export class GroupsPublicController {
  constructor(
    private readonly groups: GroupsService,
    private readonly seed: GroupsSeedService,
  ) {}

  @Post('create-group')
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  createGroup(@Body() body: CreateGroupBody) {
    return this.groups.createGroup(body);
  }

  @Get('public-groups')
  @Header('Cache-Control', 'no-store')
  publicGroups(@Query('q') query?: string, @Query('limit') limit?: string) {
    return this.groups.findPublicGroups(query, limit);
  }

  @Get('leaderboard')
  @Header('Cache-Control', 'no-store')
  leaderboard(
    @Query('metric') metric?: string,
    @Query('period') period?: string,
    @Query('limit') limit?: string,
  ) {
    return this.groups.getLeaderboard(metric, period, limit);
  }

  @Post('group/:groupName/view')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  recordGroupView(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
  ) {
    return this.groups.recordGroupView(groupName, authorization);
  }

  /** Wipes the DB and reloads seed.json. Off unless ALLOW_DEV_RESET=1, never in production. */
  @Post('reset-fake-data')
  resetFakeData() {
    if (!allowDevReset()) {
      throw new NotFoundException();
    }
    return this.seed.resetFromSeed();
  }
}

/**
 * Group-scoped routes. Reads accept the seeded demo group with no
 * Authorization header; everything else needs the group token.
 * Bodies are validated by the global ValidationPipe, so handlers can rely on
 * them being present and well-formed.
 */
@Controller('group/:groupName')
export class GroupsAuthedController {
  constructor(
    private readonly groups: GroupsService,
    private readonly access: GroupAccessService,
    private readonly events$: GroupEventsService,
    private readonly exporter: GroupExportService,
    private readonly verification: PlayerVerificationService,
    private readonly snapshot: GroupSnapshotService,
    private readonly activity: MemberActivityService,
    private readonly quests: GroupQuestsService,
    private readonly achievements: GroupAchievementsService,
  ) {}

  @Get('am-i-logged-in')
  amILoggedIn(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Query('member') member?: string,
    @Query('tracking_id') trackingId?: string,
  ) {
    return this.groups.amILoggedIn(
      groupName,
      authorization,
      member,
      trackingId,
    );
  }

  @Post('verify-token')
  @HttpCode(201)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 300000 } })
  requestVerificationToken(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: RequestVerificationTokenBody,
  ) {
    return this.verification.requestToken(
      groupName,
      authorization,
      body.name,
      body.tracking_id,
    );
  }

  @Get('verify-token-status')
  verifyTokenStatus(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Query('code') code?: string,
  ) {
    if (!code) return { consumed: false };
    return this.verification.checkTokenStatus(groupName, authorization, code);
  }

  /**
   * Server-sent events: a snapshot on connect, then `split`-style deltas
   * coalesced to at most one every 750ms. A client on this stream stops
   * calling get-group-data; one that cannot stream keeps polling, so this is
   * purely additive.
   *
   * Auth is the usual Authorization header, so browsers must use fetch
   * streaming rather than EventSource, which cannot set headers.
   */
  // Belt and braces with nginx's proxy_buffering: a buffered stream fails
  // silently, with no error anywhere.
  @Header('X-Accel-Buffering', 'no')
  @Header('Cache-Control', 'no-cache, no-transform')
  @Sse('events')
  async events(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<Observable<MessageEvent>> {
    // Both checks run before the stream is returned, so a rejection is a clean
    // HTTP error rather than a stream that opens and closes immediately.
    const group = await this.access.readWithoutMembers(
      groupName,
      authorization,
    );
    if (!this.events$.hasCapacityFor(group.id)) {
      throw new ServiceUnavailableException('Too many open streams');
    }
    return this.events$.stream(group.id).pipe(
      map((event) => {
        const data = Array.isArray(event.data)
          ? redactWireEntries(event.data as WireEntry[], group.scope)
          : event.data;
        const kinds = event.kinds?.filter((kind) =>
          visibleChangeKind(kind, group.scope),
        );
        return { type: event.type, data: { ...event, data, kinds } };
      }),
    );
  }

  /**
   * `split=1` opts into partial members: one whose position changed but whose
   * inventories and skills did not comes back marked `partial: true` for the
   * client to merge. Without it the format is unchanged, so the plugin and any
   * cached browser bundle are unaffected.
   */
  @Get('get-group-data')
  getGroupData(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Query('from_time') fromTime?: string,
    @Query('split') split?: string,
  ) {
    return this.snapshot.getGroupData(
      groupName,
      authorization,
      fromTime,
      split === '1' || split === 'true',
    );
  }

  @Get('xp-history')
  getXpHistory(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Query('period') period?: string,
    @Query('skill') skill?: string,
  ) {
    return this.groups.getXpHistory(groupName, authorization, period, skill);
  }

  /**
   * Shared ("group") bank movement log, newest first.
   * `from`/`to` are ISO instants bounding a calendar day in the viewer's
   * timezone; `before` pages backwards within that range.
   */
  @Get('bank-ledger')
  getBankLedger(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.groups.getBankLedger(
      groupName,
      authorization,
      limit,
      before,
      from,
      to,
    );
  }

  /**
   * Group achievement feed, newest first. `before` pages backwards;
   * `kind`/`member` narrow it. Invalid filters are ignored, not rejected.
   */
  @Get('achievements')
  getAchievements(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('kind') kind?: string,
    @Query('member') member?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.achievements.getAchievements(
      groupName,
      authorization,
      limit,
      before,
      kind,
      member,
      from,
      to,
    );
  }

  @Post('achievements')
  @HttpCode(201)
  createAchievement(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: CreateAchievementBody,
  ) {
    return this.achievements.createAchievement(groupName, authorization, body);
  }

  /**
   * Quest progress per member, keyed by gameval name. Only started/finished
   * quests are listed; anything absent is not started.
   */
  @Get('quests')
  getQuests(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
  ) {
    return this.quests.getMemberQuests(groupName, authorization);
  }

  /** Plugin quest sync. Newly finished quests also land in the achievement feed. */
  @Post('update-member-quests')
  @HttpCode(200)
  updateMemberQuests(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: UpdateMemberQuestsBody,
  ) {
    return this.quests.updateMemberQuests(groupName, authorization, body);
  }

  /**
   * Completed RS3 achievements and diaries per member, keyed by gameval.
   * Anything absent is not complete.
   */
  @Get('achievement-progress')
  getAchievementProgress(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
  ) {
    return this.achievements.getMemberAchievements(groupName, authorization);
  }

  /** Plugin achievement sync. Newly completed ones also land in the feed. */
  @Post('update-member-achievements')
  @HttpCode(200)
  updateMemberAchievements(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: UpdateMemberAchievementsBody,
  ) {
    return this.achievements.updateMemberAchievements(groupName, authorization, body);
  }

  @Post('update-group-member')
  @HttpCode(200)
  updateGroupMember(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: UpdateMemberBody,
  ) {
    return this.groups.updateGroupMember(groupName, authorization, body);
  }

  /** Lightweight live map ping — updates [x, y, plane?] only. */
  @Post('player-moved')
  @HttpCode(200)
  playerMoved(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: PlayerMovedBody,
  ) {
    return this.activity.playerMoved(groupName, authorization, body);
  }

  /** The group's drop rules: value threshold plus its own item opinions. */
  @Get('drop-rules')
  getDropRules(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
  ) {
    return this.achievements.getDropRules(groupName, authorization);
  }

  @Post('drop-rules')
  @HttpCode(200)
  updateDropRules(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: DropRulesBody,
  ) {
    return this.achievements.updateDropRules(groupName, authorization, body);
  }

  /** A drop the plugin saw; recorded only when the group's rules keep it. */
  @Post('report-drop')
  @HttpCode(200)
  reportDrop(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: ReportDropBody,
  ) {
    return this.achievements.reportDrop(groupName, authorization, body);
  }

  /** NPC kills since the member's last report; counts are added, not set. */
  @Post('report-kills')
  @HttpCode(200)
  reportKills(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: ReportKillsBody,
  ) {
    return this.activity.reportKills(groupName, authorization, body);
  }

  /** Kill counts per member, biggest first. */
  @Get('npc-kills')
  getNpcKills(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
  ) {
    return this.activity.getNpcKills(groupName, authorization);
  }

  /** What a member is fighting; an absent target clears it. */
  @Post('set-target')
  @HttpCode(200)
  setTarget(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: SetTargetBody,
  ) {
    return this.activity.setTarget(groupName, authorization, body);
  }

  /** The plugin syncing the group's ruleset from the account's varbits. */
  @Post('sync-group-mode')
  @HttpCode(200)
  syncGroupMode(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: SyncGroupModeBody,
  ) {
    return this.activity.syncGroupMode(groupName, authorization, body);
  }

  /** Opt a member in or out of the live map. */
  @Post('set-location-sharing')
  @HttpCode(200)
  setLocationSharing(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: SetLocationSharingBody,
  ) {
    return this.activity.setLocationSharing(groupName, authorization, body);
  }

  /** Mark a member online/offline (plugin login/logout). */
  @Post('set-member-online')
  @HttpCode(200)
  setMemberOnline(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: SetMemberOnlineBody,
  ) {
    return this.activity.setMemberOnline(groupName, authorization, body);
  }

  @Post('add-group-member')
  addGroupMember(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: AddMemberBody,
  ) {
    return this.groups.addGroupMember(groupName, authorization, body);
  }

  @Put('update-member-profile')
  updateMemberProfile(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: UpdateMemberProfileBody,
  ) {
    return this.groups.updateMemberProfile(groupName, authorization, body);
  }

  @Put('update-group-settings')
  updateGroupSettings(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: UpdateGroupSettingsBody,
  ) {
    return this.groups.updateGroupSettings(groupName, authorization, body);
  }

  @Delete('delete-group-member')
  deleteGroupMember(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: MemberNameBody,
  ) {
    return this.groups.deleteGroupMember(groupName, authorization, body);
  }

  /**
   * Everything we hold about the group, as one JSON document. The unbounded
   * series (XP samples, ledger, feed) and the screenshots are not in here —
   * `export.zip` is what adds those.
   */
  @Get('export')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 6, ttl: 60000 } })
  async exportJson(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const group = await this.access.write(groupName, authorization);
    const state = await this.exporter.buildStateDocument(group.name);
    if (!state) throw new NotFoundException('Group not found');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(`${exportBasename(group.name)}.json`),
    );
    return state.document;
  }

  /**
   * The same document plus the full time series and every uploaded screenshot,
   * streamed as a ZIP so a group with hundreds of images never has to be held
   * in memory.
   *
   * Headers go out before the body is built, so a mid-stream failure can only
   * truncate the download. The archive is written with no `Content-Length` for
   * the same reason: its size is not known until the last entry is in.
   */
  // The guard runs before auth, so a rejected request spends budget too. The
  // limit is sized for that: enough that a retry after a failed download is
  // never blocked, few enough that the R2 reads cannot be used as an amplifier.
  @Get('export.zip')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 300000 } })
  async exportZip(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Res() res: Response,
  ) {
    const group = await this.access.write(groupName, authorization);
    const state = await this.exporter.buildStateDocument(group.name);
    if (!state) throw new NotFoundException('Group not found');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(`${exportBasename(group.name)}.zip`),
    );
    // nginx would otherwise buffer the whole archive before forwarding a byte.
    res.setHeader('X-Accel-Buffering', 'no');

    await this.exporter.writeArchive(res, group.name, state);
    res.end();
  }

  /**
   * Erasure request for everything this group holds. Takes the group name and
   * token again in the body on top of the usual header, so a stolen session or
   * a stray click cannot start it.
   */
  @Post('request-deletion')
  @HttpCode(200)
  requestDeletion(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: ConfirmGroupDeletionBody,
  ) {
    return this.groups.requestGroupDeletion(groupName, authorization, body);
  }

  /** Calls off a pending erasure. Safe direction, so the token alone is enough. */
  @Post('cancel-deletion')
  @HttpCode(200)
  cancelDeletion(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
  ) {
    return this.groups.cancelGroupDeletion(groupName, authorization);
  }

  @Put('rename-group-member')
  renameGroupMember(
    @Param('groupName') groupName: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: RenameMemberBody,
  ) {
    return this.groups.renameGroupMember(groupName, authorization, body);
  }
}

@Controller('players')
@UseGuards(ThrottlerGuard)
export class PlayersController {
  constructor(
    private readonly verification: PlayerVerificationService,
    private readonly playerAccess: PlayerAccessService,
    private readonly playerDeletion: PlayerDeletionService,
    private readonly playerData: PlayerDataService,
  ) {}

  @Post('verify')
  @HttpCode(200)
  @Throttle({ default: { limit: VERIFY_LIMIT, ttl: 300000 } })
  verify(@Body() body: RedeemVerificationTokenBody) {
    return this.verification.redeem(body.code, body.username);
  }

  @Get('me')
  @UseGuards(PlayerAuthGuard)
  @Header('Cache-Control', 'no-store')
  me(@Req() req: AuthedPlayerRequest) {
    return this.playerAccess.getProfile(req.playerId);
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(PlayerAuthGuard)
  async logout(@Req() req: AuthedPlayerRequest) {
    await this.playerAccess.revoke(req.playerAccessToken);
    return { ok: true };
  }

  @Post('rotate')
  @HttpCode(200)
  @UseGuards(PlayerAuthGuard)
  async rotate(@Req() req: AuthedPlayerRequest) {
    const next = await this.playerAccess.rotate(req.playerAccessToken);
    if (!next) throw new UnauthorizedException('Invalid or expired session');
    return {
      access_token: next.token,
      access_token_expires_at: next.expiresAt.toISOString(),
    };
  }

  @Post('request-deletion')
  @HttpCode(200)
  @UseGuards(PlayerAuthGuard)
  @Throttle({ default: { limit: 3, ttl: 300000 } })
  requestDeletion(
    @Req() req: AuthedPlayerRequest,
    @Body() body: ConfirmPlayerDeletionBody,
  ) {
    if (!isCredentialFresh(req.credentialCreatedAt, new Date())) {
      throw new UnauthorizedException(
        'Re-verify through the plugin to confirm this is you before deleting',
      );
    }
    return this.playerDeletion.requestDeletion(
      req.playerId,
      body.confirm_username,
    );
  }

  @Post('cancel-deletion')
  @HttpCode(200)
  @UseGuards(PlayerAuthGuard)
  cancelDeletion(@Req() req: AuthedPlayerRequest) {
    return this.playerDeletion.cancelDeletion(req.playerId);
  }

  @Get('me/data')
  @UseGuards(PlayerAuthGuard)
  @Header('Cache-Control', 'no-store')
  myData(@Req() req: AuthedPlayerRequest) {
    return this.playerData.buildDocument(req.playerId);
  }

  @Get('me/export.zip')
  @UseGuards(PlayerAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 300000 } })
  async myExportZip(@Req() req: AuthedPlayerRequest, @Res() res: Response) {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Cache-Control', 'no-store');
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader(
      'Content-Disposition',
      contentDisposition(`rs3-group-ironman-my-data-${day}.zip`),
    );
    res.setHeader('X-Accel-Buffering', 'no');

    await this.playerData.writeExportArchive(res, req.playerId);
    res.end();
  }

  @Get('sessions')
  @UseGuards(PlayerAuthGuard)
  @Header('Cache-Control', 'no-store')
  sessions(@Req() req: AuthedPlayerRequest) {
    return this.playerAccess.listSessions(req.playerId, req.playerAccessToken);
  }

  @Post('sessions/:id/revoke')
  @HttpCode(200)
  @UseGuards(PlayerAuthGuard)
  async revokeSession(
    @Req() req: AuthedPlayerRequest,
    @Param('id') id: string,
  ) {
    await this.playerAccess.revokeById(req.playerId, id);
    return { ok: true };
  }
}
