/**
 * Route tests for scheduled prompts embedded on prompt groups.
 *
 * The real router, zod validation, cron normalization/floor checks (via @librechat/api)
 * and the role permission check all run for real. Auth, config loading, the ACL service,
 * the database methods, and the headless runner are mocked so the tests exercise the
 * request contract (validation, ACL gating, status codes) without MongoDB.
 */

const express = require('express');
const request = require('supertest');
const { PermissionBits } = require('librechat-data-provider');

const USER_ID = '64a1f0c2e4b0a1b2c3d4e5f6';
const OTHER_USER_ID = '64a1f0c2e4b0a1b2c3d4e5f7';
const GROUP_ID = '74a1f0c2e4b0a1b2c3d4e5f6';
const PROJECT_ID = '94a1f0c2e4b0a1b2c3d4e5f6';
const AGENT_ID = 'agent_abc';

let mockScheduledPromptsConfig = { enabled: true };
let mockAgentPermissions = PermissionBits.VIEW;
let mockGroup;

const existingSchedule = (overrides = {}) => ({
  user: USER_ID,
  agent_id: AGENT_ID,
  promptId: null,
  cron: '0 9 * * *',
  timezone: 'UTC',
  source: { kind: 'preset', preset: 'daily', time: '09:00' },
  variables: {},
  enabled: true,
  notify: { email: false },
  chatProjectId: PROJECT_ID,
  nextRunAt: new Date('2026-09-14T09:00:00Z'),
  runCount: 0,
  consecutiveFailures: 0,
  lockOwner: 'should-be-stripped',
  lockExpiresAt: new Date(),
  ...overrides,
});

const plainGroup = (overrides = {}) => ({
  _id: GROUP_ID,
  name: 'Daily digest',
  author: USER_ID,
  authorName: 'Ada',
  productionPrompt: { prompt: 'Summarize' },
  ...overrides,
});

const mockModels = {
  getRoleByName: jest.fn(async () => ({ permissions: { PROMPTS: { USE: true, CREATE: true } } })),
  getPromptGroup: jest.fn(async () => mockGroup),
  getAgent: jest.fn(async () => ({ _id: 'agent-object-id', id: AGENT_ID })),
  getOrCreateChatProjectByName: jest.fn(async () => ({ _id: PROJECT_ID })),
  countPromptGroupSchedulesByUser: jest.fn(async () => 0),
  setPromptGroupSchedule: jest.fn(async (_id, fields) => {
    mockGroup = plainGroup({ schedule: existingSchedule(fields) });
    return mockGroup;
  }),
  updatePromptGroupSchedule: jest.fn(async (_id, patch) => {
    mockGroup = plainGroup({ schedule: existingSchedule({ ...mockGroup.schedule, ...patch }) });
    return mockGroup;
  }),
  clearPromptGroupSchedule: jest.fn(async () => {
    mockGroup = plainGroup();
    return true;
  }),
  updatePromptGroup: jest.fn(async (_filter, data) => {
    mockGroup = { ...mockGroup, ...data };
    return mockGroup;
  }),
  listScheduledPromptGroupsByUser: jest.fn(async () => []),
  getPromptScheduleRuns: jest.fn(async () => []),
  findUsers: jest.fn(async () => [
    { _id: OTHER_USER_ID, name: 'Other', email: 'other@example.com' },
  ]),
  getListPromptGroupsByAccess: jest.fn(),
  getOwnedPromptGroupIds: jest.fn(),
  incrementPromptGroupUsage: jest.fn(),
  makePromptProduction: jest.fn(),
  deletePromptGroup: jest.fn(),
  createPromptGroup: jest.fn(),
  deletePrompt: jest.fn(),
  getPrompts: jest.fn(),
  savePrompt: jest.fn(),
  getPrompt: jest.fn(),
};

const mockRunNow = jest.fn(async () => true);
const mockResolveRecipients = jest.fn(async () => ({
  userIds: [OTHER_USER_ID],
  skipped: ['public'],
  capped: false,
}));

jest.mock('~/models', () => mockModels);
jest.mock('~/server/services/Prompts/schedule', () => ({
  runPromptScheduleNow: (...args) => mockRunNow(...args),
  resolvePromptScheduleRecipients: (...args) => mockResolveRecipients(...args),
}));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: USER_ID, role: 'USER' };
    next();
  },
  canAccessPromptGroupResource: () => (_req, _res, next) => next(),
  canAccessPromptViaGroup: () => (_req, _res, next) => next(),
  promptUsageLimiter: (_req, _res, next) => next(),
}));
jest.mock('~/server/middleware/config/app', () => (req, _res, next) => {
  req.config = { scheduledPrompts: mockScheduledPromptsConfig };
  next();
});
jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: jest.fn(async () => false),
}));
jest.mock('~/server/services/PermissionService', () => ({
  getEffectivePermissions: jest.fn(async () => mockAgentPermissions),
  findPubliclyAccessibleResources: jest.fn(),
  findAccessibleResources: jest.fn(),
  grantPermission: jest.fn(),
}));

const promptsRouter = require('../prompts');

const app = express();
app.use(express.json());
app.use('/api/prompts', promptsRouter);

const patchGroup = (body) => request(app).patch(`/api/prompts/groups/${GROUP_ID}`).send(body);

const dailySchedule = () => ({
  agent_id: AGENT_ID,
  source: { kind: 'preset', preset: 'daily', time: '09:00' },
  timezone: 'UTC',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockScheduledPromptsConfig = { enabled: true };
  mockAgentPermissions = PermissionBits.VIEW;
  mockGroup = plainGroup();
  mockModels.countPromptGroupSchedulesByUser.mockResolvedValue(0);
  mockRunNow.mockResolvedValue(true);
});

describe('PATCH /api/prompts/groups/:groupId with schedule', () => {
  it('rejects schedule updates when the feature is disabled, but not plain updates', async () => {
    mockScheduledPromptsConfig = { enabled: false };
    const scheduled = await patchGroup({ schedule: dailySchedule() });
    expect(scheduled.status).toBe(404);
    expect(mockModels.setPromptGroupSchedule).not.toHaveBeenCalled();

    const renamed = await patchGroup({ name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(mockModels.updatePromptGroup).toHaveBeenCalledWith(
      { _id: GROUP_ID },
      { name: 'Renamed' },
    );
  });

  it('creates a schedule from a daily preset with defaults and files it in the project', async () => {
    const res = await patchGroup({ schedule: dailySchedule() });
    expect(res.status).toBe(200);
    expect(mockModels.setPromptGroupSchedule).toHaveBeenCalledWith(
      GROUP_ID,
      expect.objectContaining({
        user: USER_ID,
        agent_id: AGENT_ID,
        cron: '0 9 * * *',
        timezone: 'UTC',
        enabled: true,
        chatProjectId: PROJECT_ID,
        nextRunAt: expect.any(Date),
      }),
    );
    expect(mockModels.getOrCreateChatProjectByName).toHaveBeenCalledWith(
      USER_ID,
      'Scheduled Reports',
    );
    expect(mockModels.updatePromptGroup).not.toHaveBeenCalled();
    expect(res.body.schedule.cron).toBe('0 9 * * *');
    expect(res.body.schedule.lockOwner).toBeUndefined();
    expect(res.body.schedule.lockExpiresAt).toBeUndefined();
    expect(res.body.name).toBe('Daily digest');
  });

  it('updates group fields and the schedule in one request', async () => {
    const res = await patchGroup({
      name: 'Weekday report',
      schedule: { ...dailySchedule(), source: { kind: 'cron', cron: '30 8 * * 1-5' } },
    });
    expect(res.status).toBe(200);
    expect(mockModels.setPromptGroupSchedule).toHaveBeenCalledWith(
      GROUP_ID,
      expect.objectContaining({ cron: '30 8 * * 1-5' }),
    );
    expect(mockModels.updatePromptGroup).toHaveBeenCalledWith(
      { _id: GROUP_ID },
      { name: 'Weekday report' },
    );
    expect(res.body.name).toBe('Weekday report');
  });

  it('requires agent_id and source when the group has no schedule yet', async () => {
    const res = await patchGroup({ schedule: { enabled: false } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/agent_id and source/);
  });

  it('patches an existing schedule without re-sending everything', async () => {
    mockGroup = plainGroup({ schedule: existingSchedule() });
    const res = await patchGroup({ schedule: { enabled: false } });
    expect(res.status).toBe(200);
    expect(mockModels.setPromptGroupSchedule).not.toHaveBeenCalled();
    expect(mockModels.updatePromptGroupSchedule).toHaveBeenCalledWith(
      GROUP_ID,
      expect.objectContaining({ enabled: false, nextRunAt: null, cron: '0 9 * * *' }),
    );
    expect(mockModels.getAgent).not.toHaveBeenCalled();

    const weekly = await patchGroup({
      schedule: {
        enabled: true,
        source: { kind: 'preset', preset: 'weekly', time: '07:00', dayOfWeek: 1 },
      },
    });
    expect(weekly.status).toBe(200);
    expect(mockModels.updatePromptGroupSchedule).toHaveBeenLastCalledWith(
      GROUP_ID,
      expect.objectContaining({ cron: '0 7 * * 1', nextRunAt: expect.any(Date) }),
    );
  });

  it('merges notify settings on patch', async () => {
    mockGroup = plainGroup({ schedule: existingSchedule() });
    await patchGroup({ schedule: { notify: { email: true } } });
    expect(mockModels.updatePromptGroupSchedule).toHaveBeenLastCalledWith(
      GROUP_ID,
      expect.objectContaining({ notify: { email: true } }),
    );
  });

  it('clears the schedule with null', async () => {
    mockGroup = plainGroup({ schedule: existingSchedule() });
    const res = await patchGroup({ schedule: null });
    expect(res.status).toBe(200);
    expect(mockModels.clearPromptGroupSchedule).toHaveBeenCalledWith(GROUP_ID);
    expect(res.body.schedule).toBeUndefined();
  });

  it('rejects schedules that fire more often than the daily floor', async () => {
    const res = await patchGroup({
      schedule: { ...dailySchedule(), source: { kind: 'cron', cron: '0 */6 * * *' } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/more often than the allowed minimum/);
    expect(mockModels.setPromptGroupSchedule).not.toHaveBeenCalled();
  });

  it('allows hourly schedules when the configured floor is lowered', async () => {
    mockScheduledPromptsConfig = { enabled: true, minIntervalMinutes: 60 };
    const res = await patchGroup({
      schedule: { ...dailySchedule(), source: { kind: 'cron', cron: '0 * * * *' } },
    });
    expect(res.status).toBe(200);
  });

  it('rejects malformed payloads and unknown timezones', async () => {
    const unknownKey = await patchGroup({ schedule: { ...dailySchedule(), lockOwner: 'x' } });
    expect(unknownKey.status).toBe(400);
    expect(unknownKey.body.details).toBeDefined();

    const badTz = await patchGroup({ schedule: { ...dailySchedule(), timezone: 'Mars/Olympus' } });
    expect(badTz.status).toBe(400);
    expect(badTz.body.error).toMatch(/Unknown timezone/);
  });

  it('enforces the per-user schedule limit on first creation only', async () => {
    mockModels.countPromptGroupSchedulesByUser.mockResolvedValue(20);
    const created = await patchGroup({ schedule: dailySchedule() });
    expect(created.status).toBe(409);

    mockGroup = plainGroup({ schedule: existingSchedule() });
    const patched = await patchGroup({ schedule: { enabled: false } });
    expect(patched.status).toBe(200);
  });

  it('requires VIEW on the agent', async () => {
    mockAgentPermissions = 0;
    const denied = await patchGroup({ schedule: dailySchedule() });
    expect(denied.status).toBe(403);

    mockAgentPermissions = PermissionBits.VIEW;
    mockModels.getAgent.mockResolvedValueOnce(null);
    const missing = await patchGroup({ schedule: dailySchedule() });
    expect(missing.status).toBe(404);
  });
});

describe('group-scoped schedule routes', () => {
  it('GET /groups/:groupId strips lease fields from the schedule', async () => {
    mockGroup = plainGroup({ schedule: existingSchedule() });
    const res = await request(app).get(`/api/prompts/groups/${GROUP_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.schedule.cron).toBe('0 9 * * *');
    expect(res.body.schedule.lockOwner).toBeUndefined();
  });

  it('GET /schedules lists the caller’s scheduled groups', async () => {
    mockModels.listScheduledPromptGroupsByUser.mockResolvedValueOnce([
      plainGroup({ schedule: existingSchedule() }),
    ]);
    const res = await request(app).get('/api/prompts/schedules');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].schedule.lockOwner).toBeUndefined();
    expect(mockModels.listScheduledPromptGroupsByUser).toHaveBeenCalledWith(USER_ID);
  });

  it('DELETE /groups/:groupId/schedule clears the schedule', async () => {
    mockGroup = plainGroup({ schedule: existingSchedule() });
    const res = await request(app).delete(`/api/prompts/groups/${GROUP_ID}/schedule`);
    expect(res.status).toBe(200);
    expect(mockModels.clearPromptGroupSchedule).toHaveBeenCalledWith(GROUP_ID);
    expect(res.body.schedule).toBeUndefined();
  });

  it('POST /groups/:groupId/schedule/run queues a run and reports conflicts', async () => {
    mockGroup = plainGroup({ schedule: existingSchedule() });
    const queued = await request(app).post(`/api/prompts/groups/${GROUP_ID}/schedule/run`);
    expect(queued.status).toBe(202);
    expect(queued.body).toEqual({ promptGroupId: GROUP_ID, status: 'queued' });
    expect(mockRunNow).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: GROUP_ID, userId: USER_ID }),
    );

    mockRunNow.mockResolvedValueOnce(false);
    const busy = await request(app).post(`/api/prompts/groups/${GROUP_ID}/schedule/run`);
    expect(busy.status).toBe(409);
  });

  it('run/recipients return 404 for a group without a schedule', async () => {
    const run = await request(app).post(`/api/prompts/groups/${GROUP_ID}/schedule/run`);
    expect(run.status).toBe(404);
    const recipients = await request(app).get(
      `/api/prompts/groups/${GROUP_ID}/schedule/recipients`,
    );
    expect(recipients.status).toBe(404);
  });

  it('GET /groups/:groupId/schedule/runs lists runs', async () => {
    mockGroup = plainGroup({ schedule: existingSchedule() });
    mockModels.getPromptScheduleRuns.mockResolvedValueOnce([
      { _id: 'run1', promptGroupId: GROUP_ID, user: USER_ID, status: 'succeeded' },
    ]);
    const res = await request(app).get(`/api/prompts/groups/${GROUP_ID}/schedule/runs?limit=5`);
    expect(res.status).toBe(200);
    expect(res.body[0].status).toBe('succeeded');
    expect(mockModels.getPromptScheduleRuns).toHaveBeenCalledWith({
      promptGroupId: GROUP_ID,
      limit: 5,
    });
  });

  it('GET /groups/:groupId/schedule/recipients previews recipients', async () => {
    mockGroup = plainGroup({ schedule: existingSchedule() });
    const res = await request(app).get(`/api/prompts/groups/${GROUP_ID}/schedule/recipients`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      recipients: [{ userId: OTHER_USER_ID, name: 'Other', email: 'other@example.com' }],
      skipped: ['public'],
      capped: false,
    });
    expect(mockResolveRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: USER_ID }),
    );
  });
});
