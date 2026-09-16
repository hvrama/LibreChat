import type { Document, Types } from 'mongoose';
import type {
  PromptScheduleRunStatus,
  TPromptScheduleSource,
  TPromptScheduleNotify,
} from 'librechat-data-provider';

export type PromptScheduleTrigger = 'schedule' | 'manual';

/** Optional schedule embedded on a PromptGroup. */
export interface IPromptGroupSchedule {
  user: Types.ObjectId;
  agent_id: string;
  promptId?: Types.ObjectId | null;
  cron: string;
  timezone: string;
  source: TPromptScheduleSource;
  variables?: Record<string, string>;
  enabled: boolean;
  notify: TPromptScheduleNotify;
  chatProjectId?: string | null;
  nextRunAt?: Date | null;
  lastRunAt?: Date | null;
  lastRunStatus?: PromptScheduleRunStatus | null;
  lastError?: string | null;
  lastConversationId?: string | null;
  runCount: number;
  consecutiveFailures: number;
  lockOwner?: string | null;
  lockExpiresAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IPromptScheduleRun {
  _id?: Types.ObjectId;
  promptGroupId: Types.ObjectId;
  user: Types.ObjectId;
  tenantId?: string;
  status: PromptScheduleRunStatus;
  trigger: PromptScheduleTrigger;
  startedAt: Date;
  finishedAt?: Date | null;
  expiresAt: Date;
  conversationId?: string | null;
  shareId?: string | null;
  recipientCount: number;
  warnings: string[];
  errorMessage?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IPromptScheduleRunDocument extends Omit<IPromptScheduleRun, '_id'>, Document {}
