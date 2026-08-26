#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { parseArgs } = require('node:util');
const { Conversation, Message, User, ChatProject } =
  require('@librechat/data-schemas').createModels(mongoose);
const { refreshChatProjectStats } = require('@librechat/data-schemas').createMethods(mongoose);
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
const TOOL_CALL_OUTPUT_MAX_BYTES = 1024;

function printUsage() {
  console.log(`
Usage:
  node config/bulk-export-import.js --export --file <path> [--user <userId|email>] [--exclude-domain <domain>]
  node config/bulk-export-import.js --export --file <path> --conversation <conversationId>
  node config/bulk-export-import.js --import --file <path> --user <targetUserId|email> [--no-projects]
  node config/bulk-export-import.js --import --dir <path> --user <targetUserId|email> [--no-projects]

Options:
  --export              Export conversations from the database
  --import              Import conversations into the database
  --file <path>         Path to the JSON file (output for export, input for import)
  --dir <path>          Import only. Directory whose .json files are all imported,
                        in filename order. Mutually exclusive with --file.
  --user <value>        User ID or email address.
                        For export: filter by user (omit to export all users)
                        For import: target user (required)
  --exclude-domain <d>  Exclude conversations from users with this email domain.
                        For export only. Example: --exclude-domain example.com
  --no-projects         Import only. Skip grouping conversations into projects.
                        By default, imported conversations are grouped into a
                        project named after the original owner's email domain.
  --conversation <id>   Export a single conversation by its ID.
                        Output uses LibreChat format importable via the UI.
  --help                Show this help message

Environment:
  MONGO_URI is read from your .env file via config/connect.js.
  No additional configuration is needed if your .env is set up.

Examples:
  # Export all conversations
  node config/bulk-export-import.js --export --file ./backup.json

  # Export a specific user's conversations (by email or ID)
  node config/bulk-export-import.js --export --file ./backup.json --user user@example.com

  # Export all conversations except those from a specific domain
  node config/bulk-export-import.js --export --file ./backup.json --exclude-domain internal.corp

  # Export a single conversation (UI-importable format)
  node config/bulk-export-import.js --export --file ./convo.json --conversation af1ea676-f525-444f-a9ed-7c8dbf062733

  # Import conversations under a target user (by email or ID)
  # Conversations are grouped into projects named after each original owner's
  # email domain (e.g. "example.com"), created on demand.
  node config/bulk-export-import.js --import --file ./backup.json --user user@example.com

  # Import every .json export in a directory
  node config/bulk-export-import.js --import --dir ./backups --user user@example.com

  # Import without creating or assigning any projects
  node config/bulk-export-import.js --import --file ./backup.json --user user@example.com --no-projects

npm scripts:
  npm run bulk-export -- --file ./backup.json
  npm run bulk-export -- --file ./convo.json --conversation CONVERSATION_ID
  npm run bulk-import -- --file ./backup.json --user user@example.com
  npm run bulk-import -- --dir ./backups --user user@example.com
`);
}

function parseCliArgs() {
  try {
    const { values } = parseArgs({
      options: {
        export: { type: 'boolean', default: false },
        import: { type: 'boolean', default: false },
        file: { type: 'string' },
        dir: { type: 'string' },
        user: { type: 'string' },
        'exclude-domain': { type: 'string' },
        'no-projects': { type: 'boolean', default: false },
        conversation: { type: 'string' },
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
 * Matches the `[owner@example.com] ` prefix that bulk exports prepend to titles.
 */
const TITLE_EMAIL_PREFIX = /^\[\s*([^\s\]]+@[^\s\]]+)\s*\]\s*/;

/**
 * Extracts the owner email recorded on an exported conversation.
 * Prefers the explicit `ownerEmail` field and falls back to the title prefix
 * written by older exports.
 * @param {Object} convo - The exported conversation.
 * @returns {string|null} The owner email, or null when unavailable.
 */
function getOwnerEmail(convo) {
  if (typeof convo.ownerEmail === 'string' && convo.ownerEmail.includes('@')) {
    return convo.ownerEmail;
  }
  const match = typeof convo.title === 'string' ? convo.title.match(TITLE_EMAIL_PREFIX) : null;
  return match ? match[1] : null;
}

/**
 * Extracts the domain part of an email address.
 * @param {string|null|undefined} email - The email address.
 * @returns {string|null} The lowercased domain, or null when not parseable.
 */
function getEmailDomain(email) {
  if (typeof email !== 'string') {
    return null;
  }
  const domain = email.split('@').pop();
  if (!domain || domain === email) {
    return null;
  }
  const normalized = domain.trim().toLowerCase();
  return normalized || null;
}

/**
 * Finds or creates the chat project named after an email domain for a user.
 * Uses an upsert so repeated imports reuse the same project.
 * @param {string} domain - The email domain, used as the project name.
 * @param {string} userId - The owning user's ID.
 * @returns {Promise<{ projectId: string, created: boolean }>} The project reference.
 */
async function getOrCreateDomainProject(domain, userId) {
  const existing = await ChatProject.findOne({ user: userId, name: domain }).lean();
  if (existing) {
    return { projectId: existing._id.toString(), created: false };
  }

  const project = await ChatProject.findOneAndUpdate(
    { user: userId, name: domain },
    {
      $setOnInsert: {
        user: userId,
        name: domain,
        description: `Imported conversations from ${domain}`,
        conversationCount: 0,
        lastConversationAt: null,
        lastConversationId: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  return { projectId: project._id.toString(), created: true };
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
 * Truncates a string value to the byte limit, appending a truncation notice.
 * @param {string} value - The string to truncate.
 * @param {number} maxBytes - Maximum byte length.
 * @returns {string} The truncated string, or original if within limit.
 */
function truncateString(value, maxBytes) {
  const originalBytes = Buffer.byteLength(value, 'utf8');
  if (originalBytes <= maxBytes) {
    return value;
  }
  const truncatedBytes = originalBytes - maxBytes;
  const truncatedKB = Math.round(truncatedBytes / 1024);
  // Slice by bytes: encode, truncate, decode
  const buf = Buffer.from(value, 'utf8').subarray(0, maxBytes);
  // Decode safely — may cut a multi-byte char, so we use toString which replaces partial chars
  const truncated = buf.toString('utf8');
  return `${truncated}... [truncated ${truncatedKB} kB]`;
}

/**
 * Truncates tool call outputs in message content arrays to TOOL_CALL_OUTPUT_MAX_BYTES.
 * Mutates messages in place.
 * @param {Object[]} messages - Array of message objects.
 */
function truncateToolCallOutputs(messages) {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      continue;
    }
    for (const part of msg.content) {
      if (part.type !== 'tool_call' || !part.tool_call) {
        continue;
      }
      const tc = part.tool_call;
      // function tool calls: output is a string
      if (tc.function && typeof tc.function.output === 'string') {
        tc.function.output = truncateString(tc.function.output, TOOL_CALL_OUTPUT_MAX_BYTES);
      }
      // code_interpreter: outputs is an array of items
      if (tc.code_interpreter && Array.isArray(tc.code_interpreter.outputs)) {
        for (const output of tc.code_interpreter.outputs) {
          if (output.logs && typeof output.logs === 'string') {
            output.logs = truncateString(output.logs, TOOL_CALL_OUTPUT_MAX_BYTES);
          }
        }
      }
      // generic output field on the tool call itself
      if (typeof tc.output === 'string') {
        tc.output = truncateString(tc.output, TOOL_CALL_OUTPUT_MAX_BYTES);
      }
    }
  }
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
 * Export a single conversation in LibreChat format (importable via the UI).
 * Produces a JSON file with: conversationId, endpoint, title, messages[], etc.
 */
async function exportSingleConversation(filePath, conversationId) {
  const convo = await Conversation.findOne({ conversationId }).lean();
  if (!convo) {
    console.red(`Error: No conversation found with ID "${conversationId}".`);
    return;
  }

  const owner = await User.findById(convo.user).lean();
  const prefixedTitle = owner?.email ? `[${owner.email}] ${convo.title}` : convo.title;

  const messages = await Message.find({ conversationId })
    .lean()
    .sort({ createdAt: 1 });

  const cleanedMessages = messages.map((msg) => stripFields(msg, MSG_STRIP_FIELDS));
  truncateToolCallOutputs(cleanedMessages);

  const exportData = {
    conversationId: convo.conversationId,
    endpoint: convo.endpoint,
    title: prefixedTitle,
    exportAt: new Date().toTimeString(),
    branches: true,
    recursive: false,
    options: {
      model: convo.model,
      endpoint: convo.endpoint,
      chatGptLabel: convo.chatGptLabel || null,
      promptPrefix: convo.promptPrefix || null,
      temperature: convo.temperature,
      top_p: convo.top_p,
      presence_penalty: convo.presence_penalty,
      frequency_penalty: convo.frequency_penalty,
      title: prefixedTitle,
    },
    messages: cleanedMessages,
  };

  fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2), 'utf8');
  console.green(`Exported conversation "${convo.title}" (${messages.length} messages) to ${filePath}`);
  console.green('This file can be imported via the LibreChat UI (Settings > Data Controls > Import).');
}

/**
 * Export conversations (and their messages) to a JSON file.
 * Uses a streaming write to handle large datasets.
 */
async function exportConversations(filePath, userId, excludeDomain) {
  const query = {};
  if (userId) {
    query.user = userId;
  }

  if (excludeDomain) {
    const domainRegex = new RegExp(`@${excludeDomain.replace(/\./g, '\\.')}$`, 'i');
    const excludedUsers = await User.find({ email: domainRegex }, '_id').lean();
    const excludedIds = excludedUsers.map((u) => u._id);
    if (excludedIds.length > 0) {
      query.user = query.user
        ? { $eq: query.user, $nin: excludedIds }
        : { $nin: excludedIds };
      console.purple(`Excluding ${excludedIds.length} user(s) with @${excludeDomain} emails.`);
    } else {
      console.gray(`No users found with @${excludeDomain} emails; nothing to exclude.`);
    }
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
  const userEmailCache = new Map();
  let count = 0;

  for await (const convo of cursor) {
    // Resolve owner email (cached)
    let ownerEmail = userEmailCache.get(convo.user);
    if (ownerEmail === undefined) {
      const owner = await User.findById(convo.user).lean();
      ownerEmail = owner?.email || null;
      userEmailCache.set(convo.user, ownerEmail);
    }

    // Fetch all messages for this conversation
    const messages = await Message.find({ conversationId: convo.conversationId })
      .lean()
      .sort({ createdAt: 1 });

    const cleanedConvo = stripFields(convo, CONVO_STRIP_FIELDS);
    if (ownerEmail) {
      cleanedConvo.title = `[${ownerEmail}] ${cleanedConvo.title}`;
      // Recorded so imports can group conversations by the owner's email domain
      // without having to parse the title prefix.
      cleanedConvo.ownerEmail = ownerEmail;
    }
    cleanedConvo.messages = messages.map((msg) => stripFields(msg, MSG_STRIP_FIELDS));
    truncateToolCallOutputs(cleanedConvo.messages);

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
 * Lists the JSON files directly inside a directory, sorted by name.
 * @param {string} dirPath - The directory to scan.
 * @returns {string[]} Paths of the `.json` files found, in filename order.
 */
function collectJsonFiles(dirPath) {
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => path.join(dirPath, entry.name))
    .sort();
}

/**
 * Imports a single export file into the database under a target user.
 * Uses bulkWrite with upsert for idempotent imports.
 * @param {string} filePath - The export file to read.
 * @param {string} targetUserId - The user the conversations are imported for.
 * @param {Object} context - Shared import state across files.
 * @returns {Promise<boolean>} False when the file was skipped.
 */
async function importConversationFile(filePath, targetUserId, context) {
  const { groupByDomain, fallbackDomain, domainProjects, createdProjects } = context;

  let exportData;
  try {
    exportData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.red(`Error: Could not read "${filePath}" as JSON: ${err.message}`);
    return false;
  }

  if (!exportData.exportVersion || !Array.isArray(exportData.conversations)) {
    console.red(`Error: "${filePath}" is not a valid librechat-bulk-export file. Skipping.`);
    return false;
  }

  const conversations = exportData.conversations;
  console.purple(`Found ${conversations.length} conversation(s) to import from ${filePath}.`);

  let totalConvos = 0;
  let totalMessages = 0;
  let unassignedConvos = 0;

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
      // Export-only metadata; never persisted on the conversation itself.
      delete convoDoc.ownerEmail;
      convoDoc.user = targetUserId;
      delete convoDoc.expiredAt;

      // Group the conversation under a project named after the original
      // owner's email domain, falling back to the target user's domain.
      if (groupByDomain) {
        const domain = getEmailDomain(getOwnerEmail(convo)) || fallbackDomain;
        if (domain) {
          let projectId = domainProjects.get(domain);
          if (projectId === undefined) {
            const project = await getOrCreateDomainProject(domain, targetUserId);
            projectId = project.projectId;
            domainProjects.set(domain, projectId);
            if (project.created) {
              createdProjects.add(domain);
            }
            console.gray(
              `  ${project.created ? 'Created' : 'Using'} project "${domain}" (${projectId})`,
            );
          }
          convoDoc.chatProjectId = projectId;
        } else {
          unassignedConvos++;
        }
      }

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
          filter: { messageId: msg.messageId, user: targetUserId },
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
          timestamps: false,
        },
      });
    }

    if (updateOps.length > 0) {
      await Conversation.bulkWrite(updateOps);
    }
  }

  context.totalConvos += totalConvos;
  context.totalMessages += totalMessages;
  context.unassignedConvos += unassignedConvos;

  console.green(
    `Imported ${totalConvos} conversation(s), ${totalMessages} message(s) from ${filePath}.`,
  );
  return true;
}

/**
 * Imports one or more export files into the database under a target user.
 * Projects are shared across files so a domain maps to a single project.
 * @param {string[]} filePaths - The export files to import, in order.
 * @param {string} targetUserId - The user the conversations are imported for.
 * @param {Object} [options] - Import options.
 * @param {boolean} [options.groupByDomain=true] - Group conversations into domain projects.
 * @returns {Promise<boolean>} False when any file failed to import.
 */
async function importConversations(filePaths, targetUserId, { groupByDomain = true } = {}) {
  // Verify target user exists
  const targetUser = await User.findById(targetUserId).lean();
  if (!targetUser) {
    console.red(`Error: No user found with ID "${targetUserId}".`);
    console.yellow('Tip: Use "npm run list-users" to find valid users.');
    return false;
  }
  console.purple(
    `Importing conversations for user: ${targetUser.email || targetUser.name || targetUserId}`,
  );
  console.purple(`Importing ${filePaths.length} file(s).`);

  const context = {
    groupByDomain,
    fallbackDomain: getEmailDomain(targetUser.email),
    /** @type {Map<string, string>} domain -> chat project id */
    domainProjects: new Map(),
    createdProjects: new Set(),
    totalConvos: 0,
    totalMessages: 0,
    unassignedConvos: 0,
  };

  const failedFiles = [];
  for (const filePath of filePaths) {
    const imported = await importConversationFile(filePath, targetUserId, context);
    if (!imported) {
      failedFiles.push(filePath);
    }
  }

  const { domainProjects, createdProjects, unassignedConvos } = context;

  // Refresh conversation counts / recency stats on every touched project.
  if (domainProjects.size > 0) {
    console.gray('  Refreshing project statistics...');
    for (const [domain, projectId] of domainProjects) {
      try {
        await refreshChatProjectStats(targetUserId, projectId);
      } catch (err) {
        console.yellow(
          `  Warning: could not refresh stats for project "${domain}": ${err.message}`,
        );
      }
    }
  }

  console.green(
    `Import complete: ${context.totalConvos} conversations, ${context.totalMessages} messages ` +
      `from ${filePaths.length - failedFiles.length}/${filePaths.length} file(s).`,
  );

  if (groupByDomain) {
    if (domainProjects.size > 0) {
      const summary = [...domainProjects.keys()]
        .map((domain) => (createdProjects.has(domain) ? `${domain} (new)` : domain))
        .join(', ');
      console.green(`Grouped into ${domainProjects.size} project(s) by email domain: ${summary}`);
    }
    if (unassignedConvos > 0) {
      console.yellow(
        `${unassignedConvos} conversation(s) had no resolvable email domain and were left unassigned.`,
      );
    }
  }

  if (failedFiles.length > 0) {
    console.red(`Skipped ${failedFiles.length} file(s): ${failedFiles.join(', ')}`);
    return false;
  }

  return true;
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

  if (args.export && args.dir) {
    console.red('Error: --dir is only supported for --import. Use --file for exports.');
    return silentExit(1);
  }

  if (args.file && args.dir) {
    console.red('Error: Cannot use both --file and --dir at the same time.');
    return silentExit(1);
  }

  if (!args.file && !args.dir) {
    console.red(`Error: ${args.import ? '--file or --dir is' : '--file is'} required.`);
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

  if (args.export && args.conversation) {
    console.purple('Export Single Conversation (UI-importable)');
    console.purple('---------------');
    await exportSingleConversation(args.file, args.conversation);
  } else if (args.export) {
    console.purple('Bulk Export Conversations');
    console.purple('---------------');
    if (userId) {
      console.purple(`Filtering by user: ${userId}`);
    } else {
      console.purple('Exporting all users\' conversations');
    }
    await exportConversations(args.file, userId, args['exclude-domain']);
  } else {
    console.purple('Bulk Import Conversations');
    console.purple('---------------');
    let filePaths = [args.file];
    if (args.dir) {
      if (!fs.existsSync(args.dir) || !fs.statSync(args.dir).isDirectory()) {
        console.red(`Error: "${args.dir}" is not a directory.`);
        return gracefulExit(1);
      }
      filePaths = collectJsonFiles(args.dir);
      if (filePaths.length === 0) {
        console.red(`Error: No .json files found in "${args.dir}".`);
        return gracefulExit(1);
      }
    }

    const imported = await importConversations(filePaths, userId, {
      groupByDomain: !args['no-projects'],
    });
    if (!imported) {
      return gracefulExit(1);
    }
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
