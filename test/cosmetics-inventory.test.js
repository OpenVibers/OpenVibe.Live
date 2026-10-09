'use strict';

// ADR-054 §8: Live's cosmetics live in OpenVibe.Inventory (since 2026-10-09). A stand-in Inventory and Network check
// that Live reads a person's items and slots there (by their Network subject, with Live's own token and X-OV-Subject),
// grants, equips, unequips and revokes there, reads many people's sets 100 per call for OpenVibe.Chat's decor lookups,
// shows nothing (rather than an error) when Inventory is down, and refuses writes with a clear message.

const assert = require('assert');
const http = require('http');

console.log = () => {};
console.warn = () => {};

const A = 'usr_01JZ0000000000000000000AAA';
const DEFS = [
    { id: 'itd_01JZ00000000000000000001R1', kind: 'live.name_effect', aliases: ['fx_rainbow'] },
    { id: 'itd_01JZ00000000000000000001R2', kind: 'live.hat', aliases: ['hat_crown'] },
    { id: 'itd_01JZ00000000000000000001R3', kind: 'live.particle', aliases: ['px_sparkle'] },
];
const state = { instances: [], slots: {}, calls: [], down: false };
let seq = 0;

function stub() {
    return http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = chunks.length && /json/.test(String(req.headers['content-type'] || '')) ? JSON.parse(Buffer.concat(chunks).toString()) : null;
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            const u = new URL(req.url, 'http://x');
            if (u.pathname === '/oauth/token') return json(200, { access_token: 'tok_live', token_type: 'Bearer', expires_in: 300 });
            state.calls.push({ method: req.method, path: u.pathname, subject: req.headers['x-ov-subject'] || null, auth: req.headers.authorization });
            if (state.down) return json(503, { code: 'down' });
            if (u.pathname === '/api/v1/definitions') return json(200, { definitions: DEFS });
            if (u.pathname === '/api/v1/me/items') return json(200, { subject: req.headers['x-ov-subject'], instances: state.instances.filter((i) => i.owner === req.headers['x-ov-subject']), definitions: {}, next_cursor: null });
            if (u.pathname === `/api/v1/people/${A}/equipped`) return json(200, { subject: A, slots: state.slots, updated_at: new Date().toISOString() });
            if (u.pathname === '/api/v1/equipped') {
                const subjects = String(u.searchParams.get('subjects') || '').split(',').filter(Boolean);
                state.calls[state.calls.length - 1].subjects = subjects.length;
                if (subjects.length > 100) return json(400, { code: 'inventory.too_many_subjects' });
                return json(200, { equipped: subjects.map((s) => ({ subject: s, slots: s === A ? state.slots : {}, updated_at: null })) });
            }
            if (u.pathname === '/api/v1/grants' && req.method === 'POST') {
                const inst = { id: `inv_01JZ0000000000000000000${String(++seq).padStart(3, '0')}`.replace(/0(?=\d{3}$)/, '1'), definition_id: body.definition_id, owner: body.subject, origin: 'granted', state: 'owned', acquired_at: new Date().toISOString() };
                state.instances.push(inst);
                return json(201, { instance: inst, created: true });
            }
            if (u.pathname === '/api/v1/me/equipped' && req.method === 'PUT') {
                const key = `${body.kind}:${body.slot}`;
                if (body.instance_id === null) delete state.slots[key];
                else { const inst = state.instances.find((i) => i.id === body.instance_id); state.slots[key] = { instance_id: inst.id, definition_id: inst.definition_id }; }
                return json(200, { subject: A, slots: state.slots, updated_at: new Date().toISOString() });
            }
            const m = u.pathname.match(/^\/api\/v1\/instances\/([^/]+)\/revoke$/);
            if (m) { const inst = state.instances.find((i) => i.id === m[1]); inst.state = 'revoked'; for (const [k, v] of Object.entries(state.slots)) if (v.instance_id === inst.id) delete state.slots[k]; return json(200, { instance: inst }); }
            return json(404, { code: 'route.not_found' });
        });
    });
}

(async () => {
    const server = stub();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    process.env.INVENTORY_URL = url;
    process.env.OV_NETWORK_INTERNAL_URL = url;
    process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
    const db = require('../server/db/database');
    await db.initDb();
    const d = db.getDb();
    await d.prepare("INSERT INTO users (id, username, display_name, password_hash) OVERRIDING SYSTEM VALUE VALUES (70, 'ana', 'Ana', '$sso$'), (71, 'nosub', 'No Sub', '$sso$')").run();
    // Live learns a person's subject from their Network token (server/auth/identity-sync.js noteSubject).
    await d.prepare(`INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (70, 'network', '9001', '${A}'), (71, 'network', '9002', NULL)`).run();
    const cosmetics = require('../server/monetization/cosmetics');
    const inventory = require('../server/monetization/inventory-client');

    try {
        // Unlock and equip: in Inventory, for the person's subject, with Live's token.
        assert.strictEqual((await cosmetics.unlockCosmetic(70, 'fx_rainbow')).success, true);
        assert.strictEqual((await cosmetics.unlockCosmetic(70, 'fx_rainbow')).error, 'Already unlocked');
        assert.strictEqual((await cosmetics.unlockCosmetic(70, 'hat_crown')).success, true);
        const grant = state.calls.find((c) => c.path === '/api/v1/grants');
        assert.strictEqual(grant.auth, 'Bearer tok_live');
        assert.deepStrictEqual((await cosmetics.getUnlocked(70)).map((u) => u.item_id).sort(), ['fx_rainbow', 'hat_crown']);
        assert.strictEqual((await cosmetics.equipCosmetic(70, 'fx_rainbow')).success, true);
        assert.strictEqual((await cosmetics.equipCosmetic(70, 'px_sparkle')).error, 'You don\'t own this cosmetic');
        assert.strictEqual(state.calls.filter((c) => c.path === '/api/v1/me/equipped').every((c) => c.subject === A), true, 'acting for her with X-OV-Subject');
        const profile = await cosmetics.getCosmeticProfile(70);
        assert.deepStrictEqual(profile.nameFX, { itemId: 'fx_rainbow', cssClass: 'name-fx-rainbow' });
        assert.strictEqual(profile.hatFX, undefined);
        const full = await cosmetics.getFullInventory(70);
        assert.deepStrictEqual([full.categories.name_effect.map((c) => [c.itemId, c.equipped]), full.categories.hat.length], [[['fx_rainbow', true]], 1]);

        // An admin equips something they do not own: granted, then equipped.
        assert.strictEqual((await cosmetics.equipCosmetic(70, 'px_sparkle', { isAdmin: true })).success, true);
        inventory.forget(A);
        assert.strictEqual((await cosmetics.getEquipped(70)).particle, 'px_sparkle');

        // Unequip and revoke.
        assert.strictEqual((await cosmetics.unequipSlot(70, 'name_effect')).success, true);
        inventory.forget(A);
        assert.strictEqual((await cosmetics.getEquipped(70)).name_effect, undefined);
        assert.strictEqual((await cosmetics.revokeCosmetic(70, 'hat_crown')).success, true);
        assert.ok(!(await cosmetics.getUnlocked(70)).some((u) => u.item_id === 'hat_crown'));

        // OpenVibe.Chat's decor lookup: Ana and 250 others in three batched reads, never one per person; an account
        // without a subject or an unknown id answers an empty profile.
        await cosmetics.equipCosmetic(70, 'fx_rainbow');
        const many = Array.from({ length: 250 }, (_, i) => 1000 + i);
        await d.prepare("INSERT INTO users (id, username, display_name, password_hash) OVERRIDING SYSTEM VALUE SELECT g, 'p' || g, 'P' || g, '$sso$' FROM generate_series(1000, 1249) g").run();
        await d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) SELECT g, 'network', 'n' || g, 'usr_01JZ' || lpad(g::text, 22, '0') FROM generate_series(1000, 1249) g").run();
        inventory.forget(A);
        const before = state.calls.length;
        const profiles = await cosmetics.getCosmeticProfiles([70, 71, 999999, ...many]);
        const batched = state.calls.slice(before).filter((c) => c.path === '/api/v1/equipped');
        assert.deepStrictEqual(batched.map((c) => c.subjects), [100, 100, 51], 'Ana and 250 others, 100 per read');
        assert.strictEqual(state.calls.slice(before).filter((c) => /\/people\//.test(c.path)).length, 0, 'no per-person reads');
        assert.deepStrictEqual(profiles[70].nameFX, { itemId: 'fx_rainbow', cssClass: 'name-fx-rainbow' });
        assert.deepStrictEqual([profiles[71], profiles[999999], profiles[1000]], [{}, {}, {}]);
        const again = state.calls.length;
        await cosmetics.getCosmeticProfiles([70, ...many]);
        assert.strictEqual(state.calls.length, again, 'a second lookup within 30 s is all cache');

        // A Live account without a Network subject holds nothing, and cannot be given anything.
        assert.deepStrictEqual(await cosmetics.getUnlocked(71), []);
        assert.match((await cosmetics.unlockCosmetic(71, 'fx_ice')).error, /subject/);

        // Inventory down: reads show nothing (never a chat error); writes say so.
        state.down = true;
        inventory.forget(A);
        assert.deepStrictEqual(await cosmetics.getCosmeticProfile(70), {});
        assert.match((await cosmetics.equipCosmetic(70, 'px_sparkle')).error, /unavailable|own/i);
        inventory.reset();
        assert.deepStrictEqual(await cosmetics.getCosmeticProfiles([70]), { 70: {} }, 'down: an empty profile, not an error');
        state.down = false;
        process.stdout.write('cosmetics through OpenVibe.Inventory: all checks passed\n');
    } finally {
        server.close();
        await db.close?.();
    }
    process.exit(0);
})().catch((err) => { process.stderr.write(`${err.stack || err}\n`); process.exit(1); });
