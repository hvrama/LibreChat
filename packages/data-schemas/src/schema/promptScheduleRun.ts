import { Schema } from 'mongoose';
import { PromptScheduleRunStatus } from 'librechat-data-provider';
import type { IPromptScheduleRunDocument } from '~/types';

const promptScheduleRunSchema: Schema<IPromptScheduleRunDocument> =
  new Schema<IPromptScheduleRunDocument>(
    {
      promptGroupId: {
        type: Schema.Types.ObjectId,
        ref: 'PromptGroup',
        required: true,
        index: true,
      },
      user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
      },
      tenantId: {
        type: String,
        index: true,
      },
      status: {
        type: String,
        enum: Object.values(PromptScheduleRunStatus),
        required: true,
      },
      trigger: {
        type: String,
        enum: ['schedule', 'manual'],
        required: true,
        default: 'schedule',
      },
      startedAt: {
        type: Date,
        required: true,
      },
      finishedAt: {
        type: Date,
        default: null,
      },
      expiresAt: {
        type: Date,
        required: true,
      },
      conversationId: {
        type: String,
        default: null,
      },
      shareId: {
        type: String,
        default: null,
      },
      recipientCount: {
        type: Number,
        default: 0,
        min: 0,
      },
      warnings: {
        type: [String],
        default: [],
      },
      errorMessage: {
        type: String,
        default: null,
      },
    },
    {
      timestamps: true,
    },
  );

promptScheduleRunSchema.index({ promptGroupId: 1, startedAt: -1 });
promptScheduleRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default promptScheduleRunSchema;
