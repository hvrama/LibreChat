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

const SAMPLE_YAML = `author: admin@example.com

prompts:
  - name: Summarize
    prompt: |
      Summarize the following text in three bullet points:

      {{text}}
    shared: true
    category: writing
    oneliner: Condense any text into three bullets
    command: summarize`;

const usage = () => {
  console.orange('Usage: npm run create-prompt <path/to/prompts.yaml | path/to/dir>');
  console.orange('');
  console.orange('A directory applies every .yaml / .yml file in it (non-recursive).');
  console.orange('');
  console.orange('author:  email of an existing user who will own the prompts');
  console.orange('prompts: list of prompts, matched by name on re-runs');
  console.orange('  name, prompt: required');
  console.orange('  shared: true shares read only with everyone (default false)');
  console.orange('  category, oneliner, command: optional');
  console.orange('');
  console.orange('Example YAML:');
  console.cyan(SAMPLE_YAML);
};

const fail = (message) => {
  console.red(`Error: ${message}`);
  console.orange('');
  usage();
  silentExit(1);
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

const YAML_EXTENSIONS = new Set(['.yaml', '.yml']);

const resolveYamlFiles = (inputPath) => {
  const absolutePath = path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(absolutePath)) {
    fail(`path not found: ${absolutePath}`);
  }
  if (!fs.statSync(absolutePath).isDirectory()) {
    return [absolutePath];
  }
  const files = fs
    .readdirSync(absolutePath)
    .filter((name) => YAML_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => path.join(absolutePath, name));
  if (files.length === 0) {
    fail(`no .yaml or .yml files found in ${absolutePath}`);
  }
  return files;
};

const loadYaml = (absolutePath) => {
  const label = path.basename(absolutePath);
  let parsed;
  try {
    parsed = yaml.load(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    fail(`${label}: invalid YAML: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    fail(`${label}: YAML file is empty or malformed`);
  }
  if (!parsed.author) {
    fail(`${label}: \`author\` (email of an existing user) is required`);
  }
  if (!Array.isArray(parsed.prompts) || parsed.prompts.length === 0) {
    fail(`${label}: \`prompts\` must be a non-empty list`);
  }
  const errors = parsed.prompts.map(validatePrompt).filter(Boolean);
  if (errors.length > 0) {
    fail(errors.map((message) => `${label}: ${message}`).join('\n'));
  }
  return { file: label, ...parsed };
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

const applyConfig = async (config) => {
  const user = await User.findOne({ email: config.author }).lean();
  if (!user) {
    console.red(`${config.file}: no user found with email "${config.author}"`);
    return config.prompts.length;
  }

  console.purple('--------------------------');
  console.purple(`${config.file}: applying ${config.prompts.length} prompt(s) as ${user.email}`);
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
  return failed;
};

(async () => {
  const inputPath = process.argv[2];
  if (['--help', '-h', 'help'].includes(inputPath)) {
    usage();
    silentExit(0);
  }
  if (!inputPath) {
    fail('missing path to YAML file or directory');
  }

  const configs = resolveYamlFiles(inputPath).map(loadYaml);

  await connect();
  await seedDefaultRoles();

  let failed = 0;
  for (const config of configs) {
    failed += await applyConfig(config);
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
