'use strict';
/**
 * Staff gates ask the openvibe-contracts staff map (ADR-022): permissions.can(user, 'staff.<area>.<action>').
 * The role helpers answer exactly what the map says for every role, and no server file compares an
 * actor's role by hand any more (the few left compare a TARGET's rank, listed below).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'live-staff-')), 'test.db');
process.env.NODE_ENV = 'test';
const log = console.log;
console.log = () => {};
const { staff } = require('openvibe-contracts');
const db = require('../server/db/database');
if (db.initDb) db.initDb();
const p = require('../server/auth/permissions');

const people = {
    anonymous: null,
    user: { id: 901, role: 'user' },
    streamer: { id: 902, role: 'streamer' },
    global_mod: { id: 903, role: 'global_mod' },
    admin: { id: 904, role: 'admin' },
    owner: { id: 905, role: 'admin', is_owner: 1 },
};
const HELPERS = {
    canAccessAdminPanel: 'staff.console.access', canManageUsers: 'staff.users.manage', canManageGlobalMods: 'staff.roles.assign',
    canManageSiteSettings: 'staff.site.configure', canManageSecrets: 'staff.secrets.manage', canManageMoney: 'staff.money.freeze',
    canGrantAdmin: 'staff.roles.grant_admin', canReviewCashouts: 'staff.money.cashouts', canReviewVpn: 'staff.moderation.vpn',
    canManageSiteBans: 'staff.moderation.bans', canViewOtherUserLogs: 'staff.moderation.logs', canForceEndStreams: 'staff.streams.end',
};
for (const [name, u] of Object.entries(people)) {
    const map = new Set(u ? staff.capabilitiesOf({ role: u.role, is_owner: !!u.is_owner }) : []);
    for (const cap of staff.map.capabilities.map((c) => c.id)) assert.strictEqual(p.can(u, cap), map.has(cap), `${name} ${cap}`);
    for (const [h, cap] of Object.entries(HELPERS)) assert.strictEqual(!!p[h](u), map.has(cap), `${name}: ${h} answers the map (${cap})`);
}
assert.strictEqual(p.can(people.admin, 'staff.secrets.manage'), false, 'an admin is not the owner');
assert.strictEqual(p.can(people.owner, 'staff.secrets.manage'), true);
assert.strictEqual(p.can(people.global_mod, 'staff.hardware.manage'), false);
assert.strictEqual(p.can({ id: 906, role: 'user', staff_caps: ['staff.moderation.*'] }, 'staff.moderation.chat'), true, 'issued claims win');
assert.throws(() => p.can(people.admin, 'staff.nope'), /unknown staff capability/);
assert.throws(() => p.requireCap('staff.nope'), /unknown staff capability/);

// requireCap as middleware.
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json() { return this; } });
let r = res(), passed = false;
p.requireCap('staff.hardware.manage')({ user: people.global_mod }, r, () => { passed = true; });
assert.strictEqual(r.code, 403); assert.strictEqual(passed, false);
p.requireCap('staff.hardware.manage')({ user: people.admin }, res(), () => { passed = true; });
assert.strictEqual(passed, true);

// The UI gets the same answers.
const caps = p.getCapabilities(people.global_mod);
assert.deepStrictEqual(caps.staff_caps, staff.capabilitiesOf('global_mod'));
assert.strictEqual(caps.view_ip_info, true);
assert.deepStrictEqual(p.getCapabilities(null).staff_caps, []);

// No raw actor-role comparisons in server code. What is left compares a target's rank or maps role data.
const TARGET_RANK = [
    ['internal/routes.js', "user.is_owner && role !== 'admin'"],
    ['chat/live-context-routes.js', "target.role === 'admin'"],
    ['chat/chat-server.js', "targetUser.role === 'admin'"],
    ['admin/routes.js', "target.role === 'admin'"],
    ['admin/routes.js', "banTarget.role === 'admin'"],
    ['admin/routes.js', "if (user.role === 'admin') return res.status(400)"],
    ['admin/routes.js', "if (user.role === 'global_mod') return res.status(400)"],
    ['admin/routes.js', "if (user.role !== 'global_mod') return res.status(400)"],
    ['admin/routes.js', "if (user.role !== 'admin') return res.status(400)"],
    ['db/database.js', "row.role === 'admin' || row.role === 'global_mod'"],
];
const RAW = /role\s*[!=]==?\s*'(admin|global_mod)'/;
const offenders = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { walk(f); continue; }
        if (!e.name.endsWith('.js')) continue;
        const rel = path.relative(path.join(__dirname, '..', 'server'), f).split(path.sep).join('/');
        if (rel === 'auth/permissions.js') continue;
        fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            if (!RAW.test(line)) return;
            if (TARGET_RANK.some(([file, snip]) => file === rel && line.includes(snip))) return;
            offenders.push(`server/${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
    }
})(path.join(__dirname, '..', 'server'));
assert.deepStrictEqual(offenders, [], `raw role checks; use permissions.can(user, 'staff.…'):\n${offenders.join('\n')}`);

log('staff capabilities: all checks passed');
process.exit(0);
