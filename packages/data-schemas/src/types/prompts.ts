import type { Document, Types } from 'mongoose';
import type { IPromptGroupSchedule } from './promptSchedule';

export interface IPrompt extends Document {
  groupId: Types.ObjectId;
  author: Types.ObjectId;
  prompt: string;
  type: 'text' | 'chat';
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}

export interface IPromptGroup {
  _id?: Types.ObjectId;
  name: string;
  numberOfGenerations: number;
  oneliner: string;
  category: string;
  productionId: Types.ObjectId;
  author: Types.ObjectId;
  authorName: string;
  command?: string;
  schedule?: IPromptGroupSchedule;
  createdAt?: Date;
  updatedAt?: Date;
  isPublic?: boolean;
  tenantId?: string;
}

export interface IPromptGroupDocument extends Omit<IPromptGroup, '_id'>, Document {}
