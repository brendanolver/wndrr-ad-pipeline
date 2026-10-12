// GET /api/version -> { version, build, scheme, entries[] }. Read-only; any signed-in user (it is shown in the sidebar). `build` is the short commit the host reports, when it does.
const express = require('express');
const versionLib = require('../lib/version');

const router = express.Router();

router.get('/', (req, res, next) => {
  try {
    const { scheme, entries } = versionLib.load();
    const sha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || '';
    res.json({ version: entries.length ? entries[0].version : null, build: sha ? sha.slice(0, 7) : null, scheme, entries });
  } catch (err) { next(err); }
});

module.exports = router;
