const { randomUUID } = require('crypto');
const {
  Constants,
  Permissions,
  SystemRoles,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionBits,
  PermissionTypes,
  EModelEndpoint,
  PromptScheduleRunStatus,
} = require('librechat-data-provider');
const {
  isEnabled,
  checkAccess,
  getNextRunAt,
  skipAgentCheck,
  checkEmailConfig,
  renderPromptText,
  generateCheckAccess,
  GenerationJobManager,
  startPromptScheduler,
  createMessageFilterPii,
  grantCreationPermissions,
  resolveScheduledPromptsConfig,
} = require('@librechat/api');
const { logger, getTenantId, runAsSystem, tenantStorage } = require('@librechat/data-schemas');
const {
  getEffectivePermissions,
  bulkUpdateResourcePermissions,
} = require('~/server/services/PermissionService');
const { buildEndpointOption, canAccessAgentFromBody } = require('~/server/middleware');
const { initializeClient } = require('~/server/services/Endpoints/agents');
const AgentController = require('~/server/controllers/agents/request');
const addTitle = require('~/server/services/Endpoints/agents/title');
const { getAppConfig } = require('~/server/services/Config');
const { sendEmail } = require('~/server/utils');
const db = require('~/models');

const EMAIL_TEMPLATE = 'scheduledPromptRun.handlebars';
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const USER_FIELDS = '-password -__v -totpSecret -backupCodes';

let appConfigRef;
let scheduler;

/** Same request middleware the browser hits on POST /api/agents/chat, minus HTTP-only steps. */
const checkAgentAccess = generateCheckAccess({
  permissionType: PermissionTypes.AGENTS,
  permissions: [Permissions.USE],
  skipCheck: skipAgentCheck,
  getRoleByName: db.getRoleByName,
});
const checkAgentResourceAccess = canAccessAgentFromBody({
  requiredPermission: PermissionBits.VIEW,
});
const messageFilterPii = createMessageFilterPii({
  getConfig: (req) => req.config?.messageFilter?.pii,
});

async function loadBaseAppConfig() {
  try {
    appConfigRef = await getAppConfig({ baseOnly: true });
    return appConfigRef;
  } catch (error) {
    if (appConfigRef) {
      return appConfigRef;
    }
    throw error;
  }
}

class ScheduledRunError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: PromptScheduleRunStatus; disable?: boolean }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'ScheduledRunError';
    this.status = options.status ?? PromptScheduleRunStatus.failed;
    this.disable = options.disable === true;
  }
}

/**
 * Minimal Express-like response. Whatever the middleware or controller writes lands in
 * `res.onResponse(status, body)` so the caller can treat it as an ack or a rejection.
 */
function createResponse() {
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    locals: {},
    headers: {},
    onResponse: () => {},
  };
  res.set = (key, value) => {
    res.headers[String(key).toLowerCase()] = value;
    return res;
  };
  res.setHeader = res.set;
  res.getHeader = (key) => res.headers[String(key).toLowerCase()];
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.headersSent = true;
    res.onResponse(res.statusCode, body);
    return res;
  };
  res.send = res.json;
  res.write = () => true;
  res.end = () => {
    res.writableEnded = true;
  };
  res.on = () => res;
  res.once = () => res;
  res.removeListener = () => res;
  res.flush = () => {};
  return res;
}

function describeRejection(status, body) {
  const reason = body?.error ?? body?.message ?? body?.code ?? 'request rejected';
  return `Chat request rejected (${status}): ${reason}`;
}

/** Runs one Express middleware; resolves on `next()`, rejects on `next(err)` or a response. */
function runMiddleware(middleware, req, res) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn) => (value) => {
      if (settled) {
        return;
      }
      settled = true;
      fn(value);
    };
    const done = settle(resolve);
    const fail = settle(reject);
    res.onResponse = (status, body) => {
      fail(
        new ScheduledRunError(describeRejection(status, body), {
          status: status === 429 ? PromptScheduleRunStatus.skipped : PromptScheduleRunStatus.failed,
        }),
      );
    };
    Promise.resolve(middleware(req, res, (error) => (error ? fail(error) : done()))).catch(fail);
  });
}

function toRequestUser(userDoc) {
  const user = typeof userDoc.toObject === 'function' ? userDoc.toObject() : { ...userDoc };
  user.id = user._id.toString();
  user.idOnTheSource ??= null;
  user.role ??= SystemRoles.USER;
  return user;
}

function formatRunTime(date, timezone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function buildClientUrl(path) {
  const base = (process.env.DOMAIN_CLIENT || 'http://localhost:3080').replace(/\/+$/, '');
  return `${base}${path}`;
}

/**
 * Resolves who receives an email for a scheduled group: every user with VIEW on the prompt
 * group (direct grants and group members), excluding the schedule owner, capped by config.
 */
async function resolvePromptScheduleRecipients({ group, ownerId, config }) {
  const { userIds, skipped } = await db.findUserIdsWithResourceAccess({
    resourceType: ResourceType.PROMPTGROUP,
    resourceId: group._id,
    permissionBit: PermissionBits.VIEW,
  });
  const others = userIds.filter((id) => id !== ownerId);
  const capped = others.length > config.maxEmailRecipients;
  return {
    userIds: capped ? others.slice(0, config.maxEmailRecipients) : others,
    skipped,
    capped,
  };
}

async function ensureScheduleProject({ group, userId, config }) {
  const schedule = group.schedule;
  if (schedule.chatProjectId) {
    const existing = await db.getChatProject(userId, schedule.chatProjectId);
    if (existing) {
      return schedule.chatProjectId;
    }
  }
  const project = await db.getOrCreateChatProjectByName(userId, config.projectName);
  const chatProjectId = project._id.toString();
  await db.updatePromptGroupSchedule(group._id.toString(), { chatProjectId });
  return chatProjectId;
}

async function assertPermissions({ group, user }) {
  const canUsePrompts = await checkAccess({
    user,
    permissionType: PermissionTypes.PROMPTS,
    permissions: [Permissions.USE],
    getRoleByName: db.getRoleByName,
  });
  if (!canUsePrompts) {
    throw new ScheduledRunError('Owner no longer has permission to use prompts');
  }
  const groupPermissions = await getEffectivePermissions({
    userId: user.id,
    role: user.role,
    resourceType: ResourceType.PROMPTGROUP,
    resourceId: group._id,
  });
  if (!(groupPermissions & PermissionBits.VIEW)) {
    throw new ScheduledRunError('Owner no longer has access to the prompt group');
  }
}

async function loadPromptText(group) {
  if (group.schedule.promptId) {
    const prompt = await db.getPrompt({ _id: group.schedule.promptId });
    if (!prompt?.prompt) {
      throw new ScheduledRunError('Pinned prompt version not found');
    }
    return prompt.prompt;
  }
  const loaded = await db.getPromptGroup({ _id: group._id });
  const text = loaded?.productionPrompt?.prompt;
  if (!text) {
    throw new ScheduledRunError('Prompt group has no production prompt');
  }
  return text;
}

/**
 * Sends the prompt through the exact path a browser uses for a first message: the chat
 * route's middleware, then `AgentController`, then waits on the generation job. The
 * controller owns persistence, titles, concurrency, MCP cleanup, and client disposal.
 * Resolves with the final event's conversation id.
 */
async function generateConversation({ group, user, appConfig, text, chatProjectId, signal }) {
  const groupId = group._id.toString();
  const req = {
    user,
    config: appConfig,
    method: 'POST',
    originalUrl: '/api/agents/chat/agents',
    baseUrl: '',
    path: '/agents',
    params: {},
    query: {},
    headers: {},
    ip: '127.0.0.1',
    get: () => undefined,
    body: {
      text,
      files: [],
      chatProjectId,
      isTemporary: false,
      agent_id: group.schedule.agent_id,
      endpoint: EModelEndpoint.agents,
      conversationId: Constants.NEW_CONVO,
      parentMessageId: Constants.NO_PARENT,
    },
  };
  const res = createResponse();

  await runMiddleware(messageFilterPii, req, res);
  await runMiddleware(checkAgentAccess, req, res);
  await runMiddleware(checkAgentResourceAccess, req, res);
  await runMiddleware(buildEndpointOption, req, res);

  let settle;
  const completion = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  let streamId = null;
  let unsubscribe = null;
  const fail = (error) => settle.reject(error);
  const abortJob = () => {
    if (!streamId) {
      return;
    }
    unsubscribe?.();
    GenerationJobManager.abortJob(streamId).catch((error) => {
      logger.warn(`[PromptSchedule] Failed to abort job ${streamId} for group ${groupId}:`, error);
    });
  };
  const onAbort = () => {
    abortJob();
    fail(signal.reason ?? new ScheduledRunError('Run aborted'));
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const attach = async (ack) => {
    streamId = ack.streamId;
    const subscription = await GenerationJobManager.subscribe(
      streamId,
      () => undefined,
      (finalEvent) => {
        settle.resolve({
          conversationId: finalEvent?.conversation?.conversationId ?? ack.conversationId,
          responseMessage: finalEvent?.responseMessage ?? null,
        });
      },
      (error) => fail(new ScheduledRunError(`Generation failed: ${error}`)),
    );
    if (!subscription) {
      fail(new ScheduledRunError('Generation job was not found after it started'));
      return;
    }
    unsubscribe = subscription.unsubscribe;
    if (signal.aborted) {
      abortJob();
    }
  };

  res.onResponse = (status, body) => {
    if (status === 200 && body?.status === 'started') {
      attach(body).catch(fail);
      return;
    }
    fail(
      new ScheduledRunError(describeRejection(status, body), {
        status: status === 429 ? PromptScheduleRunStatus.skipped : PromptScheduleRunStatus.failed,
      }),
    );
  };

  try {
    await AgentController(
      req,
      res,
      (error) => {
        if (error) {
          fail(error);
        }
      },
      initializeClient,
      addTitle,
    );
    return await completion;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function shareConversation({ user, config, conversationId, recipients, warnings }) {
  if (recipients.userIds.length === 0) {
    return null;
  }
  const allowSharedLinks =
    process.env.ALLOW_SHARED_LINKS === undefined || isEnabled(process.env.ALLOW_SHARED_LINKS);
  if (!allowSharedLinks) {
    warnings.push('Shared links are disabled on this deployment; recipients were not notified');
    return null;
  }
  const canShare = await checkAccess({
    user,
    permissionType: PermissionTypes.SHARED_LINKS,
    permissions: [Permissions.USE],
    getRoleByName: db.getRoleByName,
  });
  if (!canShare) {
    warnings.push('Owner cannot create shared links; recipients were not notified');
    return null;
  }
  const expiredAt =
    config.sharedLinkExpiryDays > 0
      ? new Date(Date.now() + config.sharedLinkExpiryDays * DAY_MS)
      : undefined;
  const created = await db.createSharedLink(user.id, conversationId, undefined, expiredAt, true);
  await grantCreationPermissions(created._id, user.id, false, expiredAt);
  const result = await bulkUpdateResourcePermissions({
    resourceType: ResourceType.SHARED_LINK,
    resourceId: created._id,
    updatedPrincipals: recipients.userIds.map((id) => ({
      type: PrincipalType.USER,
      id,
      accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
    })),
    grantedBy: user.id,
  });
  if (result?.errors?.length) {
    warnings.push(`${result.errors.length} recipient grant(s) failed`);
  }
  return created.shareId;
}

async function sendRunEmails({ group, user, outcome, recipientIds, startedAt }) {
  const schedule = group.schedule;
  if (!schedule.notify?.email || !checkEmailConfig()) {
    return;
  }
  const succeeded = outcome.status === PromptScheduleRunStatus.succeeded;
  const runAt = formatRunTime(startedAt, schedule.timezone);
  const appName = process.env.APP_TITLE || 'LibreChat';
  const year = new Date().getFullYear();
  const subjectStatus = succeeded ? 'completed' : outcome.status;
  const subject = `[${appName}] Scheduled report "${group.name}" ${subjectStatus}`;
  const basePayload = {
    appName,
    year,
    runAt,
    scheduleName: group.name,
    status: outcome.status,
    succeeded,
  };

  const emails = [];
  if (user.email) {
    emails.push({
      email: user.email,
      payload: {
        ...basePayload,
        name: user.name || user.username || user.email,
        isRecipient: false,
        link: outcome.conversationId ? buildClientUrl(`/c/${outcome.conversationId}`) : null,
        error: outcome.errorMessage ?? null,
      },
    });
  }

  if (succeeded && outcome.shareId && recipientIds.length > 0) {
    const recipients = await db.findUsers({ _id: { $in: recipientIds } }, 'name username email');
    for (const recipient of recipients) {
      if (!recipient.email) {
        continue;
      }
      emails.push({
        email: recipient.email,
        payload: {
          ...basePayload,
          name: recipient.name || recipient.username || recipient.email,
          isRecipient: true,
          link: buildClientUrl(`/share/${outcome.shareId}`),
          error: null,
        },
      });
    }
  }

  const results = await Promise.allSettled(
    emails.map(({ email, payload }) =>
      sendEmail({ email, subject, payload, template: EMAIL_TEMPLATE, throwError: false }),
    ),
  );
  const failures = results.filter((result) => result.status === 'rejected').length;
  if (failures > 0) {
    logger.warn(`[PromptSchedule] ${failures} notification email(s) failed for ${group._id}`);
  }
}

/**
 * Runs one scheduled group. Populates `state.user` and `state.config` as soon as they are
 * known so the caller can still notify the owner and apply config when a later step throws.
 */
async function performRun({ group, signal, warnings, state }) {
  const schedule = group.schedule;
  const userId = schedule.user.toString();
  const userDoc = await db.getUserById(userId, USER_FIELDS);
  if (!userDoc) {
    throw new ScheduledRunError('Schedule owner no longer exists', { disable: true });
  }
  const user = toRequestUser(userDoc);
  state.user = user;
  const appConfig = await getAppConfig({
    role: user.role,
    userId: user.id,
    tenantId: getTenantId(),
  });
  const config = resolveScheduledPromptsConfig(appConfig);
  state.config = config;
  if (!config.enabled) {
    throw new ScheduledRunError('Scheduled prompts are disabled', {
      status: PromptScheduleRunStatus.skipped,
    });
  }

  await assertPermissions({ group, user });
  const template = await loadPromptText(group);
  const text = renderPromptText({
    text: template,
    variables: schedule.variables ?? {},
    user,
    timezone: schedule.timezone,
  });
  const chatProjectId = await ensureScheduleProject({ group, userId, config });
  const { conversationId } = await generateConversation({
    group,
    user,
    appConfig,
    text,
    chatProjectId,
    signal,
  });

  let shareId = null;
  let recipientIds = [];
  if (schedule.notify?.email) {
    const recipients = await resolvePromptScheduleRecipients({ group, ownerId: userId, config });
    if (recipients.skipped.length > 0) {
      warnings.push(`Skipped ${recipients.skipped.join('/')} grants when resolving recipients`);
    }
    if (recipients.capped) {
      warnings.push(`Recipient list capped at ${config.maxEmailRecipients}`);
    }
    recipientIds = recipients.userIds;
    shareId = await shareConversation({ user, config, conversationId, recipients, warnings });
  }

  return { conversationId, shareId, recipientIds };
}

/**
 * Executes one claimed scheduled prompt group end to end. Never throws; failures are
 * recorded on the group's schedule and in its run history.
 *
 * @param {import('@librechat/data-schemas').IPromptGroup} group - claimed group with `schedule`
 * @param {{ lockOwner: string; signal: AbortSignal; trigger: 'schedule' | 'manual' }} context
 */
async function executePromptSchedule(group, context) {
  const groupId = group._id.toString();
  const schedule = group.schedule;
  if (!schedule) {
    logger.error(`[PromptSchedule] Claimed group ${groupId} has no schedule`);
    return;
  }
  const userId = schedule.user.toString();
  const startedAt = new Date();
  const warnings = [];

  return tenantStorage.run({ tenantId: group.tenantId, userId }, async () => {
    let outcome = {
      status: PromptScheduleRunStatus.succeeded,
      errorMessage: null,
      conversationId: null,
      shareId: null,
      disable: false,
    };
    const state = { user: null, config: null };
    let recipientIds = [];

    try {
      const result = await performRun({ group, signal: context.signal, warnings, state });
      recipientIds = result.recipientIds;
      outcome = { ...outcome, conversationId: result.conversationId, shareId: result.shareId };
    } catch (error) {
      const known = error instanceof ScheduledRunError;
      outcome = {
        ...outcome,
        status: known ? error.status : PromptScheduleRunStatus.failed,
        errorMessage: error?.message ?? String(error),
        disable: known && error.disable,
      };
      logger.error(`[PromptSchedule] Run ${outcome.status} for group ${groupId}:`, error);
    }

    const config = state.config ?? resolveScheduledPromptsConfig(await loadBaseAppConfig());
    const finishedAt = new Date();
    const failed = outcome.status === PromptScheduleRunStatus.failed;
    const disable =
      outcome.disable ||
      (failed && schedule.consecutiveFailures + 1 >= config.maxConsecutiveFailures);
    if (disable) {
      warnings.push('Schedule disabled after repeated failures');
    }

    let nextRunAt = null;
    try {
      nextRunAt = getNextRunAt(schedule.cron, schedule.timezone, finishedAt);
    } catch (error) {
      logger.error(`[PromptSchedule] Could not compute next run for ${groupId}:`, error);
    }

    try {
      await db.completePromptGroupScheduleRun({
        groupId,
        lockOwner: context.lockOwner,
        status: outcome.status,
        errorMessage: outcome.errorMessage,
        conversationId: outcome.conversationId,
        nextRunAt,
        disable,
      });
      await db.createPromptScheduleRun({
        promptGroupId: groupId,
        user: userId,
        status: outcome.status,
        trigger: context.trigger,
        startedAt,
        finishedAt,
        retentionDays: config.retentionDays,
        conversationId: outcome.conversationId,
        shareId: outcome.shareId,
        recipientCount: recipientIds.length,
        warnings,
        errorMessage: outcome.errorMessage,
      });
    } catch (error) {
      logger.error(`[PromptSchedule] Failed to record run for ${groupId}:`, error);
    }

    if (!state.user) {
      return;
    }
    try {
      await sendRunEmails({ group, user: state.user, outcome, recipientIds, startedAt });
    } catch (error) {
      logger.error(`[PromptSchedule] Failed to send notifications for ${groupId}:`, error);
    }
  });
}

/**
 * Claims a group's schedule for an immediate run and executes it in the background.
 * Returns `false` when the schedule is already locked by another run.
 */
async function runPromptScheduleNow({ groupId, userId, config }) {
  const lockOwner = `manual:${userId}:${randomUUID()}`;
  const leaseMs = config.lockLeaseMinutes * MINUTE_MS;
  const claimed = await db.claimPromptGroupSchedule({ groupId, lockOwner, leaseMs });
  if (!claimed) {
    return false;
  }
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(new Error('Scheduled prompt run timed out')),
    config.runTimeoutMinutes * MINUTE_MS,
  );
  timeout.unref?.();
  executePromptSchedule(claimed, {
    lockOwner,
    signal: abortController.signal,
    trigger: 'manual',
  })
    .catch((error) => {
      logger.error(`[PromptSchedule] Manual run failed for ${groupId}:`, error);
    })
    .finally(() => clearTimeout(timeout));
  return true;
}

function initializePromptScheduler(appConfig) {
  appConfigRef = appConfig;
  scheduler = startPromptScheduler({
    getConfig: async () => resolveScheduledPromptsConfig(await loadBaseAppConfig()),
    claimDue: (input) => runAsSystem(() => db.claimDuePromptGroupSchedules(input)),
    refreshLock: ({ _id, lockOwner, leaseMs }) =>
      runAsSystem(() => db.refreshPromptGroupScheduleLock({ groupId: _id, lockOwner, leaseMs })),
    execute: executePromptSchedule,
  });
  return scheduler;
}

async function stopPromptScheduler() {
  if (!scheduler) {
    return;
  }
  await scheduler.stop();
  scheduler = undefined;
}

module.exports = {
  executePromptSchedule,
  runPromptScheduleNow,
  initializePromptScheduler,
  stopPromptScheduler,
  resolvePromptScheduleRecipients,
};
