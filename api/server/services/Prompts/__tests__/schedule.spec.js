/**
 * Unit tests for the scheduled-prompt runner.
 *
 * The orchestration in `executePromptSchedule` runs for real, as do the chat route's
 * role-permission and PII-filter middleware. The agent-resource ACL, `buildEndpointOption`,
 * `AgentController`, the generation job manager, database methods, app config, and email
 * transport are mocked because they need MongoDB, model providers, or SMTP.
 */

const { Constants, EModelEndpoint, PromptScheduleRunStatus } = require('librechat-data-provider');

const USER_ID = '64a1f0c2e4b0a1b2c3d4e5f6';
const OTHER_USER_ID = '64a1f0c2e4b0a1b2c3d4e5f7';
const GROUP_ID = '74a1f0c2e4b0a1b2c3d4e5f6';
const PROJECT_ID = '94a1f0c2e4b0a1b2c3d4e5f6';
const SHARE_OBJECT_ID = 'a4a1f0c2e4b0a1b2c3d4e5f6';
const CONVO_ID = 'c0ffee00-0000-4000-8000-000000000001';

const mockAgentController = jest.fn();
const mockBuildEndpointOption = jest.fn();
const mockCanAccessAgent = jest.fn();
const mockSubscribe = jest.fn();
const mockAbortJob = jest.fn();
const mockUnsubscribe = jest.fn();
const mockSendEmail = jest.fn();
const mockGetAppConfig = jest.fn();
const mockGetEffectivePermissions = jest.fn();
const mockBulkUpdateResourcePermissions = jest.fn();
const mockGrantCreationPermissions = jest.fn();
const mockCheckEmailConfig = jest.fn();

const mockDb = {
  getUserById: jest.fn(),
  getRoleByName: jest.fn(),
  getPrompt: jest.fn(),
  getPromptGroup: jest.fn(),
  getChatProject: jest.fn(),
  getOrCreateChatProjectByName: jest.fn(),
  updatePromptGroupSchedule: jest.fn(),
  findUserIdsWithResourceAccess: jest.fn(),
  createSharedLink: jest.fn(),
  findUsers: jest.fn(),
  completePromptGroupScheduleRun: jest.fn(),
  createPromptScheduleRun: jest.fn(),
  claimPromptGroupSchedule: jest.fn(),
  claimDuePromptGroupSchedules: jest.fn(),
  refreshPromptGroupScheduleLock: jest.fn(),
};

jest.mock('~/models', () => mockDb);
jest.mock('~/server/middleware', () => ({
  buildEndpointOption: (...args) => mockBuildEndpointOption(...args),
  canAccessAgentFromBody:
    () =>
    (...args) =>
      mockCanAccessAgent(...args),
}));
jest.mock(
  '~/server/controllers/agents/request',
  () =>
    (...args) =>
      mockAgentController(...args),
);
jest.mock('~/server/services/Endpoints/agents', () => ({ initializeClient: jest.fn() }));
jest.mock('~/server/services/Endpoints/agents/title', () => jest.fn());
jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));
jest.mock('~/server/services/PermissionService', () => ({
  getEffectivePermissions: (...args) => mockGetEffectivePermissions(...args),
  bulkUpdateResourcePermissions: (...args) => mockBulkUpdateResourcePermissions(...args),
}));
jest.mock('~/server/utils', () => ({
  sendEmail: (...args) => mockSendEmail(...args),
}));
jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    GenerationJobManager: {
      subscribe: (...args) => mockSubscribe(...args),
      abortJob: (...args) => mockAbortJob(...args),
    },
    checkEmailConfig: (...args) => mockCheckEmailConfig(...args),
    grantCreationPermissions: (...args) => mockGrantCreationPermissions(...args),
  };
});

const { executePromptSchedule, runPromptScheduleNow } = require('../schedule');

function group(scheduleOverrides = {}, groupOverrides = {}) {
  return {
    _id: { toString: () => GROUP_ID },
    name: 'Daily digest',
    schedule: {
      user: { toString: () => USER_ID },
      agent_id: 'agent_abc',
      promptId: null,
      cron: '0 9 * * *',
      timezone: 'UTC',
      source: { kind: 'cron', cron: '0 9 * * *' },
      variables: { region: 'EMEA' },
      enabled: true,
      notify: { email: false },
      chatProjectId: PROJECT_ID,
      consecutiveFailures: 0,
      ...scheduleOverrides,
    },
    ...groupOverrides,
  };
}

function context(overrides = {}) {
  return {
    lockOwner: 'worker-1',
    leaseMs: 60_000,
    signal: new AbortController().signal,
    trigger: 'schedule',
    ...overrides,
  };
}

const appConfig = {
  scheduledPrompts: { enabled: true, maxConsecutiveFailures: 2, retentionDays: 7 },
  interfaceConfig: {},
};

/** Simulates the resumable controller: ack, then let the test drive the job. */
function controllerThatAcks(streamId = CONVO_ID) {
  return async (req, res) => {
    res.status(200).json({ streamId, conversationId: streamId, status: 'started' });
  };
}

function subscriptionThat(drive) {
  return async (streamId, onChunk, onDone, onError) => {
    setImmediate(() => drive({ streamId, onChunk, onDone, onError }));
    return { unsubscribe: mockUnsubscribe };
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DOMAIN_CLIENT = 'https://chat.example.com/';
  process.env.ALLOW_SHARED_LINKS = 'true';
  mockDb.getUserById.mockResolvedValue({
    _id: { toString: () => USER_ID },
    name: 'Ada',
    email: 'ada@example.com',
    role: 'USER',
  });
  mockDb.getRoleByName.mockResolvedValue({
    permissions: { PROMPTS: { USE: true }, AGENTS: { USE: true }, SHARED_LINKS: { USE: true } },
  });
  mockDb.getPromptGroup.mockResolvedValue({
    _id: GROUP_ID,
    name: 'Daily digest',
    productionPrompt: { prompt: 'Summarize {{region}} for {{current_user}}' },
  });
  mockDb.getChatProject.mockResolvedValue({ _id: PROJECT_ID });
  mockDb.getOrCreateChatProjectByName.mockResolvedValue({ _id: { toString: () => PROJECT_ID } });
  mockDb.updatePromptGroupSchedule.mockResolvedValue(null);
  mockDb.findUserIdsWithResourceAccess.mockResolvedValue({
    userIds: [USER_ID, OTHER_USER_ID],
    skipped: [],
  });
  mockDb.createSharedLink.mockResolvedValue({ _id: SHARE_OBJECT_ID, shareId: 'share123' });
  mockDb.findUsers.mockResolvedValue([
    { _id: OTHER_USER_ID, name: 'Grace', email: 'grace@example.com' },
  ]);
  mockDb.completePromptGroupScheduleRun.mockResolvedValue({});
  mockDb.createPromptScheduleRun.mockResolvedValue({});
  mockGetAppConfig.mockResolvedValue(appConfig);
  mockGetEffectivePermissions.mockResolvedValue(1);
  mockBulkUpdateResourcePermissions.mockResolvedValue({ errors: [] });
  mockGrantCreationPermissions.mockResolvedValue(undefined);
  mockCheckEmailConfig.mockReturnValue(true);
  mockSendEmail.mockResolvedValue(undefined);
  mockAbortJob.mockResolvedValue({});
  mockCanAccessAgent.mockImplementation((_req, _res, next) => next());
  mockBuildEndpointOption.mockImplementation((req, _res, next) => {
    req.body.endpointOption = { endpoint: req.body.endpoint, agent_id: req.body.agent_id };
    next();
  });
  mockAgentController.mockImplementation(controllerThatAcks());
  mockSubscribe.mockImplementation(
    subscriptionThat(({ onDone }) =>
      onDone({
        final: true,
        conversation: { conversationId: CONVO_ID, title: 'Digest' },
        responseMessage: { messageId: 'resp-1', text: 'done' },
      }),
    ),
  );
});

describe('executePromptSchedule', () => {
  it('drives the chat controller with the same request shape as a first message', async () => {
    await executePromptSchedule(group(), context());

    const [req, res] = mockAgentController.mock.calls[0];
    expect(req.user.id).toBe(USER_ID);
    expect(req.config).toBe(appConfig);
    expect(req.method).toBe('POST');
    expect(req.body).toEqual(
      expect.objectContaining({
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent_abc',
        text: 'Summarize EMEA for Ada',
        conversationId: Constants.NEW_CONVO,
        parentMessageId: Constants.NO_PARENT,
        chatProjectId: PROJECT_ID,
        isTemporary: false,
      }),
    );
    expect(req.body.endpointOption).toBeDefined();
    expect(typeof res.status).toBe('function');
    expect(mockCanAccessAgent).toHaveBeenCalledTimes(1);
    expect(mockBuildEndpointOption).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).toHaveBeenCalledWith(
      CONVO_ID,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );

    expect(mockDb.completePromptGroupScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: GROUP_ID,
        lockOwner: 'worker-1',
        status: PromptScheduleRunStatus.succeeded,
        conversationId: CONVO_ID,
        nextRunAt: expect.any(Date),
        disable: false,
      }),
    );
    expect(mockDb.createPromptScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        promptGroupId: GROUP_ID,
        status: PromptScheduleRunStatus.succeeded,
        trigger: 'schedule',
        retentionDays: 7,
        recipientCount: 0,
        shareId: null,
      }),
    );
    expect(mockDb.createSharedLink).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('shares with prompt-group viewers and emails owner plus recipients when enabled', async () => {
    await executePromptSchedule(group({ notify: { email: true } }), context());

    expect(mockDb.findUserIdsWithResourceAccess).toHaveBeenCalledWith(
      expect.objectContaining({ permissionBit: 1 }),
    );
    expect(mockDb.createSharedLink).toHaveBeenCalledWith(
      USER_ID,
      CONVO_ID,
      undefined,
      undefined,
      true,
    );
    expect(mockGrantCreationPermissions).toHaveBeenCalledWith(
      SHARE_OBJECT_ID,
      USER_ID,
      false,
      undefined,
    );
    expect(mockBulkUpdateResourcePermissions).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: SHARE_OBJECT_ID,
        updatedPrincipals: [
          expect.objectContaining({ id: OTHER_USER_ID, accessRoleId: 'sharedLink_viewer' }),
        ],
      }),
    );
    expect(mockDb.createPromptScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({ shareId: 'share123', recipientCount: 1 }),
    );

    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    const owner = mockSendEmail.mock.calls.find(([a]) => a.email === 'ada@example.com')[0];
    const recipient = mockSendEmail.mock.calls.find(([a]) => a.email === 'grace@example.com')[0];
    expect(owner.payload.link).toBe(`https://chat.example.com/c/${CONVO_ID}`);
    expect(owner.payload.isRecipient).toBe(false);
    expect(recipient.payload.link).toBe('https://chat.example.com/share/share123');
    expect(recipient.payload.isRecipient).toBe(true);
    expect(recipient.template).toBe('scheduledPromptRun.handlebars');
  });

  it('skips role and public grants and records a warning', async () => {
    mockDb.findUserIdsWithResourceAccess.mockResolvedValue({
      userIds: [USER_ID],
      skipped: ['role', 'public'],
    });
    await executePromptSchedule(group({ notify: { email: true } }), context());
    expect(mockDb.createSharedLink).not.toHaveBeenCalled();
    expect(mockDb.createPromptScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        warnings: expect.arrayContaining([expect.stringMatching(/role\/public/)]),
      }),
    );
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('records a failure and emails only the owner when permission checks fail', async () => {
    mockGetEffectivePermissions.mockResolvedValue(0);
    await executePromptSchedule(group({ notify: { email: true } }), context());
    expect(mockAgentController).not.toHaveBeenCalled();
    expect(mockDb.completePromptGroupScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: PromptScheduleRunStatus.failed,
        errorMessage: 'Owner no longer has access to the prompt group',
        conversationId: null,
        disable: false,
      }),
    );
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].payload.succeeded).toBe(false);
  });

  it('treats a 429 from the controller as a skip and other rejections as failures', async () => {
    mockAgentController.mockImplementation(async (_req, res) => {
      res.status(429).json({ type: 'concurrent', message: 'Too many concurrent requests' });
    });
    await executePromptSchedule(group(), context());
    expect(mockDb.completePromptGroupScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: PromptScheduleRunStatus.skipped,
        errorMessage: expect.stringMatching(/429/),
      }),
    );

    mockCanAccessAgent.mockImplementation((_req, res) =>
      res.status(403).json({ error: 'Insufficient permissions' }),
    );
    await executePromptSchedule(group(), context());
    expect(mockDb.completePromptGroupScheduleRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: PromptScheduleRunStatus.failed,
        errorMessage: expect.stringMatching(/403.*Insufficient permissions/),
      }),
    );
    expect(mockAgentController).toHaveBeenCalledTimes(1);
  });

  it('fails when the generation job reports an error', async () => {
    mockSubscribe.mockImplementation(subscriptionThat(({ onError }) => onError('model exploded')));
    await executePromptSchedule(group(), context());
    expect(mockDb.completePromptGroupScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: PromptScheduleRunStatus.failed,
        errorMessage: expect.stringMatching(/model exploded/),
      }),
    );
  });

  it('aborts the job and fails when the scheduler timeout fires', async () => {
    const abortController = new AbortController();
    mockSubscribe.mockImplementation(
      subscriptionThat(() => abortController.abort(new Error('timed out'))),
    );
    await executePromptSchedule(group(), context({ signal: abortController.signal }));
    expect(mockAbortJob).toHaveBeenCalledWith(CONVO_ID);
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockDb.completePromptGroupScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: PromptScheduleRunStatus.failed,
        errorMessage: 'timed out',
      }),
    );
  });

  it('disables the schedule once consecutive failures reach the configured maximum', async () => {
    mockDb.getPromptGroup.mockResolvedValue({ _id: GROUP_ID, productionPrompt: null });
    await executePromptSchedule(group({ consecutiveFailures: 1 }), context());
    expect(mockDb.completePromptGroupScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: PromptScheduleRunStatus.failed, disable: true }),
    );
  });

  it('disables immediately when the owner no longer exists', async () => {
    mockDb.getUserById.mockResolvedValue(null);
    await executePromptSchedule(group(), context());
    expect(mockDb.completePromptGroupScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: PromptScheduleRunStatus.failed, disable: true }),
    );
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('records a skip without counting a failure when the feature is disabled', async () => {
    mockGetAppConfig.mockResolvedValue({ scheduledPrompts: { enabled: false } });
    await executePromptSchedule(group(), context());
    expect(mockDb.completePromptGroupScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: PromptScheduleRunStatus.skipped,
        disable: false,
        nextRunAt: expect.any(Date),
      }),
    );
  });

  it('fails on unresolved template variables before contacting the controller', async () => {
    await executePromptSchedule(group({ variables: {} }), context());
    expect(mockAgentController).not.toHaveBeenCalled();
    expect(mockDb.completePromptGroupScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: PromptScheduleRunStatus.failed,
        errorMessage: expect.stringMatching(/Unresolved prompt variables: region/),
      }),
    );
  });

  it('recreates the project when the cached one is gone', async () => {
    mockDb.getChatProject.mockResolvedValue(null);
    const NEW_PROJECT_ID = 'b4a1f0c2e4b0a1b2c3d4e5f6';
    mockDb.getOrCreateChatProjectByName.mockResolvedValue({
      _id: { toString: () => NEW_PROJECT_ID },
    });
    await executePromptSchedule(group(), context());
    expect(mockDb.updatePromptGroupSchedule).toHaveBeenCalledWith(GROUP_ID, {
      chatProjectId: NEW_PROJECT_ID,
    });
    expect(mockAgentController.mock.calls[0][0].body.chatProjectId).toBe(NEW_PROJECT_ID);
  });
});

describe('runPromptScheduleNow', () => {
  const config = { lockLeaseMinutes: 30, runTimeoutMinutes: 20 };

  it('returns false when the schedule is already locked', async () => {
    mockDb.claimPromptGroupSchedule.mockResolvedValue(null);
    await expect(
      runPromptScheduleNow({ groupId: GROUP_ID, userId: USER_ID, config }),
    ).resolves.toBe(false);
  });

  it('claims the group and executes it as a manual run', async () => {
    mockDb.claimPromptGroupSchedule.mockResolvedValue(group());
    await expect(
      runPromptScheduleNow({ groupId: GROUP_ID, userId: USER_ID, config }),
    ).resolves.toBe(true);
    expect(mockDb.claimPromptGroupSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: GROUP_ID,
        leaseMs: 30 * 60_000,
        lockOwner: expect.stringMatching(/^manual:/),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockDb.completePromptGroupScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({ lockOwner: expect.stringMatching(/^manual:/) }),
    );
    expect(mockDb.createPromptScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'manual' }),
    );
  });
});
