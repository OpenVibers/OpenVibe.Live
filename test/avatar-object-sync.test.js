'use strict';
// A picture set on Live becomes the person's own avatar object on openvibe.media (incident 2026-11-06): the
// Network copies it and answers the address to store, and Live keeps that object rather than the paste screenshot
// it was made from. An unlinked account makes no call; a refused or unreachable Network leaves the source in place
// and never throws through the fire-and-forget form.
const assert = require('assert');

process.env.NODE_ENV = 'test';

const db = require('../server/db/database');
const principal = require('../server/net/network-principal');
principal.configured = () => true;
principal.headersFor = async () => ({ Authorization: 'Bearer test' });
principal.tokenRejected = () => {};

const notify = require('../server/utils/notify');

(async () => {
    const COPY = 'https://openvibe.media/o/med_01KZK5GRQ088Y3CW1TMEF4Z4RN';
    const SOURCE = 'https://openvibe.media/p/paste-1/screenshot';
    await db.run("INSERT INTO users (id, username, password_hash) OVERRIDING SYSTEM VALUE VALUES (7, 'Ada', 'x'), (8, 'Unlinked', 'x')");
    await db.run("INSERT INTO linked_accounts (user_id, service, service_user_id, linked_at) VALUES (7, 'network', '513', ov_now())");

    const realFetch = global.fetch;
    try {
        const seen = [];
        global.fetch = async (u, o) => {
            seen.push({ url: String(u), body: JSON.parse(o.body) });
            return { ok: true, status: 200, json: async () => ({ ok: true, changed: true, avatar_url: COPY }) };
        };

        const out = await notify.syncAvatarChange({ id: 7, avatar_url: SOURCE });
        assert.deepStrictEqual(out, { ok: true, changed: true, avatar_url: COPY }, 'the copied address comes back to the caller');
        assert.strictEqual(seen.length, 1);
        assert.ok(seen[0].url.endsWith('/internal/user-avatar'), 'the avatar is reported to the Network');
        assert.deepStrictEqual(seen[0].body, { user_id: 513, avatar_url: SOURCE, origin: 'live' }, 'Live sends its own row\'s picture, naming the origin');

        assert.strictEqual(await notify.syncAvatarChange({ id: 8, avatar_url: SOURCE }), null, 'an account with no Network link makes no call');
        assert.strictEqual(seen.length, 1);

        global.fetch = async () => ({ ok: false, status: 422, json: async () => ({ error: 'refused' }) });
        assert.strictEqual(await notify.syncAvatarChange({ id: 7, avatar_url: SOURCE }), null, 'a refused report leaves the source in place');

        global.fetch = async () => { throw new Error('network down'); };
        assert.strictEqual(await notify.syncAvatarChange({ id: 7, avatar_url: SOURCE }), null, 'an unreachable Network is not an error for the route');
        notify.reportAvatarChange({ id: 7, avatar_url: SOURCE });
        await new Promise((r) => setTimeout(r, 20));

        console.log('avatar object sync: all checks passed');
    } finally {
        global.fetch = realFetch;
    }
})().catch((err) => { console.error(err); process.exit(1); });
