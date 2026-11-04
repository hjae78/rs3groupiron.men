import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_ACHIEVEMENT_UPDATES } from './achievement-sync';
import { MAX_QUEST_UPDATES, QUEST_STATE_INPUTS } from './quests';

/**
 * RS3 group member vitals packed as:
 * [hpCur, hpMax, prayCur, prayMax, summonCur, summonMax, world?, weightKg?]
 */
export type MemberStats = number[];

/** Flat [itemId, qty, itemId, qty, ...] */
export type ItemPairs = number[];

export type WireSkill = {
  id: string;
  xp: number;
  level: number;
  baseLevel: number;
};

export type SkillPayloadValue =
  number | { xp?: number; level?: number; baseLevel?: number };

export type GroupMember = {
  name: string;
  nickname?: string;
  discord_id?: string;
  color?: string;
  use_discord_avatar?: boolean;
  online?: boolean;
  last_updated: string;
  stats: MemberStats;
  coordinates: number[];
  inventory: ItemPairs;
  bank: ItemPairs;
  equipment: ItemPairs;
  /** Extra inventories keyed by inv gameval; absent when there are none. */
  inventories?: Record<string, ItemPairs>;
  skills?: Record<string, SkillPayloadValue>;
  shared_bank?: ItemPairs;
  deposited?: ItemPairs;
};

export type GroupRecord = {
  name: string;
  token: string;
  mode?: 'normal' | 'competitive';
  appearance?: 'rs3' | 'modern';
  member_slots?: number;
  created_at: string;
  members: GroupMember[];
};

export type StoreFile = {
  groups: GroupRecord[];
};

export const SHARED_MEMBER = '@SHARED';
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 5;
export const MAX_NAME_LENGTH = 12;
export const MAX_GROUP_NAME_LENGTH = 20;

/** Upper bound on any incoming name string before service-level validation. */
const MAX_INPUT_NAME = 50;

export const MAX_STATS = 16;
export const MAX_COORDINATES = 3;
export const MAX_INVENTORY = 56;
export const MAX_EQUIPMENT = 40;
/** 4000 items as [id, qty] pairs; RS3 banks top out well under that. */
export const MAX_BANK = 8000;
export const MAX_DEPOSITED = 8000;
export const MAX_SHARED_BANK = 8000;
export const MAX_MEMBER_NAMES = 10;
/** Distinct inventories one update may carry (inv, worn, bank, pouches...). */
export const MAX_INVENTORIES = 32;

/** Item ids one drop-rules request may carry per field. */
export const MAX_DROP_RULES = 500;

/** Distinct NPC names one kill report may carry, and kills per name. */
export const MAX_KILL_NAMES = 200;
export const MAX_KILLS_PER_REPORT = 10_000;

export const MAX_ACHIEVEMENT_TITLE = 120;
export const MAX_ACHIEVEMENT_DETAIL = 300;
export const MAX_ACHIEVEMENT_IMAGE_URL = 500;
export const MAX_GAMEVAL_NAME = 128;

/** Postgres Int4 upper bound; larger values would 500 inside Prisma. */
const MAX_INT32 = 2_147_483_647;

export class GroupSharesInput {
  @IsOptional()
  @IsBoolean()
  map?: boolean;

  @IsOptional()
  @IsBoolean()
  skills?: boolean;

  @IsOptional()
  @IsBoolean()
  items?: boolean;

  @IsOptional()
  @IsBoolean()
  quests?: boolean;

  @IsOptional()
  @IsBoolean()
  achievements?: boolean;
}

export class CreateGroupBody {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  name!: string;

  @IsOptional()
  @IsIn(['private', 'public'])
  visibility?: 'private' | 'public';

  @IsOptional()
  @ValidateNested()
  @Type(() => GroupSharesInput)
  shares?: GroupSharesInput;

  /** Fixed capacity 2–5; must match member_names length when provided. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_MEMBERS)
  @Max(MAX_MEMBERS)
  member_slots?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEMBER_NAMES)
  @IsString({ each: true })
  @MaxLength(MAX_INPUT_NAME, { each: true })
  member_names?: string[];
}

export class UpdateMemberBody {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  name!: string;

  /**
   * Vitals may arrive as doubles from the plugin; rounded server-side. The
   * floor is signed because the weight slot goes negative with weight-reducing
   * gear; every other slot is clamped back to zero by `statsFromArray`.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_STATS)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  @Min(-MAX_INT32, { each: true })
  @Max(MAX_INT32, { each: true })
  stats?: MemberStats;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_COORDINATES)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  @Min(0, { each: true })
  @Max(MAX_INT32, { each: true })
  coordinates?: number[];

  /** Game world number. Also the 7th `stats` element, which this overrides. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_INT32)
  world?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_INVENTORY)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(MAX_INT32, { each: true })
  inventory?: ItemPairs;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_BANK)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(MAX_INT32, { each: true })
  bank?: ItemPairs;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EQUIPMENT)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(MAX_INT32, { each: true })
  equipment?: ItemPairs;

  /** Keyed by skill id; values validated in the service. */
  @IsOptional()
  @IsObject()
  skills?: Record<string, SkillPayloadValue>;

  /**
   * Any inventory keyed by its RS3 inv gameval (e.g. money_pouch), each a
   * flat [itemId, qty, ...] list. `inventory`/`equipment`/`bank` above are
   * shorthands for the inv/worn/bank keys. Validated in the service.
   */
  @IsOptional()
  @IsObject()
  inventories?: Record<string, ItemPairs>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SHARED_BANK)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(MAX_INT32, { each: true })
  shared_bank?: ItemPairs;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DEPOSITED)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(MAX_INT32, { each: true })
  deposited?: ItemPairs;

  /**
   * Per-item changes instead of a full snapshot, keyed like the fields above
   * (`bank`, `equipment`, `shared_bank`, or an inv gameval). Each is a flat
   * [itemId, newTotal, ...] list; a total of 0 removes the item. The backpack
   * is positional and must always come as a full `inventory` snapshot.
   * Validated in the service.
   */
  @IsOptional()
  @IsObject()
  inventory_changes?: Record<string, ItemPairs>;

  /**
   * Set false to opt out of the group achievement feed, so level milestones
   * crossed by this update are not recorded. Defaults to true.
   */
  @IsOptional()
  @IsBoolean()
  achievements?: boolean;

  /**
   * Marks the full set a plugin sends on login. The values are what the member
   * already had, so the site must not read the jump as freshly earned XP.
   */
  @IsOptional()
  @IsBoolean()
  baseline?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  tracking_id?: string;
}

export class MemberNameBody {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  name!: string;
}

export class AddMemberBody {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  nickname?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  discord_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  color?: string;

  @IsOptional()
  @IsBoolean()
  use_discord_avatar?: boolean;
}

export class UpdateMemberProfileBody {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  nickname?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  discord_id?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  color?: string | null;

  @IsOptional()
  @IsBoolean()
  use_discord_avatar?: boolean;
}

/** Lightweight location ping from the plugin / client. */
export class PlayerMovedBody {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  name!: string;

  /** [x, y] or [x, y, plane]; doubles accepted and rounded server-side. */
  @IsArray()
  @ArrayMaxSize(MAX_COORDINATES)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  @Min(0, { each: true })
  @Max(MAX_INT32, { each: true })
  coordinates!: number[];
}

/** Mark a member online or offline (plugin login/logout / heartbeat). */
export class SetMemberOnlineBody {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  name!: string;

  @IsBoolean()
  online!: boolean;

  /** Online but sitting on the lobby screen, so there is no position to plot. */
  @IsOptional()
  @IsBoolean()
  in_lobby?: boolean;
}

/** Opt this member in or out of the live map. */
/**
 * The plugin reporting the ruleset it read from the account's varbits, so the
 * group's mode follows the game rather than being picked by hand.
 */
export class SyncGroupModeBody {
  @IsIn(['normal', 'competitive'])
  mode!: 'normal' | 'competitive';
}

export class SetLocationSharingBody {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  name!: string;

  @IsBoolean()
  shared!: boolean;
}

/**
 * A stack-size window for one tracked item: only announce a drop of it when
 * the quantity falls inside. Either end may be null, which clears that end,
 * so both null means "any amount".
 */
export class DropQuantityInput {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_INT32)
  item_id!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_INT32)
  min?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_INT32)
  max?: number | null;
}

/** Per-group drop rules: a value threshold plus item opinions. */
export class DropRulesBody {
  /** Coin value at or above which any drop counts. 0 turns the rule off. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_INT32)
  threshold?: number;

  /** Item ids to announce even when the shared list lacks them. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DROP_RULES)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_INT32, { each: true })
  include?: number[];

  /** Item ids to stay quiet about, even when the shared list has them. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DROP_RULES)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_INT32, { each: true })
  exclude?: number[];

  /** Item ids to forget, handing the decision back to the shared list. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DROP_RULES)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_INT32, { each: true })
  clear?: number[];

  /**
   * Stack-size windows. Setting one on an item the group does not track yet
   * adds it, so the range and the item can arrive in one request.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DROP_RULES)
  @ValidateNested({ each: true })
  @Type(() => DropQuantityInput)
  quantities?: DropQuantityInput[];
}

/** NPC names a member has killed since the last report, with counts. */
export class NpcKillInput {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  npc!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_KILLS_PER_REPORT)
  kills!: number;
}

export class ReportKillsBody {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  name!: string;

  @IsArray()
  @ArrayMaxSize(MAX_KILL_NAMES)
  @ValidateNested({ each: true })
  @Type(() => NpcKillInput)
  kills!: NpcKillInput[];
}

/** What a member is fighting. An absent name clears it. */
export class SetTargetBody {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  target?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_INT32)
  hp?: number;

  /** Share of the target's health bar still filled, 0-100. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  percent?: number;
}

/** A drop the plugin noticed; the server decides whether it is worth posting. */
export class ReportDropBody {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  name!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_INT32)
  item_id!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_INT32)
  quantity?: number;

  /** Item name as the client knows it; the server has no obj name table. */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ACHIEVEMENT_TITLE)
  item_name?: string;

  /** NPC the drop came from, when the plugin could tell. */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  source?: string;

  /** The client's own value for one of them, used by the group threshold. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_INT32)
  value?: number;
}

export class UpdateGroupSettingsBody {
  @IsOptional()
  @IsIn(['rs3', 'modern'])
  appearance?: 'rs3' | 'modern';

  /** Rename the group (unique). */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  name?: string;

  @IsOptional()
  @IsIn(['private', 'public'])
  visibility?: 'private' | 'public';

  @IsOptional()
  @ValidateNested()
  @Type(() => GroupSharesInput)
  shares?: GroupSharesInput;
}

export class ConfirmGroupDeletionBody {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  confirm_name!: string;

  @IsString()
  @MaxLength(200)
  confirm_token!: string;
}

export const MAX_SEARCH_QUERY = 50;
export const PUBLIC_GROUPS_LIMIT = 24;
export const MAX_PUBLIC_GROUPS_LIMIT = 50;

export class RenameMemberBody {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  original_name!: string;

  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  new_name!: string;
}

/** Plugin/web posted achievement. `image_url` is CDN-restricted in the service. */
export class CreateAchievementBody {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  name!: string;

  @IsIn(['level', 'drop', 'quest', 'diary', 'other'])
  kind!: 'level' | 'drop' | 'quest' | 'diary' | 'other';

  @IsString()
  @MaxLength(MAX_ACHIEVEMENT_TITLE)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ACHIEVEMENT_DETAIL)
  detail?: string;

  /** Must exist in the skills catalog; checked in the service. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  skill_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_INT32)
  item_id?: number;

  /**
   * RS3 gameval name for quest/diary/other kinds, e.g. quest_cooks_assistant.
   * Must exist in the gameval table for the kind; checked in the service.
   */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_GAMEVAL_NAME)
  gameval?: string;

  /**
   * Cache id alternative to `gameval` for plugins that only see ids. Resolved
   * to the name server-side; ignored when `gameval` is also given.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_INT32)
  gameval_id?: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ACHIEVEMENT_IMAGE_URL)
  image_url?: string;

  /** ISO timestamp; unparseable values fall back to now. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  achieved_at?: string;
}

/** One achievement reference: `gameval` wins over `achievement_id`. */
export class AchievementRefInput {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_INT32)
  achievement_id?: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_GAMEVAL_NAME)
  gameval?: string;
}

/**
 * Plugin-posted achievement completions. Send `full: true` with the member's
 * whole completed list (e.g. on login) so anything missing is cleared;
 * otherwise the listed ones are simply added.
 */
/** Progress towards a counted achievement, e.g. 37 of 50 kills. */
export class AchievementTallyInput {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_INT32)
  achievement_id?: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_GAMEVAL_NAME)
  gameval?: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_INT32)
  progress!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_INT32)
  target!: number;
}

export class UpdateMemberAchievementsBody {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  name!: string;

  @IsArray()
  @ArrayMaxSize(MAX_ACHIEVEMENT_UPDATES)
  @ValidateNested({ each: true })
  @Type(() => AchievementRefInput)
  completed!: AchievementRefInput[];

  @IsOptional()
  @IsBoolean()
  full?: boolean;

  /** Set false to skip the group achievement feed. Defaults to true. */
  @IsOptional()
  @IsBoolean()
  achievements?: boolean;

  /**
   * Counted achievements in progress. Sent alongside `completed`, and a
   * `full` update replaces the stored set rather than merging into it.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ACHIEVEMENT_UPDATES)
  @ValidateNested({ each: true })
  @Type(() => AchievementTallyInput)
  tallies?: AchievementTallyInput[];
}

/** One quest reference: `gameval` wins over `quest_id` when both are sent. */
export class QuestStateInput {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_INT32)
  quest_id?: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_GAMEVAL_NAME)
  gameval?: string;

  @IsIn(QUEST_STATE_INPUTS)
  state!: (typeof QUEST_STATE_INPUTS)[number];
}

/**
 * Plugin-posted quest progress. Send `full: true` with the member's whole
 * quest list (e.g. on login) so anything missing is reset to not started;
 * otherwise only the listed quests change.
 */
export class UpdateMemberQuestsBody {
  @IsString()
  @MaxLength(MAX_INPUT_NAME)
  name!: string;

  @IsArray()
  @ArrayMaxSize(MAX_QUEST_UPDATES)
  @ValidateNested({ each: true })
  @Type(() => QuestStateInput)
  quests!: QuestStateInput[];

  @IsOptional()
  @IsBoolean()
  full?: boolean;

  /**
   * Set false to opt out of the group achievement feed, so quests finished by
   * this update are not recorded. Defaults to true.
   */
  @IsOptional()
  @IsBoolean()
  achievements?: boolean;
}
