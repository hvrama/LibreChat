import { PromptScheduleRunStatus } from 'librechat-data-provider';
import type { Model, Types, FilterQuery } from 'mongoose';
import type { TPromptScheduleSource, TPromptScheduleNotify } from 'librechat-data-provider';
import type {
  IPromptGroup,
  IPromptScheduleRun,
  PromptScheduleTrigger,
  IPromptGroupDocument,
  IPromptScheduleRunDocument,
} from '~/types';
import { isValidObjectIdString } from '~/utils/objectId';

/** Definition fields a caller may set on a group's schedule. */
export type PromptGroupScheduleFields = {
  user: string;
  agent_id: string;
  promptId?: string | null;
  cron: string;
  timezone: string;
  source: TPromptScheduleSource;
  variables?: Record<string, string>;
  enabled?: boolean;
  notify?: Partial<TPromptScheduleNotify>;
  chatProjectId?: string | null;
  nextRunAt: Date | null;
};

export type PromptGroupSchedulePatch = Partial<
  Omit<PromptGroupScheduleFields, 'user' | 'notify'>
> & { notify?: TPromptScheduleNotify };

export type ClaimDuePromptGroupSchedulesInput = {
  now?: Date;
  lockOwner: string;
  leaseMs: number;
  limit?: number;
};

export type ClaimPromptGroupScheduleInput = {
  groupId: string;
  now?: Date;
  lockOwner: string;
  leaseMs: number;
};

export type PromptGroupScheduleLockInput = {
  groupId: string;
  lockOwner: string;
  leaseMs: number;
  now?: Date;
};

export type CompletePromptGroupScheduleRunInput = {
  groupId: string;
  lockOwner: string;
  status: PromptScheduleRunStatus;
  errorMessage?: string | null;
  conversationId?: string | null;
  nextRunAt: Date | null;
  disable?: boolean;
};

export type CreatePromptScheduleRunInput = {
  promptGroupId: string;
  user: string;
  status: PromptScheduleRunStatus;
  trigger: PromptScheduleTrigger;
  startedAt: Date;
  finishedAt?: Date | null;
  retentionDays: number;
  conversationId?: string | null;
  shareId?: string | null;
  recipientCount?: number;
  warnings?: string[];
  errorMessage?: string | null;
};

export type ListPromptScheduleRunsInput = {
  promptGroupId: string;
  limit?: number;
};

export interface PromptScheduleMethods {
  setPromptGroupSchedule(
    groupId: string,
    fields: PromptGroupScheduleFields,
  ): Promise<IPromptGroup | null>;
  updatePromptGroupSchedule(
    groupId: string,
    patch: PromptGroupSchedulePatch,
  ): Promise<IPromptGroup | null>;
  clearPromptGroupSchedule(groupId: string): Promise<boolean>;
  clearPromptGroupSchedulesByUser(userId: string): Promise<number>;
  listScheduledPromptGroupsByUser(userId: string): Promise<IPromptGroup[]>;
  countPromptGroupSchedulesByUser(userId: string): Promise<number>;
  claimDuePromptGroupSchedules(input: ClaimDuePromptGroupSchedulesInput): Promise<IPromptGroup[]>;
  claimPromptGroupSchedule(input: ClaimPromptGroupScheduleInput): Promise<IPromptGroup | null>;
  refreshPromptGroupScheduleLock(input: PromptGroupScheduleLockInput): Promise<boolean>;
  completePromptGroupScheduleRun(
    input: CompletePromptGroupScheduleRunInput,
  ): Promise<IPromptGroup | null>;
  createPromptScheduleRun(input: CreatePromptScheduleRunInput): Promise<IPromptScheduleRun>;
  getPromptScheduleRuns(input: ListPromptScheduleRunsInput): Promise<IPromptScheduleRun[]>;
}

const DEFAULT_CLAIM_LIMIT = 10;
const DEFAULT_RUNS_LIMIT = 20;
const MAX_RUNS_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const INITIAL_RUNTIME_STATE = {
  'schedule.lastRunAt': null,
  'schedule.lastRunStatus': null,
  'schedule.lastError': null,
  'schedule.lastConversationId': null,
  'schedule.runCount': 0,
  'schedule.consecutiveFailures': 0,
  'schedule.lockOwner': null,
  'schedule.lockExpiresAt': null,
};

function unlockedFilter(now: Date): FilterQuery<IPromptGroupDocument> {
  return {
    $or: [
      { 'schedule.lockExpiresAt': null },
      { 'schedule.lockExpiresAt': { $exists: false } },
      { 'schedule.lockExpiresAt': { $lte: now } },
    ],
  };
}

function dotted(patch: Record<string, unknown>): Record<string, unknown> {
  const $set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    $set[`schedule.${key}`] = value;
  }
  return $set;
}

export function createPromptScheduleMethods(
  mongoose: typeof import('mongoose'),
): PromptScheduleMethods {
  const { ObjectId } = mongoose.Types;

  const getGroupModel = () => mongoose.models.PromptGroup as Model<IPromptGroupDocument>;
  const getRunModel = () => mongoose.models.PromptScheduleRun as Model<IPromptScheduleRunDocument>;

  function toObjectId(value: string | null | undefined): Types.ObjectId | null {
    return value && isValidObjectIdString(value) ? new ObjectId(value) : null;
  }

  function definitionPaths(patch: PromptGroupSchedulePatch): Record<string, unknown> {
    const { promptId, notify, ...rest } = patch;
    return dotted({
      ...rest,
      ...(promptId !== undefined ? { promptId: toObjectId(promptId) } : {}),
      ...(notify !== undefined ? { 'notify.email': notify.email ?? false } : {}),
    });
  }

  async function setPromptGroupSchedule(
    groupId: string,
    fields: PromptGroupScheduleFields,
  ): Promise<IPromptGroup | null> {
    if (!isValidObjectIdString(groupId)) {
      return null;
    }
    const PromptGroup = getGroupModel();
    const existing = await PromptGroup.findById(groupId).select('schedule').lean<IPromptGroup>();
    if (!existing) {
      return null;
    }
    const { user, notify, ...rest } = fields;
    const $set = {
      ...(existing.schedule ? {} : INITIAL_RUNTIME_STATE),
      ...definitionPaths({
        ...rest,
        enabled: fields.enabled ?? true,
        variables: fields.variables ?? {},
        notify: { email: notify?.email ?? false },
      }),
      'schedule.user': new ObjectId(user),
    };
    return await PromptGroup.findOneAndUpdate(
      { _id: groupId },
      { $set },
      { new: true },
    ).lean<IPromptGroup>();
  }

  async function updatePromptGroupSchedule(
    groupId: string,
    patch: PromptGroupSchedulePatch,
  ): Promise<IPromptGroup | null> {
    if (!isValidObjectIdString(groupId)) {
      return null;
    }
    const $set = definitionPaths(patch);
    if (Object.keys($set).length === 0) {
      return await getGroupModel().findById(groupId).lean<IPromptGroup>();
    }
    return await getGroupModel()
      .findOneAndUpdate({ _id: groupId, schedule: { $exists: true } }, { $set }, { new: true })
      .lean<IPromptGroup>();
  }

  async function clearRunsForGroups(groupIds: Types.ObjectId[]): Promise<void> {
    if (groupIds.length === 0) {
      return;
    }
    await getRunModel().deleteMany({ promptGroupId: { $in: groupIds } });
  }

  async function clearPromptGroupSchedule(groupId: string): Promise<boolean> {
    if (!isValidObjectIdString(groupId)) {
      return false;
    }
    const result = await getGroupModel().updateOne(
      { _id: groupId, schedule: { $exists: true } },
      { $unset: { schedule: 1 } },
    );
    await clearRunsForGroups([new ObjectId(groupId)]);
    return result.modifiedCount > 0;
  }

  async function clearPromptGroupSchedulesByUser(userId: string): Promise<number> {
    if (!isValidObjectIdString(userId)) {
      return 0;
    }
    const PromptGroup = getGroupModel();
    const filter = { 'schedule.user': new ObjectId(userId) };
    const groups = await PromptGroup.find(filter).select('_id').lean<IPromptGroup[]>();
    if (groups.length === 0) {
      return 0;
    }
    const ids = groups.map((group) => group._id as Types.ObjectId);
    await clearRunsForGroups(ids);
    const result = await PromptGroup.updateMany({ _id: { $in: ids } }, { $unset: { schedule: 1 } });
    return result.modifiedCount ?? 0;
  }

  async function listScheduledPromptGroupsByUser(userId: string): Promise<IPromptGroup[]> {
    return await getGroupModel()
      .find({ 'schedule.user': new ObjectId(userId) })
      .sort({ 'schedule.createdAt': -1 })
      .lean<IPromptGroup[]>();
  }

  async function countPromptGroupSchedulesByUser(userId: string): Promise<number> {
    return await getGroupModel().countDocuments({ 'schedule.user': new ObjectId(userId) });
  }

  function lockUpdate(lockOwner: string, lockExpiresAt: Date, now: Date) {
    return {
      $set: {
        'schedule.lockOwner': lockOwner,
        'schedule.lockExpiresAt': lockExpiresAt,
        'schedule.lastRunAt': now,
      },
    };
  }

  async function claimDuePromptGroupSchedules(
    input: ClaimDuePromptGroupSchedulesInput,
  ): Promise<IPromptGroup[]> {
    const PromptGroup = getGroupModel();
    const now = input.now ?? new Date();
    const limit = input.limit ?? DEFAULT_CLAIM_LIMIT;
    const lockExpiresAt = new Date(now.getTime() + input.leaseMs);
    const claimed: IPromptGroup[] = [];

    for (let i = 0; i < limit; i++) {
      const group = await PromptGroup.findOneAndUpdate(
        {
          'schedule.enabled': true,
          'schedule.nextRunAt': { $ne: null, $lte: now },
          ...unlockedFilter(now),
        },
        lockUpdate(input.lockOwner, lockExpiresAt, now),
        { new: true, sort: { 'schedule.nextRunAt': 1 } },
      ).lean<IPromptGroup>();
      if (!group) {
        break;
      }
      claimed.push(group);
    }
    return claimed;
  }

  async function claimPromptGroupSchedule(
    input: ClaimPromptGroupScheduleInput,
  ): Promise<IPromptGroup | null> {
    if (!isValidObjectIdString(input.groupId)) {
      return null;
    }
    const now = input.now ?? new Date();
    const lockExpiresAt = new Date(now.getTime() + input.leaseMs);
    return await getGroupModel()
      .findOneAndUpdate(
        { _id: input.groupId, schedule: { $exists: true }, ...unlockedFilter(now) },
        lockUpdate(input.lockOwner, lockExpiresAt, now),
        { new: true },
      )
      .lean<IPromptGroup>();
  }

  async function refreshPromptGroupScheduleLock(
    input: PromptGroupScheduleLockInput,
  ): Promise<boolean> {
    if (!isValidObjectIdString(input.groupId)) {
      return false;
    }
    const now = input.now ?? new Date();
    const result = await getGroupModel().updateOne(
      { _id: input.groupId, 'schedule.lockOwner': input.lockOwner },
      { $set: { 'schedule.lockExpiresAt': new Date(now.getTime() + input.leaseMs) } },
    );
    return result.modifiedCount > 0;
  }

  async function completePromptGroupScheduleRun(
    input: CompletePromptGroupScheduleRunInput,
  ): Promise<IPromptGroup | null> {
    if (!isValidObjectIdString(input.groupId)) {
      return null;
    }
    const failed = input.status === PromptScheduleRunStatus.failed;
    const update: Record<string, Record<string, unknown>> = {
      $set: {
        'schedule.lockOwner': null,
        'schedule.lockExpiresAt': null,
        'schedule.lastRunStatus': input.status,
        'schedule.lastError': failed ? (input.errorMessage ?? null) : null,
        'schedule.lastConversationId': input.conversationId ?? null,
        'schedule.nextRunAt': input.disable ? null : input.nextRunAt,
        ...(input.disable ? { 'schedule.enabled': false } : {}),
        ...(failed ? {} : { 'schedule.consecutiveFailures': 0 }),
      },
      $inc: {
        'schedule.runCount': 1,
        ...(failed ? { 'schedule.consecutiveFailures': 1 } : {}),
      },
    };
    return await getGroupModel()
      .findOneAndUpdate({ _id: input.groupId, 'schedule.lockOwner': input.lockOwner }, update, {
        new: true,
      })
      .lean<IPromptGroup>();
  }

  async function createPromptScheduleRun(
    input: CreatePromptScheduleRunInput,
  ): Promise<IPromptScheduleRun> {
    const expiresAt = new Date(input.startedAt.getTime() + input.retentionDays * DAY_MS);
    const created = await getRunModel().create({
      promptGroupId: new ObjectId(input.promptGroupId),
      user: new ObjectId(input.user),
      status: input.status,
      trigger: input.trigger,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt ?? null,
      expiresAt,
      conversationId: input.conversationId ?? null,
      shareId: input.shareId ?? null,
      recipientCount: input.recipientCount ?? 0,
      warnings: input.warnings ?? [],
      errorMessage: input.errorMessage ?? null,
    });
    return created.toObject() as IPromptScheduleRun;
  }

  async function getPromptScheduleRuns(
    input: ListPromptScheduleRunsInput,
  ): Promise<IPromptScheduleRun[]> {
    if (!isValidObjectIdString(input.promptGroupId)) {
      return [];
    }
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_RUNS_LIMIT, 1), MAX_RUNS_LIMIT);
    return await getRunModel()
      .find({ promptGroupId: new ObjectId(input.promptGroupId) })
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean<IPromptScheduleRun[]>();
  }

  return {
    setPromptGroupSchedule,
    updatePromptGroupSchedule,
    clearPromptGroupSchedule,
    clearPromptGroupSchedulesByUser,
    listScheduledPromptGroupsByUser,
    countPromptGroupSchedulesByUser,
    claimDuePromptGroupSchedules,
    claimPromptGroupSchedule,
    refreshPromptGroupScheduleLock,
    completePromptGroupScheduleRun,
    createPromptScheduleRun,
    getPromptScheduleRuns,
  };
}
