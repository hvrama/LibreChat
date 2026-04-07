const express = require('express');
const staticCache = require('../utils/staticCache');
const paths = require('~/config/paths');

const router = express.Router();
router.use(staticCache(paths.privateAssets));

module.exports = router;
