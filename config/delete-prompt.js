const path = require('path');
const mongoose = require('mongoose');
const { User } = require('@librechat/data-schemas').createModels(mongoose);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { deleteUserPrompts } = require('~/models');
const { PromptGroup, Prompt } = require('~/db/models');
const { askQuestion, silentExit } = require('./helpers');
const connect = require('./connect');

const usage = () => {
  console.orange('Usage: npm run delete-prompt <email or user id> [--yes]');
  console.orange('');
  console.orange('Deletes every prompt group the user owns, with all prompt versions');
  console.orange('and sharing permissions. Groups co-owned by another user are kept.');
  console.orange('Pass --yes to skip the confirmation prompt.');
};

const fail = (message) => {
  console.red(`Error: ${message}`);
  console.orange('');
  usage();
  silentExit(1);
};

const findUser = (identifier) => {
  const filter = mongoose.Types.ObjectId.isValid(identifier)
    ? { _id: identifier }
    : { email: identifier };
  return User.findOne(filter).select('_id email name').lean();
};

const countOwned = async (userId) => {
  const groupIds = await PromptGroup.find({ author: userId }).distinct('_id');
  const prompts = groupIds.length ? await Prompt.countDocuments({ groupId: { $in: groupIds } }) : 0;
  return { groups: groupIds.length, prompts };
};

(async () => {
  const args = process.argv.slice(2);
  const skipConfirm = args.includes('--yes');
  const identifier = args.find((arg) => !arg.startsWith('--'));

  if (['--help', '-h', 'help'].includes(identifier) || args.includes('--help')) {
    usage();
    silentExit(0);
  }
  if (!identifier) {
    fail('missing user email or id');
  }

  await connect();

  const user = await findUser(identifier);
  if (!user) {
    console.red(`Error: no user found for "${identifier}"`);
    silentExit(1);
  }

  const before = await countOwned(user._id);
  if (before.groups === 0) {
    console.green(`${user.email} owns no prompts. Nothing to delete.`);
    silentExit(0);
  }

  console.purple('--------------------------');
  console.purple(`User:    ${user.email} (${user._id})`);
  console.purple(`Prompts: ${before.groups} group(s), ${before.prompts} version(s)`);
  console.purple('--------------------------');

  if (!skipConfirm) {
    const answer = await askQuestion('Delete all of them? This cannot be undone. (y/N)');
    if (answer.trim().toLowerCase() !== 'y') {
      console.orange('Aborted.');
      silentExit(0);
    }
  }

  await deleteUserPrompts(user._id.toString());

  const after = await countOwned(user._id);
  const removed = before.groups - after.groups;
  console.green(
    `Deleted ${removed} prompt group(s) and ${before.prompts - after.prompts} version(s).`,
  );
  if (after.groups > 0) {
    console.orange(`${after.groups} group(s) kept because another user also owns them.`);
  }
  silentExit(0);
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
