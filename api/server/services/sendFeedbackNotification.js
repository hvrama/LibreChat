const { logger } = require('@librechat/data-schemas');
const { checkEmailConfig } = require('@librechat/api');
const { buildConversationExport } = require('~/server/utils/export/buildConversationExport');
const sendEmail = require('~/server/utils/sendEmail');

/**
 * Sends a feedback notification email to APPROVER_EMAIL with the conversation attached as JSON.
 *
 * @param {Object} params
 * @param {string} params.userId - The ID of the user who submitted feedback.
 * @param {string} params.userName - Display name of the user.
 * @param {string} params.conversationId - The conversation ID.
 * @param {string} params.messageId - The message ID that received feedback.
 * @param {Object} params.feedback - The feedback object { rating, tag, text }.
 */
async function sendFeedbackNotification({ userId, userName, conversationId, messageId, feedback }) {
  const approverEmail = process.env.APPROVER_EMAIL;
  if (!approverEmail || !checkEmailConfig()) {
    return;
  }

  try {
    const exportData = await buildConversationExport(userId, conversationId);

    const jsonString = JSON.stringify(exportData, null, 2);

    await sendEmail({
      email: approverEmail,
      subject: `Thumbs-down feedback: ${exportData.title}`,
      payload: {
        name: 'Approver',
        userName: userName || 'Unknown user',
        conversationTitle: exportData.title,
        conversationId,
        messageId,
        feedbackTag: feedback.tag || 'N/A',
        feedbackText: feedback.text || '',
        appName: process.env.APP_TITLE || 'LibreChat',
        year: new Date().getFullYear().toString(),
      },
      template: 'feedbackNotification.handlebars',
      throwError: false,
      attachments: [
        {
          filename: `conversation-${conversationId}.json`,
          content: jsonString,
          contentType: 'application/json',
        },
      ],
    });

    logger.info(
      `[feedbackNotification] Email sent to ${approverEmail} for conversation ${conversationId}`,
    );
  } catch (error) {
    logger.error('[feedbackNotification] Failed to send feedback email:', error);
  }
}

module.exports = { sendFeedbackNotification };
