'use strict';
/**
 * Where Live keeps its files.
 *
 * Everything Live writes lives under one data directory: DATA_DIR, or ./data relative to the
 * working directory (the checkout in production, where the unit's WorkingDirectory is
 * /opt/openvibe.live). That is what lets a second instance (a restore drill, a test) run next to
 * production without touching production's files: point DATA_DIR somewhere else. The database is PostgreSQL
 * (DATABASE_URL; server/db/database.js), or an embedded PGlite database under DATA_DIR in development.
 *
 * A few locations also have their own variable (EMOTES_PATH, LIVE_THUMBS_PATH, …). In a restore drill
 * (LIVE_DRILL, see ./drill.js) those are ignored: the drill loads the production env file, whose
 * values point at production's directories. Only DATA_DIR counts there.
 */
const fs = require('fs');
const path = require('path');
const drill = require('./drill');

let real = { from: null, dir: null };
/**
 * The data directory (absolute, links resolved). In production ./data is a release's link to the shared data
 * folder, and a release folder can be removed while the process still runs from it (2026-10-17: thumbnails
 * and AI frames failed with ENOENT for 2.5 hours), so every path is built on the link's target.
 */
function dataDir() {
    const want = path.resolve(process.env.DATA_DIR || './data');
    if (real.from === want) return real.dir;
    try { real = { from: want, dir: fs.realpathSync(want) }; } catch { return want; /* not made yet */ }
    return real.dir;
}

/** A path under the data directory. */
function data(...parts) {
    return path.join(dataDir(), ...parts);
}

/**
 * A location with its own override variable (e.g. dir('EMOTES_PATH', 'emotes')): the variable when
 * set (never in a drill), else <data dir>/<parts>.
 */
function dir(envName, ...parts) {
    const v = !drill.enabled && envName ? process.env[envName] : '';
    return v ? path.resolve(v) : data(...parts);
}



module.exports = { dataDir, data, dir };
