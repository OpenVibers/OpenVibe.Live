'use strict';
/**
 * Loaded with `node -r` into a release booted by test/n-1/service.js (N-1 at record time, N in the
 * test), from that release's directory:
 *   - N1_SQL_OUT: every SQL text the process prepares or executes on the main database (DB_PATH) is
 *     written there as JSON when it exits;
 *   - the restore-drill sandbox (LIVE_DRILL: no outbound connection, program, listener or timer) is
 *     kept, but its read-only guard is lifted, so the old client's writes reach their routes.
 */
const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const out = process.env.N1_SQL_OUT;
if (out) {
    const Database = require(path.join(cwd, 'node_modules', 'better-sqlite3'));
    const main = path.resolve(process.env.DB_PATH || '');
    const seen = new Set();
    const note = (db, sql) => { try { if (path.resolve(db.name) === main) seen.add(String(sql)); } catch { /* */ } };
    const prepare = Database.prototype.prepare;
    Database.prototype.prepare = function (sql, ...rest) { note(this, sql); return prepare.call(this, sql, ...rest); };
    const exec = Database.prototype.exec;
    Database.prototype.exec = function (sql, ...rest) { note(this, sql); return exec.call(this, sql, ...rest); };
    process.on('exit', () => { try { fs.writeFileSync(out, JSON.stringify([...seen])); } catch { /* */ } });
}

const drill = require(path.join(cwd, 'server', 'drill'));
drill.readOnly = (req, res, next) => next();
