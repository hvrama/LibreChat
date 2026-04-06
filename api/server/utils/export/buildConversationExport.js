const { getConvo } = require('~/models/Conversation');
const { getMessages } = require('~/models');

const MAX_OUTPUT_BYTES = 1024;

/**
 * Truncates a UTF-8 string to at most maxBytes bytes without splitting multi-byte characters.
 *
 * @param {string} str - The string to truncate.
 * @param {number} maxBytes - Maximum byte length.
 * @returns {string} - The truncated string.
 */
function truncateToBytes(str, maxBytes) {
  if (Buffer.byteLength(str, 'utf-8') <= maxBytes) {
    return str;
  }
  const buf = Buffer.from(str, 'utf-8');
  const truncated = buf.subarray(0, maxBytes).toString('utf-8');
  // Remove the last character in case it was a partial multi-byte sequence
  const clean = truncated.replace(/[\uFFFD]$/, '');
  return clean + '... [truncated]';
}

/**
 * Deep-clones a message content array and truncates tool call output fields to MAX_OUTPUT_BYTES.
 *
 * @param {Array|undefined} content - The message content array.
 * @returns {Array|undefined} - The cloned and truncated content array.
 */
function truncateContentOutputs(content) {
  if (!content || !Array.isArray(content)) {
    return content;
  }

  const cloned = JSON.parse(JSON.stringify(content));

  for (const part of cloned) {
    if (part.type !== 'tool_call' || !part.tool_call) {
      continue;
    }

    const tc = part.tool_call;

    // FunctionToolCall: tool_call.function.output
    if (tc.function && typeof tc.function.output === 'string') {
      tc.function.output = truncateToBytes(tc.function.output, MAX_OUTPUT_BYTES);
    }

    // Agent ToolCall: tool_call.output
    if (typeof tc.output === 'string') {
      tc.output = truncateToBytes(tc.output, MAX_OUTPUT_BYTES);
    }

    // CodeToolCall: tool_call.code_interpreter.outputs
    if (tc.code_interpreter && Array.isArray(tc.code_interpreter.outputs)) {
      const serialized = JSON.stringify(tc.code_interpreter.outputs);
      if (Buffer.byteLength(serialized, 'utf-8') > MAX_OUTPUT_BYTES) {
        tc.code_interpreter.outputs = [
          { truncated: truncateToBytes(serialized, MAX_OUTPUT_BYTES) },
        ];
      }
    }
  }

  return cloned;
}

/**
 * Builds a conversation export JSON object compatible with LibreChat's import format.
 *
 * @param {string} userId - The ID of the user who owns the conversation.
 * @param {string} conversationId - The ID of the conversation to export.
 * @returns {Promise<Object>} - The conversation export object.
 */
async function buildConversationExport(userId, conversationId) {
  const convo = await getConvo(userId, conversationId);
  if (!convo) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }

  const messages = await getMessages({ conversationId, user: userId });

  return {
    conversationId: convo.conversationId,
    title: convo.title || 'Untitled',
    endpoint: convo.endpoint,
    exportAt: new Date().toISOString(),
    messages: messages.map((msg) => ({
      messageId: msg.messageId,
      parentMessageId: msg.parentMessageId,
      conversationId: msg.conversationId,
      sender: msg.sender,
      text: msg.text,
      isCreatedByUser: msg.isCreatedByUser,
      createdAt: msg.createdAt,
      updatedAt: msg.updatedAt,
      model: msg.model,
      endpoint: msg.endpoint,
      unfinished: msg.unfinished,
      error: msg.error,
      content: truncateContentOutputs(msg.content),
      feedback: msg.feedback,
    })),
  };
}

module.exports = { buildConversationExport };
