const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { PostHog } = require('posthog-node');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { silentExit } = require('./helpers');
const { User, Message } = require('@librechat/data-schemas').createModels(mongoose);
const connect = require('./connect');

const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
const TENANT_TYPES = ['POC', 'PROD', 'DEMO', 'DEV'];
const EVENTS = ['user_registered', 'message_sent', 'message_feedback'];

/**
 * Resolve the tenant properties attached to every exported event.
 * POSTHOG_TENANT_TYPE must be one of the supported enum values.
 */
function resolveTenant() {
  const tenantType = process.env.POSTHOG_TENANT_TYPE;
  if (tenantType && !TENANT_TYPES.includes(tenantType)) {
    console.red(
      `Invalid POSTHOG_TENANT_TYPE: "${tenantType}". Expected one of ${TENANT_TYPES.join(', ')}.`,
    );
    silentExit(1);
  }

  return {
    tenantId: process.env.POSTHOG_TENANT_ID,
    tenantHost: process.env.POSTHOG_TENANT_HOST,
    tenantType,
  };
}

/**
 * Parse CLI arguments: an optional `--event <name>` filter (defaults to all
 * events) and a required positional epoch_ms watermark.
 *
 * The watermark skips events created before it so that re-running the script
 * does not export the same events twice. It is mandatory: pass the previous
 * run's epoch to export only what is new, or an earlier epoch to backfill.
 *
 * @returns {{ event: string | undefined, sinceMs: number }}
 */
function parseArgs() {
  const args = process.argv.slice(2);
  let event;
  let sinceRaw;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--event' || arg === '-e') {
      event = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--event=')) {
      event = arg.slice('--event='.length);
      continue;
    }
    sinceRaw = arg;
  }

  if (event !== undefined && !EVENTS.includes(event)) {
    console.red(`Invalid --event: "${event}". Expected one of ${EVENTS.join(', ')}.`);
    silentExit(1);
  }

  if (sinceRaw === undefined) {
    console.red('Missing required epoch_ms argument.');
    console.orange('Usage: node config/export-analytics.js [--event <name>] <epoch_ms>');
    silentExit(1);
  }

  const sinceMs = Number(sinceRaw);
  if (!Number.isFinite(sinceMs)) {
    console.red(`Invalid epoch_ms argument: "${sinceRaw}". Expected a number in milliseconds.`);
    silentExit(1);
  }

  return { event, sinceMs };
}

/**
 * Capture `user_registered` events for users created at/after the watermark.
 * Uses the user's email as the person distinct_id and sets person properties.
 * @param {import('posthog-node').PostHog} client
 * @param {Date} since
 * @param {object} tenant
 * @returns {Promise<number>} number of events captured
 */
async function captureUserEvents(client, since, tenant) {
  const users = await User.find({ createdAt: { $gte: since } }).lean();

  let count = 0;
  for (const user of users) {
    if (!user.email) {
      continue;
    }

    client.capture({
      distinctId: user.email,
      event: 'user_registered',
      timestamp: new Date(user.createdAt),
      properties: {
        ...tenant,
        userId: user._id.toString(),
        email: user.email,
        name: user.name,
        username: user.username,
        provider: user.provider,
        role: user.role,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
        $set: {
          email: user.email,
          name: user.name,
          username: user.username,
          provider: user.provider,
          role: user.role,
          emailVerified: user.emailVerified,
        },
      },
    });
    count += 1;
  }

  return count;
}

/**
 * Capture `message_sent` events for user-entered messages created at/after the
 * watermark. Maps each message's user to their email for the distinct_id.
 * @param {import('posthog-node').PostHog} client
 * @param {Date} since
 * @param {Map<string, string>} emailById
 * @param {object} tenant
 * @returns {Promise<number>} number of events captured
 */
async function captureMessageEvents(client, since, emailById, tenant) {
  const messages = await Message.find({
    isCreatedByUser: true,
    createdAt: { $gte: since },
  })
    .select('messageId parentMessageId conversationId text createdAt updatedAt user')
    .lean();

  let count = 0;
  for (const message of messages) {
    const distinctId = emailById.get(String(message.user));
    if (!distinctId) {
      continue;
    }

    client.capture({
      distinctId,
      event: 'message_sent',
      timestamp: new Date(message.createdAt),
      properties: {
        ...tenant,
        messageId: message.messageId,
        parentMessageId: message.parentMessageId,
        conversationId: message.conversationId,
        text: message.text,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      },
    });
    count += 1;
  }

  return count;
}

/**
 * Capture `message_feedback` events for messages that carry feedback and were
 * last updated at/after the watermark. Feedback has no dedicated timestamp, so
 * updatedAt (bumped when feedback is applied) is used as the event time.
 * @param {import('posthog-node').PostHog} client
 * @param {Date} since
 * @param {Map<string, string>} emailById
 * @param {object} tenant
 * @returns {Promise<number>} number of events captured
 */
async function captureFeedbackEvents(client, since, emailById, tenant) {
  const messages = await Message.find({
    feedback: { $exists: true, $ne: null },
    updatedAt: { $gte: since },
  })
    .select('messageId parentMessageId conversationId feedback createdAt updatedAt user')
    .lean();

  let count = 0;
  for (const message of messages) {
    const distinctId = emailById.get(String(message.user));
    if (!distinctId) {
      continue;
    }

    client.capture({
      distinctId,
      event: 'message_feedback',
      timestamp: new Date(message.updatedAt),
      properties: {
        ...tenant,
        messageId: message.messageId,
        parentMessageId: message.parentMessageId,
        conversationId: message.conversationId,
        feedbackRating: message.feedback.rating,
        feedbackTag: message.feedback.tag && message.feedback.tag.key,
        feedbackText: message.feedback.text,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      },
    });
    count += 1;
  }

  return count;
}

(async () => {
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) {
    console.red('POSTHOG_API_KEY is not set in the .env file.');
    silentExit(1);
  }

  const tenant = resolveTenant();
  const { event, sinceMs } = parseArgs();
  const since = new Date(sinceMs);
  const shouldRun = (name) => event === undefined || event === name;

  await connect();

  console.purple('----------------------------------------');
  console.purple('Exporting analytics to PostHog');
  console.purple(`Events: ${event || 'all'}`);
  console.purple(`Only events created at/after ${since.toISOString()} (${sinceMs}ms)`);
  console.purple('----------------------------------------');

  const allUsers = await User.find({}).select('email').lean();
  const emailById = new Map(
    allUsers.filter((user) => user.email).map((user) => [String(user._id), user.email]),
  );

  const client = new PostHog(apiKey, { host: POSTHOG_HOST });

  try {
    let total = 0;
    if (shouldRun('user_registered')) {
      const count = await captureUserEvents(client, since, tenant);
      console.blue(`user_registered events: ${count}`);
      total += count;
    }
    if (shouldRun('message_sent')) {
      const count = await captureMessageEvents(client, since, emailById, tenant);
      console.blue(`message_sent events:    ${count}`);
      total += count;
    }
    if (shouldRun('message_feedback')) {
      const count = await captureFeedbackEvents(client, since, emailById, tenant);
      console.blue(`message_feedback events: ${count}`);
      total += count;
    }

    await client.shutdown();
    console.green(`Exported ${total} event(s) to PostHog.`);
  } catch (err) {
    console.red(`Failed to export analytics: ${err.message}`);
    await client.shutdown().catch(() => {});
    silentExit(1);
  }

  silentExit(0);
})();

process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    console.error('There was an uncaught error:');
    console.error(err);
  }

  if (!err.message.includes('fetch failed')) {
    process.exit(1);
  }
});
