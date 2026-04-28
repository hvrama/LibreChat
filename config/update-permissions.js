const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

const { SystemRoles, PermissionTypes, Permissions } = require('librechat-data-provider');
const connect = require('./connect');

require('~/db/models');
const { updateAccessPermissions } = require('~/models');

async function updateUserPermissions() {
  await connect();

  console.log('Updating USER role permissions...');
  console.log('');
  console.log('Agent permissions:');
  console.log('  - SHARED_GLOBAL (Sharing): false');
  console.log('  - CREATE (Creating): false');
  console.log('  - USE (Using): true');
  console.log('');
  console.log('Memory permissions:');
  console.log('  - USE: false');
  console.log('  - CREATE: false');
  console.log('  - UPDATE: false');
  console.log('  - READ: false');
  console.log('  - OPT_OUT: false');
  console.log('');
  console.log('Prompt permissions:');
  console.log('  - SHARED_GLOBAL (Sharing): true');
  console.log('  - CREATE (Creating): true');
  console.log('  - USE (Using): true');

  await updateAccessPermissions(SystemRoles.USER, {
    [PermissionTypes.AGENTS]: {
      [Permissions.SHARED_GLOBAL]: false,
      [Permissions.CREATE]: false,
      [Permissions.USE]: true,
    },
    [PermissionTypes.MEMORIES]: {
      [Permissions.USE]: false,
      [Permissions.CREATE]: false,
      [Permissions.UPDATE]: false,
      [Permissions.READ]: false,
      [Permissions.OPT_OUT]: false,
    },
    [PermissionTypes.PROMPTS]: {
      [Permissions.SHARED_GLOBAL]: true,
      [Permissions.CREATE]: true,
      [Permissions.USE]: true,
    },
  });

  console.log('');
  console.log('USER role permissions updated successfully.');
}

if (require.main === module) {
  updateUserPermissions()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error('Failed to update permissions:', error);
      process.exit(1);
    });
}

module.exports = { updateUserPermissions };
