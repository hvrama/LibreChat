import { Schema } from 'mongoose';
import { Constants, PromptScheduleRunStatus } from 'librechat-data-provider';
import type { IPromptGroupDocument, IPromptGroupSchedule } from '~/types';

const promptGroupScheduleSchema: Schema<IPromptGroupSchedule> = new Schema<IPromptGroupSchedule>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    agent_id: { type: String, required: true },
    promptId: { type: Schema.Types.ObjectId, ref: 'Prompt', default: null },
    cron: { type: String, required: true },
    timezone: { type: String, required: true, default: 'UTC' },
    source: { type: Schema.Types.Mixed, required: true },
    variables: { type: Schema.Types.Mixed, default: {} },
    enabled: { type: Boolean, default: true },
    notify: {
      email: { type: Boolean, default: false },
    },
    chatProjectId: { type: String, default: null },
    nextRunAt: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },
    lastRunStatus: {
      type: String,
      enum: Object.values(PromptScheduleRunStatus),
      default: null,
    },
    lastError: { type: String, default: null },
    lastConversationId: { type: String, default: null },
    runCount: { type: Number, default: 0, min: 0 },
    consecutiveFailures: { type: Number, default: 0, min: 0 },
    lockOwner: { type: String, default: null },
    lockExpiresAt: { type: Date, default: null },
  },
  { _id: false, timestamps: true },
);

const promptGroupSchema: Schema<IPromptGroupDocument> = new Schema<IPromptGroupDocument>(
  {
    name: {
      type: String,
      required: true,
      index: true,
    },
    numberOfGenerations: {
      type: Number,
      default: 0,
    },
    oneliner: {
      type: String,
      default: '',
    },
    category: {
      type: String,
      default: '',
      index: true,
    },
    productionId: {
      type: Schema.Types.ObjectId,
      ref: 'Prompt',
      required: true,
      index: true,
    },
    author: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    authorName: {
      type: String,
      required: true,
    },
    command: {
      type: String,
      index: true,
      validate: {
        validator: function (v: string | undefined | null): boolean {
          return v === undefined || v === null || v === '' || /^[a-z0-9-]+$/.test(v);
        },
        message: (props: { value?: string } | undefined) =>
          `${props?.value ?? 'Value'} is not a valid command. Only lowercase alphanumeric characters and hyphens are allowed.`,
      },
      maxlength: [
        Constants.COMMANDS_MAX_LENGTH as number,
        `Command cannot be longer than ${Constants.COMMANDS_MAX_LENGTH} characters`,
      ],
    }, // Casting here bypasses the type error for the command field.
    schedule: {
      type: promptGroupScheduleSchema,
      default: undefined,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

promptGroupSchema.index({ numberOfGenerations: -1, updatedAt: -1, _id: 1 });
promptGroupSchema.index(
  { 'schedule.enabled': 1, 'schedule.nextRunAt': 1 },
  { partialFilterExpression: { 'schedule.enabled': true } },
);

export default promptGroupSchema;
