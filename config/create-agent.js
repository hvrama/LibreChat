const path = require('path');
const mongoose = require('mongoose');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { nanoid } = require('nanoid');
const { findUser } = require('~/models');
const { createAgent } = require('~/models/Agent');
const { grantPermission } = require('~/server/services/PermissionService');
const { PrincipalType, ResourceType, AccessRoleIds } = require('librechat-data-provider');
const { askQuestion, silentExit } = require('./helpers');
const connect = require('./connect');

(async () => {
  await connect();

  console.purple('--------------------------');
  console.purple('Create a new agent!');
  console.purple('--------------------------');

  if (process.argv.length < 3) {
    console.orange('Usage: npm run create-agent <username>');
    console.orange('Note: if you do not pass in the username, you will be prompted for it.');
    console.purple('--------------------------');
  }

  let username = process.argv[2] || '';

  if (!username) {
    username = await askQuestion('Username (owner of the agent):');
  }

  if (!username) {
    console.red('Error: Username is required!');
    silentExit(1);
  }

  // Find user by username
  const user = await findUser({ username: username.toLowerCase() });
  if (!user) {
    console.red(`Error: User with username "${username}" not found!`);
    silentExit(1);
  }

  console.green(`Found user: ${user.name} (${user.email})`);

  // Get agent details
  const name = await askQuestion('Agent name:');
  if (!name) {
    console.red('Error: Agent name is required!');
    silentExit(1);
  }

  const description = await askQuestion('Agent description (optional):') || '';

  const instructions = await askQuestion('Agent instructions/system prompt:');
  if (!instructions) {
    console.red('Error: Agent instructions are required!');
    silentExit(1);
  }

  const provider = await askQuestion('Provider (e.g., openAI, anthropic, google):');
  if (!provider) {
    console.red('Error: Provider is required!');
    silentExit(1);
  }

  const model = await askQuestion('Model (e.g., gpt-4, claude-3-opus):');
  if (!model) {
    console.red('Error: Model is required!');
    silentExit(1);
  }

  const category = await askQuestion('Category (default: general):') || 'general';

  try {
    // Create the agent
    const agentData = {
      id: `agent_${nanoid()}`,
      name,
      description,
      instructions,
      provider,
      model,
      author: user._id,
      tools: [],
      category,
    };

    console.orange('Creating agent...');
    const agent = await createAgent(agentData);

    // Grant owner permission
    console.orange('Granting owner permissions...');
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: user._id,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      accessRoleId: AccessRoleIds.AGENT_OWNER,
      grantedBy: user._id,
    });

    console.green('Agent created successfully!');
    console.green(`Agent ID: ${agent.id}`);
    console.green(`Agent Name: ${agent.name}`);
    console.green(`Owner: ${user.username}`);
    silentExit(0);
  } catch (error) {
    console.red('Error creating agent: ' + error.message);
    silentExit(1);
  }
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
