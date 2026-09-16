import { PrincipalType } from 'librechat-data-provider';
import type { Model, Types, FilterQuery } from 'mongoose';
import type { IAclEntry, IGroup, IUser } from '~/types';
import { isValidObjectIdString } from '~/utils/objectId';
import { permissionBitSupersets } from './aclEntry';

export type ResourceAccessRecipientsInput = {
  resourceType: string;
  resourceId: string | Types.ObjectId;
  permissionBit: number;
};

export type ResourceAccessRecipients = {
  /** Unique user ids (as strings) with the requested permission via USER or GROUP grants */
  userIds: string[];
  /** Principal types that were present on the resource but intentionally not expanded */
  skipped: PrincipalType[];
};

export interface RecipientMethods {
  findUserIdsWithResourceAccess(
    input: ResourceAccessRecipientsInput,
  ): Promise<ResourceAccessRecipients>;
}

const NON_EXPANDED_PRINCIPALS = new Set<PrincipalType>([PrincipalType.ROLE, PrincipalType.PUBLIC]);

export function createRecipientMethods(mongoose: typeof import('mongoose')): RecipientMethods {
  async function resolveGroupMemberIds(groupIds: Types.ObjectId[]): Promise<string[]> {
    if (groupIds.length === 0) {
      return [];
    }
    const Group = mongoose.models.Group as Model<IGroup>;
    const User = mongoose.models.User as Model<IUser>;
    const groups = await Group.find({ _id: { $in: groupIds } })
      .select('memberIds')
      .lean<Pick<IGroup, 'memberIds'>[]>();
    const memberIds = [...new Set(groups.flatMap((group) => group.memberIds ?? []))];
    if (memberIds.length === 0) {
      return [];
    }
    const validObjectIds = memberIds.filter(isValidObjectIdString);
    const conditions: FilterQuery<IUser>[] = [{ idOnTheSource: { $in: memberIds } }];
    if (validObjectIds.length > 0) {
      conditions.push({ _id: { $in: validObjectIds } });
    }
    const users = await User.find({ $or: conditions }).select('_id').lean<Pick<IUser, '_id'>[]>();
    return users.map((user) => user._id.toString());
  }

  async function findUserIdsWithResourceAccess(
    input: ResourceAccessRecipientsInput,
  ): Promise<ResourceAccessRecipients> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const entries = await AclEntry.find({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      permBits: { $in: permissionBitSupersets(input.permissionBit) },
    })
      .select('principalType principalId')
      .lean<Pick<IAclEntry, 'principalType' | 'principalId'>[]>();

    const userIds = new Set<string>();
    const groupIds: Types.ObjectId[] = [];
    const skipped = new Set<PrincipalType>();

    for (const entry of entries) {
      if (entry.principalType === PrincipalType.USER && entry.principalId) {
        userIds.add(entry.principalId.toString());
      } else if (entry.principalType === PrincipalType.GROUP && entry.principalId) {
        groupIds.push(entry.principalId as Types.ObjectId);
      } else if (NON_EXPANDED_PRINCIPALS.has(entry.principalType)) {
        skipped.add(entry.principalType);
      }
    }

    const memberIds = await resolveGroupMemberIds(groupIds);
    for (const memberId of memberIds) {
      userIds.add(memberId);
    }

    return { userIds: [...userIds], skipped: [...skipped] };
  }

  return { findUserIdsWithResourceAccess };
}
