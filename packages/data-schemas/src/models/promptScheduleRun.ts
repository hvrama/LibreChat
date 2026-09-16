import { Model } from 'mongoose';
import type { IPromptScheduleRunDocument } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import promptScheduleRunSchema from '~/schema/promptScheduleRun';

export function createPromptScheduleRunModel(
  mongoose: typeof import('mongoose'),
): Model<IPromptScheduleRunDocument> {
  applyTenantIsolation(promptScheduleRunSchema);
  return (
    mongoose.models.PromptScheduleRun ||
    mongoose.model<IPromptScheduleRunDocument>('PromptScheduleRun', promptScheduleRunSchema)
  );
}
