const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const mongoose = require('mongoose');
const { AccessRoleIds, ResourceType, PrincipalType } = require('librechat-data-provider');
const { User } = require('@librechat/data-schemas').createModels(mongoose);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { grantPermission } = require('~/server/services/PermissionService');
const {
  makePromptProduction,
  createPromptGroup,
  updatePromptGroup,
  revokePermission,
  seedDefaultRoles,
  savePrompt,
  getPrompt,
} = require('~/models');
const { PromptGroup } = require('~/db/models');
const { silentExit } = require('./helpers');
const connect = require('./connect');

const usage = () => {
  console.orange('Usage: npm run create-prompt -- <path/to/prompts.yaml>');
  console.orange('See config/example_prompt.yaml for the expected format.');
};

const loadYaml = (filePath) => {
  const absolutePath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolutePath)) {
    console.red(`Error: file not found: ${absolutePath}`);
    silentExit(1);
  }
  const parsed = yaml.load(fs.readFileSync(absolutePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object') {
    console.red('Error: YAML file is empty or malformed');
    silentExit(1);
  }
  if (!parsed.author) {
    console.red('Error: `author` (email of an existing user) is required');
    silentExit(1);
  }
  if (!Array.isArray(parsed.prompts) || parsed.prompts.length === 0) {
    console.red('Error: `prompts` must be a non-empty list');
    silentExit(1);
  }
  return parsed;
};

const validatePrompt = (entry, index) => {
  if (!entry || typeof entry !== 'object') {
    return `prompts[${index}] must be an object`;
  }
  if (!entry.name || typeof entry.name !== 'string') {
    return `prompts[${index}] is missing a \`name\``;
  }
  if (!entry.prompt || typeof entry.prompt !== 'string') {
    return `prompts[${index}] ("${entry.name}") is missing a \`prompt\``;
  }
  return null;
};

const buildGroup = ({ name, category, oneliner, command }) => ({
  name,
  ...(category ? { category } : {}),
  ...(oneliner ? { oneliner } : {}),
  ...(command ? { command } : {}),
});

const grantRole = (principal, groupId, accessRoleId, userId) =>
  grantPermission({
    ...principal,
    resourceType: ResourceType.PROMPTGROUP,
    resourceId: groupId,
    accessRoleId,
    grantedBy: userId,
  });

const PUBLIC_PRINCIPAL = { principalType: PrincipalType.PUBLIC, principalId: null };

const syncSharing = async (shared, groupId, userId) => {
  if (shared) {
    await grantRole(PUBLIC_PRINCIPAL, groupId, AccessRoleIds.PROMPTGROUP_VIEWER, userId);
    return;
  }
  await revokePermission(PrincipalType.PUBLIC, null, ResourceType.PROMPTGROUP, groupId);
};

const createGroup = async (entry, promptData, user) => {
  const result = await createPromptGroup({
    prompt: promptData,
    group: buildGroup(entry),
    author: user._id,
    authorName: user.name,
  });
  const groupId = result.prompt.groupId;
  await grantRole(
    { principalType: PrincipalType.USER, principalId: user._id },
    groupId,
    AccessRoleIds.PROMPTGROUP_OWNER,
    user._id,
  );
  return groupId;
};

const updateGroup = async (entry, promptData, existing, user) => {
  const groupId = existing._id;
  const groupFields = buildGroup(entry);
  const groupChanged = Object.keys(groupFields).some((key) => existing[key] !== groupFields[key]);
  if (groupChanged) {
    await updatePromptGroup({ _id: groupId }, groupFields);
  }

  const production = existing.productionId ? await getPrompt({ _id: existing.productionId }) : null;
  const promptChanged =
    !production || production.prompt !== promptData.prompt || production.type !== promptData.type;
  if (!promptChanged) {
    return groupId;
  }

  const saved = await savePrompt({ prompt: { ...promptData, groupId }, author: user._id });
  if (!saved.prompt) {
    throw new Error(saved.message || 'Error saving prompt version');
  }
  await makePromptProduction(saved.prompt._id);
  return groupId;
};

const upsertOne = async (entry, user) => {
  const shared = entry.shared === true;
  const promptData = { prompt: entry.prompt, type: entry.type === 'chat' ? 'chat' : 'text' };
  const existing = await PromptGroup.findOne({ name: entry.name, author: user._id }).lean();

  const groupId = existing
    ? await updateGroup(entry, promptData, existing, user)
    : await createGroup(entry, promptData, user);

  await syncSharing(shared, groupId, user._id);

  const action = existing ? 'Updated' : 'Created';
  console.green(
    `${action} "${entry.name}" (${groupId}) ${shared ? '[shared: view]' : '[private]'}`,
  );
};

(async () => {
  const filePath = process.argv[2];
  if (!filePath) {
    usage();
    silentExit(1);
  }

  const config = loadYaml(filePath);
  const errors = config.prompts.map(validatePrompt).filter(Boolean);
  if (errors.length > 0) {
    errors.forEach((message) => console.red(`Error: ${message}`));
    silentExit(1);
  }

  await connect();
  await seedDefaultRoles();

  const user = await User.findOne({ email: config.author }).lean();
  if (!user) {
    console.red(`Error: no user found with email "${config.author}"`);
    silentExit(1);
  }

  console.purple('--------------------------');
  console.purple(`Creating ${config.prompts.length} prompt(s) as ${user.email}`);
  console.purple('--------------------------');

  let failed = 0;
  for (const entry of config.prompts) {
    try {
      await upsertOne(entry, user);
    } catch (error) {
      failed += 1;
      console.red(`Failed "${entry.name}": ${error.message}`);
    }
  }

  silentExit(failed > 0 ? 1 : 0);
})();

process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    console.error('There was an uncaught error:');
    console.error(err);
  }

  if (err.message.includes('fetch failed')) {
    return;
  } else {
    process.exit(1);
  }
});
