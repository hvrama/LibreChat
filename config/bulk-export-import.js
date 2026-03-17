#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { parseArgs } = require('node:util');
const { Conversation, Message, User } = require('@librechat/data-schemas').createModels(mongoose);
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { silentExit } = require('./helpers');
const connect = require('./connect');

const EXPORT_VERSION = 1;
const BATCH_SIZE = 100;

/**
 * Fields to strip from conversation documents on export.
 */
const CONVO_STRIP_FIELDS = ['_id', '__v', 'messages'];

/**
 * Fields to strip from message documents on export.
 */
const MSG_STRIP_FIELDS = ['_id', '__v', '_meiliIndex'];

function printUsage() {
  console.log(`
Usage:
  node config/bulk-export-import.js --export --file <path> [--user <userId|email>]
  node config/bulk-export-import.js --import --file <path> --user <targetUserId|email>

Options:
  --export          Export conversations from the database
  --import          Import conversations into the database
  --file <path>     Path to the JSON file (output for export, input for import)
  --user <value>    User ID or email address.
                    For export: filter by user (omit to export all users)
                    For import: target user (required)
  --help            Show this help message

Environment:
  MONGO_URI is read from your .env file via config/connect.js.
  No additional configuration is needed if your .env is set up.

Examples:
  # Export all conversations
  node config/bulk-export-import.js --export --file ./backup.json

  # Export a specific user's conversations (by email or ID)
  node config/bulk-export-import.js --export --file ./backup.json --user user@example.com
  node config/bulk-export-import.js --export --file ./backup.json --user 65f1ad8c90523874d2d409f8

  # Import conversations under a target user (by email or ID)
  node config/bulk-export-import.js --import --file ./backup.json --user user@example.com

npm scripts:
  npm run bulk-export -- --file ./backup.json
  npm run bulk-import -- --file ./backup.json --user user@example.com
`);
}

function parseCliArgs() {
  try {
    const { values } = parseArgs({
      options: {
        export: { type: 'boolean', default: false },
        import: { type: 'boolean', default: false },
        file: { type: 'string' },
        user: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    });
    return values;
  } catch {
    printUsage();
    process.exit(1);
  }
}

/**
 * Strips internal MongoDB fields from a document.
 * @param {Object} doc - The lean mongoose document.
 * @param {string[]} fields - Fields to remove.
 * @returns {Object} Cleaned document.
 */
function stripFields(doc, fields) {
  const cleaned = { ...doc };
  for (const field of fields) {
    delete cleaned[field];
  }
  return cleaned;
}

/**
 * Resolves a --user value to a MongoDB user ID.
 * Accepts either a user ID string or an email address.
 * @param {string} userValue - User ID or email address.
 * @returns {Promise<string>} The resolved user ID.
 */
async function resolveUserId(userValue) {
  if (!userValue) {
    return null;
  }

  // If it looks like an email, look up by email
  if (userValue.includes('@')) {
    const user = await User.findOne({ email: userValue.toLowerCase() }).lean();
    if (!user) {
      console.red(`Error: No user found with email "${userValue}".`);
      console.yellow('Tip: Use "npm run list-users" to find valid users.');
      return null;
    }
    console.purple(`Resolved email "${userValue}" to user ID: ${user._id}`);
    return user._id.toString();
  }

  return userValue;
}

/**
 * Export conversations (and their messages) to a JSON file.
 * Uses a streaming write to handle large datasets.
 */
async function exportConversations(filePath, userId) {
  const query = {};
  if (userId) {
    query.user = userId;
  }

  const totalConvos = await Conversation.countDocuments(query);
  if (totalConvos === 0) {
    console.yellow('No conversations found matching the query.');
    return;
  }

  console.purple(`Found ${totalConvos} conversation(s) to export.`);

  const writeStream = fs.createWriteStream(filePath, { encoding: 'utf8' });

  // Write the JSON header
  writeStream.write(
    JSON.stringify({
      exportVersion: EXPORT_VERSION,
      exportDate: new Date().toISOString(),
      source: 'librechat-bulk-export',
    }).slice(0, -1) + ',"conversations":[',
  );

  const cursor = Conversation.find(query).lean().cursor();
  let count = 0;

  for await (const convo of cursor) {
    // Fetch all messages for this conversation
    const messages = await Message.find({ conversationId: convo.conversationId })
      .lean()
      .sort({ createdAt: 1 });

    const cleanedConvo = stripFields(convo, CONVO_STRIP_FIELDS);
    cleanedConvo.messages = messages.map((msg) => stripFields(msg, MSG_STRIP_FIELDS));

    if (count > 0) {
      writeStream.write(',');
    }
    writeStream.write(JSON.stringify(cleanedConvo));
    count++;

    if (count % 100 === 0) {
      console.gray(`  Exported ${count}/${totalConvos} conversations...`);
    }
  }

  writeStream.write(']}');
  writeStream.end();

  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  console.green(`Exported ${count} conversation(s) to ${filePath}`);
}

/**
 * Import conversations from a JSON file into the database under a target user.
 * Uses bulkWrite with upsert for idempotent imports.
 */
async function importConversations(filePath, targetUserId) {
  // Verify target user exists
  const targetUser = await User.findById(targetUserId).lean();
  if (!targetUser) {
    console.red(`Error: No user found with ID "${targetUserId}".`);
    console.yellow('Tip: Use "npm run list-users" to find valid users.');
    return;
  }
  console.purple(`Importing conversations for user: ${targetUser.email || targetUser.name || targetUserId}`);

  const fileData = fs.readFileSync(filePath, 'utf8');
  const exportData = JSON.parse(fileData);

  if (!exportData.exportVersion || !Array.isArray(exportData.conversations)) {
    console.red('Error: Invalid export file format. Expected a librechat-bulk-export file.');
    return;
  }

  const conversations = exportData.conversations;
  console.purple(`Found ${conversations.length} conversation(s) to import.`);

  let totalConvos = 0;
  let totalMessages = 0;

  // Process in batches
  for (let i = 0; i < conversations.length; i += BATCH_SIZE) {
    const batch = conversations.slice(i, i + BATCH_SIZE);
    const batchConvos = [];
    const batchMessages = [];

    for (const convo of batch) {
      const messages = convo.messages || [];

      // Build conversation document (without embedded messages)
      const convoDoc = { ...convo };
      delete convoDoc.messages;
      convoDoc.user = targetUserId;
      delete convoDoc.expiredAt;

      batchConvos.push(convoDoc);

      // Rewrite user on all messages
      for (const msg of messages) {
        msg.user = targetUserId;
        delete msg.expiredAt;
        batchMessages.push(msg);
      }
    }

    // Bulk upsert conversations
    if (batchConvos.length > 0) {
      const convoOps = batchConvos.map((convo) => ({
        updateOne: {
          filter: { conversationId: convo.conversationId, user: convo.user },
          update: { $set: convo },
          upsert: true,
          timestamps: false,
        },
      }));
      await Conversation.bulkWrite(convoOps);
    }

    // Bulk upsert messages with timestamp preservation
    if (batchMessages.length > 0) {
      const msgOps = batchMessages.map((msg) => ({
        updateOne: {
          filter: { messageId: msg.messageId },
          update: { $set: msg },
          upsert: true,
          timestamps: false,
        },
      }));
      await Message.bulkWrite(msgOps);
    }

    totalConvos += batchConvos.length;
    totalMessages += batchMessages.length;

    console.gray(
      `  Imported batch ${Math.floor(i / BATCH_SIZE) + 1}: ${totalConvos}/${conversations.length} conversations, ${totalMessages} messages...`,
    );
  }

  // Post-process: update the ObjectId message refs on each conversation
  console.gray('  Updating conversation message references...');
  for (let i = 0; i < conversations.length; i += BATCH_SIZE) {
    const batch = conversations.slice(i, i + BATCH_SIZE);
    const updateOps = [];

    for (const convo of batch) {
      const msgDocs = await Message.find(
        { conversationId: convo.conversationId, user: targetUserId },
        '_id',
      ).lean();
      const messageIds = msgDocs.map((m) => m._id);

      updateOps.push({
        updateOne: {
          filter: { conversationId: convo.conversationId, user: targetUserId },
          update: { $set: { messages: messageIds } },
        },
      });
    }

    if (updateOps.length > 0) {
      await Conversation.bulkWrite(updateOps);
    }
  }

  console.green(`Import complete: ${totalConvos} conversations, ${totalMessages} messages.`);
}

async function gracefulExit(code = 0) {
  try {
    await mongoose.disconnect();
  } catch (err) {
    console.error('Error disconnecting from MongoDB:', err);
  }
  silentExit(code);
}

(async () => {
  const args = parseCliArgs();

  if (args.help) {
    printUsage();
    return silentExit(0);
  }

  if (!args.export && !args.import) {
    console.red('Error: You must specify either --export or --import.');
    printUsage();
    return silentExit(1);
  }

  if (args.export && args.import) {
    console.red('Error: Cannot use both --export and --import at the same time.');
    return silentExit(1);
  }

  if (!args.file) {
    console.red('Error: --file is required.');
    printUsage();
    return silentExit(1);
  }

  if (args.import && !args.user) {
    console.red('Error: --user is required for import (target user ID).');
    printUsage();
    return silentExit(1);
  }

  await connect();

  // Resolve user (email or ID) to a user ID
  const userId = args.user ? await resolveUserId(args.user) : null;
  if (args.user && !userId) {
    return gracefulExit(1);
  }

  if (args.import && !userId) {
    console.red('Error: --user is required for import (target user ID or email).');
    printUsage();
    return gracefulExit(1);
  }

  console.purple('---------------');

  if (args.export) {
    console.purple('Bulk Export Conversations');
    console.purple('---------------');
    if (userId) {
      console.purple(`Filtering by user: ${userId}`);
    } else {
      console.purple('Exporting all users\' conversations');
    }
    await exportConversations(args.file, userId);
  } else {
    console.purple('Bulk Import Conversations');
    console.purple('---------------');
    await importConversations(args.file, userId);
  }

  return gracefulExit(0);
})().catch(async (err) => {
  if (!err.message.includes('fetch failed')) {
    console.error('There was an uncaught error:');
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
  }
});
