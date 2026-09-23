'use strict';
/**
 * Where Live keeps its files.
 *
 * Everything Live writes lives under one data directory: DATA_DIR, or ./data relative to the
 * working directory (the checkout in production, where the unit's WorkingDirectory is
 * /opt/openvibe.live). That is what lets a second instance (a restore drill, a test) run next to
 * production without touching production's files: point DATA_DIR and DB_PATH somewhere else.
 *
 * A few locations also have their own variable (EMOTES_PATH, LIVE_THUMBS_PATH, …). In a restore drill
 * (LIVE_DRILL, see ./drill.js) those are ignored: the drill loads the production env file, whose
 * values point at production's directories. Only DATA_DIR and DB_PATH count there.
 */
const path = require('path');
const drill = require('./drill');

/** The data directory (absolute). */
function dataDir() {
    return path.resolve(process.env.DATA_DIR || './data');
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

/** The main SQLite database: DB_PATH, else <data dir>/live.db. */
function dbPath() {
    return process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : data('live.db');
}

/** Page-view analytics (openvibe-shared/analytics): ANALYTICS_DB_PATH, else <data dir>/analytics.db. */
function analyticsDbPath() {
    return dir('ANALYTICS_DB_PATH', 'analytics.db');
}

module.exports = { dataDir, data, dir, dbPath, analyticsDbPath };
