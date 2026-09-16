import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalType, PermissionBits, ResourceType } from 'librechat-data-provider';
import { createModels } from '~/models';
import type { IAclEntry, IGroup, IUser } from '~/types';
import { createRecipientMethods, type RecipientMethods } from './recipients';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let AclEntry: mongoose.Model<IAclEntry>;
let Group: mongoose.Model<IGroup>;
let User: mongoose.Model<IUser>;
let methods: RecipientMethods;
let modelsToCleanup: string[] = [];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const models = createModels(mongoose);
  modelsToCleanup = Object.keys(models);
  Object.assign(mongoose.models, models);
  AclEntry = mongoose.models.AclEntry as mongoose.Model<IAclEntry>;
  Group = mongoose.models.Group as mongoose.Model<IGroup>;
  User = mongoose.models.User as mongoose.Model<IUser>;
  methods = createRecipientMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  for (const modelName of modelsToCleanup) {
    delete mongoose.models[modelName];
  }
});

afterEach(async () => {
  await Promise.all([AclEntry.deleteMany({}), Group.deleteMany({}), User.deleteMany({})]);
});

async function createUser(name: string, idOnTheSource?: string) {
  return await User.create({
    name,
    email: `${name}@example.com`,
    provider: 'local',
    ...(idOnTheSource ? { idOnTheSource } : {}),
  });
}

describe('findUserIdsWithResourceAccess', () => {
  it('expands user and group grants, skips role and public grants', async () => {
    const resourceId = new mongoose.Types.ObjectId();
    const [a, b, c, d, editorOnly] = await Promise.all([
      createUser('a'),
      createUser('b'),
      createUser('c'),
      createUser('d', 'entra-d'),
      createUser('editor'),
    ]);
    const group = await Group.create({
      name: 'team',
      source: 'local',
      memberIds: [b._id.toString(), c._id.toString(), 'entra-d'],
    });

    await AclEntry.create([
      {
        principalType: PrincipalType.USER,
        principalId: a._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        permBits: PermissionBits.VIEW,
      },
      {
        principalType: PrincipalType.GROUP,
        principalId: group._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        permBits: PermissionBits.VIEW | PermissionBits.EDIT,
      },
      {
        principalType: PrincipalType.ROLE,
        principalId: 'USER',
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        permBits: PermissionBits.VIEW,
      },
      {
        principalType: PrincipalType.PUBLIC,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        permBits: PermissionBits.VIEW,
      },
      {
        principalType: PrincipalType.USER,
        principalId: editorOnly._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        permBits: PermissionBits.EDIT,
      },
    ]);

    const result = await methods.findUserIdsWithResourceAccess({
      resourceType: ResourceType.PROMPTGROUP,
      resourceId,
      permissionBit: PermissionBits.VIEW,
    });

    expect(new Set(result.userIds)).toEqual(
      new Set([a._id.toString(), b._id.toString(), c._id.toString(), d._id.toString()]),
    );
    expect(result.userIds).toHaveLength(4);
    expect(new Set(result.skipped)).toEqual(new Set([PrincipalType.ROLE, PrincipalType.PUBLIC]));
  });

  it('returns nothing for a resource without grants', async () => {
    const result = await methods.findUserIdsWithResourceAccess({
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: new mongoose.Types.ObjectId(),
      permissionBit: PermissionBits.VIEW,
    });
    expect(result).toEqual({ userIds: [], skipped: [] });
  });

  it('ignores grants on other resources', async () => {
    const a = await createUser('a');
    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: a._id,
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: new mongoose.Types.ObjectId(),
      permBits: PermissionBits.VIEW,
    });
    const result = await methods.findUserIdsWithResourceAccess({
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: new mongoose.Types.ObjectId(),
      permissionBit: PermissionBits.VIEW,
    });
    expect(result.userIds).toEqual([]);
  });
});
