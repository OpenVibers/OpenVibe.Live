#!/usr/bin/env node
/**
 * Raw analytics retention and one-time scrub for data/analytics.db (ADR-021). The command itself is
 * openvibe-shared/analytics/prune-cli; this wrapper passes Live's better-sqlite3 and default database.
 *
 *   node scripts/analytics-prune.js                          # dry run: counts only, changes nothing
 *   node scripts/analytics-prune.js --scrub                  # dry run including what the scrub would rewrite
 *   node scripts/analytics-prune.js --apply --backup <file>  # online backup to <file>, then prune
 *   node scripts/analytics-prune.js --apply --scrub --backup <file>
 *   node scripts/analytics-prune.js --apply --no-backup      # prune without a backup (explicit)
 *   node scripts/analytics-prune.js --help                   # every option
 *
 * Default database: $ANALYTICS_DB, else data/analytics.db next to this repo.
 */
'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const cli = require('openvibe-shared/analytics/prune-cli');

function main(argv, log) {
    return cli.main(argv, { Database, log, defaultDb: process.env.ANALYTICS_DB || path.join(__dirname, '..', 'data', 'analytics.db') });
}

if (require.main === module) cli.run(main);

module.exports = { main };
