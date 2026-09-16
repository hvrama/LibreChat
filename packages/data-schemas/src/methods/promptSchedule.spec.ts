import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PromptScheduleRunStatus } from 'librechat-data-provider';
import { createModels } from '~/models';
import type { IPromptGroup, IPromptScheduleRun } from '~/types';
import { createPromptScheduleMethods, type PromptScheduleMethods } from './promptSchedule';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let PromptGroup: mongoose.Model<IPromptGroup>;
let PromptScheduleRun: mongoose.Model<IPromptScheduleRun>;
let methods: PromptScheduleMethods;
let modelsToCleanup: string[] = [];

const userA = new mongoose.Types.ObjectId().toString();
const userB = new mongoose.Types.ObjectId().toString();
const LEASE_MS = 60_000;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const models = createModels(mongoose);
  modelsToCleanup = Object.keys(models);
  Object.assign(mongoose.models, models);
  PromptGroup = mongoose.models.PromptGroup as mongoose.Model<IPromptGroup>;
  PromptScheduleRun = mongoose.models.PromptScheduleRun as mongoose.Model<IPromptScheduleRun>;
  methods = createPromptScheduleMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  for (const modelName of modelsToCleanup) {
    delete mongoose.models[modelName];
  }
});

afterEach(async () => {
  await PromptGroup.deleteMany({});
  await PromptScheduleRun.deleteMany({});
});

async function createGroup(name = 'Daily digest'): Promise<string> {
  const group = await PromptGroup.create({
    name,
    author: new mongoose.Types.ObjectId(userA),
    authorName: 'Ada',
    productionId: new mongoose.Types.ObjectId(),
  });
  return group._id.toString();
}

function fields(
  overrides: Partial<Parameters<PromptScheduleMethods['setPromptGroupSchedule']>[1]> = {},
) {
  return {
    user: userA,
    agent_id: 'agent_123',
    cron: '0 9 * * *',
    timezone: 'UTC',
    source: { kind: 'cron' as const, cron: '0 9 * * *' },
    nextRunAt: new Date(Date.now() - 1000),
    ...overrides,
  };
}

async function createScheduledGroup(overrides = {}, name?: string): Promise<string> {
  const id = await createGroup(name);
  await methods.setPromptGroupSchedule(id, fields(overrides));
  return id;
}

describe('PromptGroup schedule methods', () => {
  describe('set / update / clear', () => {
    it('sets a schedule with defaults on a group that has none', async () => {
      const id = await createGroup();
      const group = await methods.setPromptGroupSchedule(id, fields());
      expect(group?.schedule?.enabled).toBe(true);
      expect(group?.schedule?.notify).toEqual({ email: false });
      expect(group?.schedule?.runCount).toBe(0);
      expect(group?.schedule?.user.toString()).toBe(userA);
      expect(group?.name).toBe('Daily digest');
      expect(await methods.countPromptGroupSchedulesByUser(userA)).toBe(1);
      expect(await methods.countPromptGroupSchedulesByUser(userB)).toBe(0);
    });

    it('re-setting preserves runtime counters', async () => {
      const id = await createScheduledGroup();
      await PromptGroup.updateOne(
        { _id: id },
        { $set: { 'schedule.runCount': 4, 'schedule.consecutiveFailures': 2 } },
      );
      const group = await methods.setPromptGroupSchedule(
        id,
        fields({ cron: '0 8 * * 1-5', notify: { email: true } }),
      );
      expect(group?.schedule?.cron).toBe('0 8 * * 1-5');
      expect(group?.schedule?.notify.email).toBe(true);
      expect(group?.schedule?.runCount).toBe(4);
      expect(group?.schedule?.consecutiveFailures).toBe(2);
    });

    it('patches only the provided definition fields', async () => {
      const id = await createScheduledGroup({ variables: { region: 'EMEA' } });
      const promptId = new mongoose.Types.ObjectId().toString();
      const group = await methods.updatePromptGroupSchedule(id, {
        enabled: false,
        nextRunAt: null,
        promptId,
      });
      expect(group?.schedule?.enabled).toBe(false);
      expect(group?.schedule?.nextRunAt).toBeNull();
      expect(group?.schedule?.promptId?.toString()).toBe(promptId);
      expect(group?.schedule?.variables).toEqual({ region: 'EMEA' });
      expect(group?.schedule?.cron).toBe('0 9 * * *');
    });

    it('does not patch a group without a schedule', async () => {
      const id = await createGroup();
      expect(await methods.updatePromptGroupSchedule(id, { enabled: false })).toBeNull();
    });

    it('clears the schedule and its runs, leaving the group intact', async () => {
      const id = await createScheduledGroup();
      await methods.createPromptScheduleRun({
        promptGroupId: id,
        user: userA,
        status: PromptScheduleRunStatus.succeeded,
        trigger: 'schedule',
        startedAt: new Date(),
        retentionDays: 30,
      });
      expect(await methods.clearPromptGroupSchedule(id)).toBe(true);
      const group = await PromptGroup.findById(id).lean();
      expect(group?.schedule).toBeUndefined();
      expect(group?.name).toBe('Daily digest');
      expect(await PromptScheduleRun.countDocuments()).toBe(0);
      expect(await methods.clearPromptGroupSchedule(id)).toBe(false);
    });

    it('clears every schedule set by a user', async () => {
      await createScheduledGroup({}, 'a');
      await createScheduledGroup({ user: userB }, 'b');
      expect(await methods.clearPromptGroupSchedulesByUser(userA)).toBe(1);
      const remaining = await methods.listScheduledPromptGroupsByUser(userB);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].name).toBe('b');
      expect(await methods.listScheduledPromptGroupsByUser(userA)).toEqual([]);
    });
  });

  describe('claiming and leases', () => {
    it('claims only due, enabled, unlocked schedules', async () => {
      const due = await createScheduledGroup({}, 'due');
      await createScheduledGroup({ nextRunAt: new Date(Date.now() + 3_600_000) }, 'future');
      await createScheduledGroup({ enabled: false }, 'disabled');
      await createScheduledGroup({ nextRunAt: null }, 'unscheduled');
      await createGroup('plain');

      const claimed = await methods.claimDuePromptGroupSchedules({
        lockOwner: 'worker-1',
        leaseMs: LEASE_MS,
      });
      expect(claimed.map((g) => g._id?.toString())).toEqual([due]);
      expect(claimed[0].schedule?.lockOwner).toBe('worker-1');
      expect(claimed[0].schedule?.lockExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    });

    it('never hands the same schedule to two concurrent workers', async () => {
      for (let i = 0; i < 5; i++) {
        await createScheduledGroup({}, `g${i}`);
      }
      const [first, second] = await Promise.all([
        methods.claimDuePromptGroupSchedules({ lockOwner: 'w1', leaseMs: LEASE_MS, limit: 10 }),
        methods.claimDuePromptGroupSchedules({ lockOwner: 'w2', leaseMs: LEASE_MS, limit: 10 }),
      ]);
      const ids = [...first, ...second].map((g) => g._id?.toString());
      expect(new Set(ids).size).toBe(5);
      expect(ids).toHaveLength(5);
    });

    it('lets an expired lease be reclaimed and refreshes only for the owner', async () => {
      const id = await createScheduledGroup();
      await PromptGroup.updateOne(
        { _id: id },
        {
          $set: {
            'schedule.lockOwner': 'dead',
            'schedule.lockExpiresAt': new Date(Date.now() - 1000),
          },
        },
      );
      const claimed = await methods.claimDuePromptGroupSchedules({
        lockOwner: 'alive',
        leaseMs: LEASE_MS,
      });
      expect(claimed).toHaveLength(1);
      expect(
        await methods.refreshPromptGroupScheduleLock({
          groupId: id,
          lockOwner: 'intruder',
          leaseMs: 5000,
        }),
      ).toBe(false);
      expect(
        await methods.refreshPromptGroupScheduleLock({
          groupId: id,
          lockOwner: 'alive',
          leaseMs: 5000,
        }),
      ).toBe(true);
    });

    it('claims a specific group for a manual run regardless of nextRunAt', async () => {
      const id = await createScheduledGroup({ nextRunAt: new Date(Date.now() + 86_400_000) });
      const claimed = await methods.claimPromptGroupSchedule({
        groupId: id,
        lockOwner: 'manual',
        leaseMs: LEASE_MS,
      });
      expect(claimed?.schedule?.lockOwner).toBe('manual');
      expect(
        await methods.claimPromptGroupSchedule({
          groupId: id,
          lockOwner: 'manual-2',
          leaseMs: LEASE_MS,
        }),
      ).toBeNull();
    });
  });

  describe('completing runs', () => {
    it('records success, clears the lock, and resets failures', async () => {
      const id = await createScheduledGroup();
      await PromptGroup.updateOne({ _id: id }, { $set: { 'schedule.consecutiveFailures': 2 } });
      await methods.claimDuePromptGroupSchedules({ lockOwner: 'w', leaseMs: LEASE_MS });
      const nextRunAt = new Date(Date.now() + 86_400_000);
      const group = await methods.completePromptGroupScheduleRun({
        groupId: id,
        lockOwner: 'w',
        status: PromptScheduleRunStatus.succeeded,
        conversationId: 'convo-1',
        nextRunAt,
      });
      const schedule = group?.schedule;
      expect(schedule?.lockOwner).toBeNull();
      expect(schedule?.lockExpiresAt).toBeNull();
      expect(schedule?.lastRunStatus).toBe(PromptScheduleRunStatus.succeeded);
      expect(schedule?.lastConversationId).toBe('convo-1');
      expect(schedule?.lastError).toBeNull();
      expect(schedule?.runCount).toBe(1);
      expect(schedule?.consecutiveFailures).toBe(0);
      expect(schedule?.nextRunAt?.getTime()).toBe(nextRunAt.getTime());
      expect(schedule?.enabled).toBe(true);
    });

    it('records failure, increments failures, and can disable', async () => {
      const id = await createScheduledGroup();
      await methods.claimDuePromptGroupSchedules({ lockOwner: 'w', leaseMs: LEASE_MS });
      const group = await methods.completePromptGroupScheduleRun({
        groupId: id,
        lockOwner: 'w',
        status: PromptScheduleRunStatus.failed,
        errorMessage: 'boom',
        nextRunAt: new Date(),
        disable: true,
      });
      expect(group?.schedule?.lastRunStatus).toBe(PromptScheduleRunStatus.failed);
      expect(group?.schedule?.lastError).toBe('boom');
      expect(group?.schedule?.consecutiveFailures).toBe(1);
      expect(group?.schedule?.enabled).toBe(false);
      expect(group?.schedule?.nextRunAt).toBeNull();
    });

    it('ignores completion from a stale owner', async () => {
      const id = await createScheduledGroup();
      await methods.claimDuePromptGroupSchedules({ lockOwner: 'w', leaseMs: LEASE_MS });
      const result = await methods.completePromptGroupScheduleRun({
        groupId: id,
        lockOwner: 'stale',
        status: PromptScheduleRunStatus.succeeded,
        nextRunAt: new Date(),
      });
      expect(result).toBeNull();
      const stored = await PromptGroup.findById(id).lean();
      expect(stored?.schedule?.lockOwner).toBe('w');
      expect(stored?.schedule?.runCount).toBe(0);
    });
  });

  describe('run history', () => {
    it('stores runs with an expiry and lists newest first', async () => {
      const id = await createScheduledGroup();
      const startedAt = new Date('2026-01-01T00:00:00Z');
      const run = await methods.createPromptScheduleRun({
        promptGroupId: id,
        user: userA,
        status: PromptScheduleRunStatus.failed,
        trigger: 'manual',
        startedAt,
        finishedAt: new Date('2026-01-01T00:01:00Z'),
        retentionDays: 10,
        warnings: ['w1'],
        errorMessage: 'nope',
      });
      expect(run.expiresAt.getTime()).toBe(startedAt.getTime() + 10 * 86_400_000);
      await methods.createPromptScheduleRun({
        promptGroupId: id,
        user: userA,
        status: PromptScheduleRunStatus.succeeded,
        trigger: 'schedule',
        startedAt: new Date('2026-01-02T00:00:00Z'),
        retentionDays: 10,
        conversationId: 'c2',
        shareId: 'share2',
        recipientCount: 3,
      });

      const runs = await methods.getPromptScheduleRuns({ promptGroupId: id });
      expect(runs.map((r) => r.status)).toEqual([
        PromptScheduleRunStatus.succeeded,
        PromptScheduleRunStatus.failed,
      ]);
      expect(runs[0].recipientCount).toBe(3);

      const indexes = await PromptScheduleRun.collection.indexes();
      const ttl = indexes.find((index) => index.key.expiresAt === 1);
      expect(ttl?.expireAfterSeconds).toBe(0);
    });
  });
});
