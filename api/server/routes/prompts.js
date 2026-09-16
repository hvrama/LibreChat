const express = require('express');
const { ObjectId } = require('mongodb');
const { logger, isValidObjectIdString } = require('@librechat/data-schemas');
const {
  getNextRunAt,
  assertMinInterval,
  sanitizePromptGroup,
  generateCheckAccess,
  resolveCronFromSource,
  markPublicPromptGroups,
  buildPromptGroupFilter,
  PromptScheduleCronError,
  formatPromptGroupsResponse,
  safeValidatePromptGroupUpdate,
  resolveScheduledPromptsConfig,
  createEmptyPromptGroupsResponse,
  filterAccessibleIdsBySharedLogic,
} = require('@librechat/api');
const {
  Permissions,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionBits,
  PermissionTypes,
} = require('librechat-data-provider');
const { SystemCapabilities } = require('@librechat/data-schemas');
const {
  listScheduledPromptGroupsByUser,
  countPromptGroupSchedulesByUser,
  getOrCreateChatProjectByName,
  getListPromptGroupsByAccess,
  updatePromptGroupSchedule,
  clearPromptGroupSchedule,
  incrementPromptGroupUsage,
  setPromptGroupSchedule,
  getOwnedPromptGroupIds,
  getPromptScheduleRuns,
  makePromptProduction,
  updatePromptGroup,
  deletePromptGroup,
  createPromptGroup,
  getPromptGroup,
  getRoleByName,
  deletePrompt,
  getPrompts,
  savePrompt,
  findUsers,
  getPrompt,
  getAgent,
} = require('~/models');
const {
  runPromptScheduleNow,
  resolvePromptScheduleRecipients,
} = require('~/server/services/Prompts/schedule');
const {
  canAccessPromptGroupResource,
  canAccessPromptViaGroup,
  promptUsageLimiter,
  requireJwtAuth,
} = require('~/server/middleware');
const configMiddleware = require('~/server/middleware/config/app');
const {
  findPubliclyAccessibleResources,
  getEffectivePermissions,
  findAccessibleResources,
  grantPermission,
} = require('~/server/services/PermissionService');
const { hasCapability } = require('~/server/middleware/roles/capabilities');

const router = express.Router();

const checkPromptAccess = generateCheckAccess({
  permissionType: PermissionTypes.PROMPTS,
  permissions: [Permissions.USE],
  getRoleByName,
});
const checkPromptCreate = generateCheckAccess({
  permissionType: PermissionTypes.PROMPTS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});

router.use(requireJwtAuth);
router.use(checkPromptAccess);

const checkGlobalPromptShare = generateCheckAccess({
  permissionType: PermissionTypes.PROMPTS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});

/**
 * Route to get single prompt group by its ID
 * GET /groups/:groupId
 */
router.get(
  '/groups/:groupId',
  canAccessPromptGroupResource({
    requiredPermission: PermissionBits.VIEW,
  }),
  async (req, res) => {
    const { groupId } = req.params;

    try {
      const group = await getPromptGroup({ _id: groupId });

      if (!group) {
        return res.status(404).send({ message: 'Prompt group not found' });
      }

      res.status(200).send(sanitizePromptGroup(group));
    } catch (error) {
      logger.error('Error getting prompt group', error);
      res.status(500).send({ message: 'Error getting prompt group' });
    }
  },
);

/**
 * Route to fetch all prompt groups (ACL-aware)
 * GET /all
 */
router.get('/all', async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, category } = req.query;
    const { filter, searchShared, searchSharedOnly } = buildPromptGroupFilter({
      name,
      category,
    });

    let accessibleIds = await findAccessibleResources({
      userId,
      role: req.user.role,
      resourceType: ResourceType.PROMPTGROUP,
      requiredPermissions: PermissionBits.VIEW,
    });

    const [publiclyAccessibleIds, ownedPromptGroupIds] = await Promise.all([
      findPubliclyAccessibleResources({
        resourceType: ResourceType.PROMPTGROUP,
        requiredPermissions: PermissionBits.VIEW,
      }),
      getOwnedPromptGroupIds(userId),
    ]);

    const filteredAccessibleIds = await filterAccessibleIdsBySharedLogic({
      accessibleIds,
      searchShared,
      searchSharedOnly,
      publicPromptGroupIds: publiclyAccessibleIds,
      ownedPromptGroupIds,
    });

    const result = await getListPromptGroupsByAccess({
      accessibleIds: filteredAccessibleIds,
      otherParams: filter,
    });

    if (!result) {
      return res.status(200).send([]);
    }

    const { data: promptGroups = [] } = result;
    if (!promptGroups.length) {
      return res.status(200).send([]);
    }

    const groupsWithPublicFlag = markPublicPromptGroups(promptGroups, publiclyAccessibleIds);
    res.status(200).send(groupsWithPublicFlag);
  } catch (error) {
    logger.error(error);
    res.status(500).send({ error: 'Error getting prompt groups' });
  }
});

/**
 * Route to fetch paginated prompt groups with filters (ACL-aware)
 * GET /groups
 */
router.get('/groups', async (req, res) => {
  try {
    const userId = req.user.id;
    const { pageSize, limit, cursor, name, category } = req.query;

    const { filter, searchShared, searchSharedOnly } = buildPromptGroupFilter({
      name,
      category,
    });

    let actualLimit = limit;
    let actualCursor = cursor;

    if (pageSize && !limit) {
      actualLimit = parseInt(pageSize, 10);
    }

    if (
      actualCursor &&
      (actualCursor === 'undefined' || actualCursor === 'null' || actualCursor.length === 0)
    ) {
      actualCursor = null;
    }

    let accessibleIds = await findAccessibleResources({
      userId,
      role: req.user.role,
      resourceType: ResourceType.PROMPTGROUP,
      requiredPermissions: PermissionBits.VIEW,
    });

    const [publiclyAccessibleIds, ownedPromptGroupIds] = await Promise.all([
      findPubliclyAccessibleResources({
        resourceType: ResourceType.PROMPTGROUP,
        requiredPermissions: PermissionBits.VIEW,
      }),
      getOwnedPromptGroupIds(userId),
    ]);

    const filteredAccessibleIds = await filterAccessibleIdsBySharedLogic({
      accessibleIds,
      searchShared,
      searchSharedOnly,
      publicPromptGroupIds: publiclyAccessibleIds,
      ownedPromptGroupIds,
    });

    // Cursor-based pagination only
    const result = await getListPromptGroupsByAccess({
      accessibleIds: filteredAccessibleIds,
      otherParams: filter,
      limit: actualLimit,
      after: actualCursor,
    });

    if (!result) {
      const emptyResponse = createEmptyPromptGroupsResponse({
        pageNumber: '1',
        pageSize: actualLimit,
        actualLimit,
      });
      return res.status(200).send(emptyResponse);
    }

    const { data: promptGroups = [], has_more = false, after = null } = result;
    const groupsWithPublicFlag = markPublicPromptGroups(promptGroups, publiclyAccessibleIds);

    const response = formatPromptGroupsResponse({
      promptGroups: groupsWithPublicFlag,
      pageNumber: '1', // Always 1 for cursor-based pagination
      pageSize: actualLimit.toString(),
      hasMore: has_more,
      after,
    });

    res.status(200).send(response);
  } catch (error) {
    logger.error(error);
    res.status(500).send({ error: 'Error getting prompt groups' });
  }
});

/**
 * Creates a new prompt group with initial prompt
 * @param {object} req
 * @param {TCreatePrompt} req.body
 * @param {Express.Response} res
 */
const createNewPromptGroup = async (req, res) => {
  try {
    const { prompt, group } = req.body;

    if (!prompt || !group || !group.name) {
      return res.status(400).send({ error: 'Prompt and group name are required' });
    }

    const saveData = {
      prompt,
      group,
      author: req.user.id,
      authorName: req.user.name,
    };

    const result = await createPromptGroup(saveData);

    if (result.prompt && result.prompt._id && result.prompt.groupId) {
      try {
        await grantPermission({
          principalType: PrincipalType.USER,
          principalId: req.user.id,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId: result.prompt.groupId,
          accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
          grantedBy: req.user.id,
        });
        logger.debug(
          `[createPromptGroup] Granted owner permissions to user ${req.user.id} for promptGroup ${result.prompt.groupId}`,
        );
      } catch (permissionError) {
        logger.error(
          `[createPromptGroup] Failed to grant owner permissions for promptGroup ${result.prompt.groupId}:`,
          permissionError,
        );
      }
    }

    res.status(200).send(result);
  } catch (error) {
    logger.error(error);
    res.status(500).send({ error: 'Error creating prompt group' });
  }
};

/**
 * Adds a new prompt to an existing prompt group
 * @param {object} req
 * @param {TCreatePrompt} req.body
 * @param {Express.Response} res
 */
const addPromptToGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).send({ error: 'Prompt is required' });
    }

    if (typeof prompt.prompt !== 'string' || !prompt.prompt.trim()) {
      return res
        .status(400)
        .send({ error: 'Prompt text is required and must be a non-empty string' });
    }

    if (prompt.type !== 'text' && prompt.type !== 'chat') {
      return res.status(400).send({ error: 'Prompt type must be "text" or "chat"' });
    }

    // Ensure the prompt is associated with the correct group
    prompt.groupId = groupId;

    const saveData = {
      prompt,
      author: req.user.id,
      authorName: req.user.name,
    };

    const result = await savePrompt(saveData);
    res.status(200).send(result);
  } catch (error) {
    logger.error(error);
    res.status(500).send({ error: 'Error adding prompt to group' });
  }
};

// Create new prompt group (requires CREATE permission)
router.post('/', checkPromptCreate, createNewPromptGroup);

// Add prompt to existing group (requires EDIT permission on the group)
router.post(
  '/groups/:groupId/prompts',
  checkPromptAccess,
  canAccessPromptGroupResource({
    requiredPermission: PermissionBits.EDIT,
  }),
  addPromptToGroup,
);

/**
 * Records a prompt group usage (increments numberOfGenerations)
 * POST /groups/:groupId/use
 */
router.post(
  '/groups/:groupId/use',
  promptUsageLimiter,
  canAccessPromptGroupResource({
    requiredPermission: PermissionBits.VIEW,
  }),
  async (req, res) => {
    try {
      const { groupId } = req.params;
      if (!isValidObjectIdString(groupId)) {
        return res.status(400).send({ error: 'Invalid groupId' });
      }
      const result = await incrementPromptGroupUsage(groupId);
      res.status(200).send(result);
    } catch (error) {
      logger.error('[recordPromptUsage]', error);
      if (error.message === 'Invalid groupId') {
        return res.status(400).send({ error: 'Invalid groupId' });
      }
      if (error.message === 'Prompt group not found') {
        return res.status(404).send({ error: 'Prompt group not found' });
      }
      res.status(500).send({ error: 'Error recording prompt usage' });
    }
  },
);

/**
 * Validates and persists the optional `schedule` field of a prompt group update.
 * Returns an `{ status, error }` rejection or `null` when the schedule was applied.
 */
const applyScheduleUpdate = async ({ req, groupId, scheduleInput }) => {
  const config = resolveScheduledPromptsConfig(req.config);
  if (!config.enabled) {
    return { status: 404, error: 'Scheduled prompts are not enabled' };
  }
  if (scheduleInput === null) {
    await clearPromptGroupSchedule(groupId);
    return null;
  }

  const existing = await getPromptGroup({ _id: groupId });
  if (!existing) {
    return { status: 404, error: 'Prompt group not found' };
  }
  const current = existing.schedule;
  const agent_id = scheduleInput.agent_id ?? current?.agent_id;
  const source = scheduleInput.source ?? current?.source;
  if (!agent_id || !source) {
    return { status: 400, error: 'schedule requires agent_id and source' };
  }
  if (scheduleInput.agent_id != null || !current) {
    const agent = await getAgent({ id: agent_id });
    if (!agent) {
      return { status: 404, error: 'Agent not found' };
    }
    const agentPermissions = await getEffectivePermissions({
      userId: req.user.id,
      role: req.user.role,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
    });
    if (!(agentPermissions & PermissionBits.VIEW)) {
      return { status: 403, error: 'Insufficient permissions to use this agent' };
    }
  }

  const timezone = scheduleInput.timezone ?? current?.timezone ?? 'UTC';
  const enabled = scheduleInput.enabled ?? current?.enabled ?? true;
  const cron = resolveCronFromSource(source, timezone);
  assertMinInterval(cron, timezone, config.minIntervalMinutes);
  const nextRunAt = enabled ? getNextRunAt(cron, timezone) : null;

  if (current) {
    const { notify, ...rest } = scheduleInput;
    await updatePromptGroupSchedule(groupId, {
      ...rest,
      source,
      timezone,
      cron,
      enabled,
      nextRunAt,
      ...(notify ? { notify: { email: notify.email ?? current.notify?.email ?? false } } : {}),
    });
    return null;
  }

  const count = await countPromptGroupSchedulesByUser(req.user.id);
  if (count >= config.maxSchedulesPerUser) {
    return { status: 409, error: `Schedule limit of ${config.maxSchedulesPerUser} reached` };
  }
  const project = await getOrCreateChatProjectByName(req.user.id, config.projectName);
  await setPromptGroupSchedule(groupId, {
    user: req.user.id,
    agent_id,
    promptId: scheduleInput.promptId ?? null,
    cron,
    timezone,
    source,
    variables: scheduleInput.variables,
    enabled,
    notify: scheduleInput.notify,
    chatProjectId: project._id.toString(),
    nextRunAt,
  });
  return null;
};

/**
 * Updates a prompt group
 * @param {object} req
 * @param {object} req.params - The request parameters
 * @param {string} req.params.groupId - The group ID
 * @param {TUpdatePromptGroupPayload} req.body - The request body
 * @param {Express.Response} res
 */
const patchPromptGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    // Don't pass author - permissions are now checked by middleware
    const filter = { _id: groupId };

    const validationResult = safeValidatePromptGroupUpdate(req.body);
    if (!validationResult.success) {
      return res.status(400).send({
        error: 'Invalid request body',
        details: validationResult.error.errors,
      });
    }

    const { schedule: scheduleInput, ...groupData } = validationResult.data;
    if (scheduleInput !== undefined) {
      const rejection = await applyScheduleUpdate({ req, groupId, scheduleInput });
      if (rejection) {
        return res.status(rejection.status).send({ error: rejection.error });
      }
    }

    const promptGroup =
      Object.keys(groupData).length > 0
        ? await updatePromptGroup(filter, groupData)
        : await getPromptGroup(filter);
    if (!promptGroup) {
      return res.status(404).send({ error: 'Prompt group not found' });
    }
    res.status(200).send(sanitizePromptGroup(promptGroup));
  } catch (error) {
    if (error instanceof PromptScheduleCronError) {
      return res.status(400).send({ error: error.message });
    }
    logger.error(error);
    res.status(500).send({ error: 'Error updating prompt group' });
  }
};

router.patch(
  '/groups/:groupId',
  checkGlobalPromptShare,
  canAccessPromptGroupResource({
    requiredPermission: PermissionBits.EDIT,
  }),
  configMiddleware,
  patchPromptGroup,
);

router.patch(
  '/:promptId/tags/production',
  checkPromptCreate,
  canAccessPromptViaGroup({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'promptId',
  }),
  async (req, res) => {
    try {
      const { promptId } = req.params;
      const result = await makePromptProduction(promptId);
      res.status(200).send(result);
    } catch (error) {
      logger.error(error);
      res.status(500).send({ error: 'Error updating prompt production' });
    }
  },
);

/**
 * Scheduled prompts — schedule parameters are optional fields on a prompt group.
 * The definition is set through `PATCH /groups/:groupId` (`schedule` key); the routes
 * below expose run-now, run history, recipient preview, and clearing.
 */
const requireScheduledPrompts = (req, res, next) => {
  const config = resolveScheduledPromptsConfig(req.config);
  if (!config.enabled) {
    return res.status(404).send({ error: 'Scheduled prompts are not enabled' });
  }
  req.scheduledPromptsConfig = config;
  next();
};

const serializeRun = (run) => ({
  ...run,
  _id: run._id.toString(),
  promptGroupId: run.promptGroupId.toString(),
  user: run.user.toString(),
});

const loadScheduledGroup = async (req, res) => {
  const group = await getPromptGroup({ _id: req.params.groupId });
  if (!group) {
    res.status(404).send({ error: 'Prompt group not found' });
    return null;
  }
  if (!group.schedule) {
    res.status(404).send({ error: 'Prompt group has no schedule' });
    return null;
  }
  return group;
};

router.get('/schedules', configMiddleware, requireScheduledPrompts, async (req, res) => {
  try {
    const groups = await listScheduledPromptGroupsByUser(req.user.id);
    res.status(200).send(groups.map(sanitizePromptGroup));
  } catch (error) {
    logger.error('Error listing scheduled prompt groups', error);
    res.status(500).send({ error: 'Error listing scheduled prompt groups' });
  }
});

router.delete(
  '/groups/:groupId/schedule',
  configMiddleware,
  requireScheduledPrompts,
  canAccessPromptGroupResource({ requiredPermission: PermissionBits.EDIT }),
  async (req, res) => {
    try {
      await clearPromptGroupSchedule(req.params.groupId);
      const group = await getPromptGroup({ _id: req.params.groupId });
      if (!group) {
        return res.status(404).send({ error: 'Prompt group not found' });
      }
      res.status(200).send(sanitizePromptGroup(group));
    } catch (error) {
      logger.error('Error clearing prompt group schedule', error);
      res.status(500).send({ error: 'Error clearing prompt group schedule' });
    }
  },
);

router.post(
  '/groups/:groupId/schedule/run',
  configMiddleware,
  requireScheduledPrompts,
  canAccessPromptGroupResource({ requiredPermission: PermissionBits.EDIT }),
  async (req, res) => {
    try {
      const group = await loadScheduledGroup(req, res);
      if (!group) {
        return;
      }
      const groupId = group._id.toString();
      const queued = await runPromptScheduleNow({
        groupId,
        userId: req.user.id,
        config: req.scheduledPromptsConfig,
      });
      if (!queued) {
        return res.status(409).send({ error: 'Schedule is already running' });
      }
      res.status(202).send({ promptGroupId: groupId, status: 'queued' });
    } catch (error) {
      logger.error('Error running prompt group schedule', error);
      res.status(500).send({ error: 'Error running prompt group schedule' });
    }
  },
);

router.get(
  '/groups/:groupId/schedule/runs',
  configMiddleware,
  requireScheduledPrompts,
  canAccessPromptGroupResource({ requiredPermission: PermissionBits.VIEW }),
  async (req, res) => {
    try {
      const limit = Number.parseInt(req.query.limit, 10);
      const runs = await getPromptScheduleRuns({
        promptGroupId: req.params.groupId,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      res.status(200).send(runs.map(serializeRun));
    } catch (error) {
      logger.error('Error listing prompt group schedule runs', error);
      res.status(500).send({ error: 'Error listing prompt group schedule runs' });
    }
  },
);

router.get(
  '/groups/:groupId/schedule/recipients',
  configMiddleware,
  requireScheduledPrompts,
  canAccessPromptGroupResource({ requiredPermission: PermissionBits.EDIT }),
  async (req, res) => {
    try {
      const group = await loadScheduledGroup(req, res);
      if (!group) {
        return;
      }
      const { userIds, skipped, capped } = await resolvePromptScheduleRecipients({
        group,
        ownerId: group.schedule.user.toString(),
        config: req.scheduledPromptsConfig,
      });
      const users = userIds.length
        ? await findUsers({ _id: { $in: userIds } }, 'name username email')
        : [];
      res.status(200).send({
        recipients: users.map((user) => ({
          userId: user._id.toString(),
          name: user.name || user.username,
          email: user.email,
        })),
        skipped,
        capped,
      });
    } catch (error) {
      logger.error('Error resolving prompt group schedule recipients', error);
      res.status(500).send({ error: 'Error resolving prompt group schedule recipients' });
    }
  },
);

router.get(
  '/:promptId',
  canAccessPromptViaGroup({
    requiredPermission: PermissionBits.VIEW,
    resourceIdParam: 'promptId',
  }),
  async (req, res) => {
    const { promptId } = req.params;
    const prompt = await getPrompt({ _id: promptId });
    res.status(200).send(prompt);
  },
);

router.get('/', async (req, res) => {
  try {
    const author = req.user.id;
    const { groupId } = req.query;

    // If requesting prompts for a specific group, check permissions
    if (groupId) {
      if (!isValidObjectIdString(groupId)) {
        return res.status(400).send({ error: 'Invalid groupId' });
      }

      const permissions = await getEffectivePermissions({
        userId: req.user.id,
        role: req.user.role,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: groupId,
      });

      if (!(permissions & PermissionBits.VIEW)) {
        return res
          .status(403)
          .send({ error: 'Insufficient permissions to view prompts in this group' });
      }

      // If user has access, fetch all prompts in the group (not just their own)
      const prompts = await getPrompts({ groupId: new ObjectId(groupId) });
      return res.status(200).send(prompts);
    }

    // If no groupId, return user's own prompts
    const query = { author };
    let canReadPrompts = false;
    try {
      canReadPrompts = await hasCapability(req.user, SystemCapabilities.READ_PROMPTS);
    } catch (err) {
      logger.warn(`[GET /prompts] capability check failed, denying bypass: ${err.message}`);
    }
    if (canReadPrompts) {
      logger.debug(`[GET /prompts] READ_PROMPTS bypass for user ${req.user.id}`);
      delete query.author;
    }
    const prompts = await getPrompts(query);
    res.status(200).send(prompts);
  } catch (error) {
    logger.error(error);
    res.status(500).send({ error: 'Error getting prompts' });
  }
});

/**
 * Deletes a prompt
 *
 * @param {ServerRequest} req - The request object.
 * @param {TDeletePromptVariables} req.params - The request parameters
 * @param {import('mongoose').ObjectId} req.params.promptId - The prompt ID
 * @param {Express.Response} res - The response object.
 * @return {TDeletePromptResponse} A promise that resolves when the prompt is deleted.
 */
const deletePromptController = async (req, res) => {
  try {
    const { promptId } = req.params;
    const { groupId } = req.query;
    if (!groupId || !isValidObjectIdString(groupId)) {
      return res.status(400).send({ error: 'Invalid or missing groupId' });
    }
    const query = { promptId, groupId };
    const result = await deletePrompt(query);
    res.status(200).send(result);
  } catch (error) {
    logger.error(error);
    res.status(500).send({ error: 'Error deleting prompt' });
  }
};

/**
 * Delete a prompt group
 * @param {ServerRequest} req
 * @param {ServerResponse} res
 * @returns {Promise<TDeletePromptGroupResponse>}
 */
const deletePromptGroupController = async (req, res) => {
  try {
    const { groupId: _id } = req.params;
    // Don't pass author or role - permissions are checked by ACL middleware
    const message = await deletePromptGroup({ _id });
    res.send(message);
  } catch (error) {
    logger.error('Error deleting prompt group', error);
    res.status(500).send({ message: 'Error deleting prompt group' });
  }
};

router.delete(
  '/:promptId',
  checkPromptCreate,
  canAccessPromptViaGroup({
    requiredPermission: PermissionBits.DELETE,
    resourceIdParam: 'promptId',
  }),
  deletePromptController,
);
router.delete(
  '/groups/:groupId',
  checkPromptCreate,
  canAccessPromptGroupResource({
    requiredPermission: PermissionBits.DELETE,
  }),
  deletePromptGroupController,
);

module.exports = router;
