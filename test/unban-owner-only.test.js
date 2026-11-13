'use strict';
// Lifting a site-wide ban is the owner's alone (the owner, 2026-11-13: "admins can't unban … only owner rank, but they
// can view"). Every route that clears a site ban checks for the owner; a stream's own ban stays with its moderators.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const mod = read('server/admin/mod-routes.js');
const admin = read('server/admin/routes.js');
assert.ok(/router\.delete\('\/users\/:id\/ban', permissions\.requireOwner, async/.test(mod), 'mod routes: DELETE /users/:id/ban is the owner\'s');
assert.ok(/router\.delete\('\/users\/:id\/ban', permissions\.requireOwner, async/.test(admin), 'admin routes: DELETE /users/:id/ban is the owner\'s');
assert.ok(/if \(!ban\.stream_id\) \{[\s\S]{0,200}if \(!permissions\.isOwner\(req\.user\)\) \{\s*return res\.status\(403\)/.test(mod), 'DELETE /ban/:id: a site-wide ban needs the owner');
assert.ok(!/router\.delete\('\/users\/:id\/ban', permissions\.requireGlobalMod/.test(mod), 'no global mod path left');

const permissions = require('../server/auth/permissions');
const run = (user) => {
    let status = 200, passed = false;
    const res = { status(s) { status = s; return this; }, json() { return this; } };
    permissions.requireOwner({ user }, res, () => { passed = true; });
    return { status, passed };
};
assert.strictEqual(run({ id: 1, role: 'admin', is_owner: 0 }).passed, false, 'an admin who is not the owner is turned away');
assert.strictEqual(run({ id: 2, role: 'global_mod' }).passed, false, 'a global mod is turned away');
assert.strictEqual(run({ id: 3, role: 'admin', is_owner: 1 }).passed, true, 'the owner may lift it');
console.log('unban-owner-only: only the owner lifts a site-wide ban; admins and mods see the list');
