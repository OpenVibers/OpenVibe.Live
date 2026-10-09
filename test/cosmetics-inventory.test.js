'use strict';

// ADR-054 §8: with INVENTORY_AUTHORITY=inventory, Live's cosmetics live in OpenVibe.Inventory. A stand-in Inventory and
// Network check that Live reads a person's items and slots there (by their Network subject, with Live's own token and
// X-OV-Subject), grants, equips, unequips and revokes there, never touches its own user_cosmetics / user_equipped, shows
// nothing (rather than an error) when Inventory is down, and refuses writes with a clear message. Unset, Live keeps
// its own tables.

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
    const ownRows = async () => Number((await d.prepare('SELECT count(*) AS n FROM user_cosmetics').get()).n) + Number((await d.prepare('SELECT count(*) AS n FROM user_equipped').get()).n);

    try {
        // Unset: Live's own tables.
        delete process.env.INVENTORY_AUTHORITY;
        assert.strictEqual(cosmetics.authority(), 'live');
        assert.deepStrictEqual(await cosmetics.unlockCosmetic(70, 'fx_fire'), { success: true, item: cosmetics.COSMETICS.fx_fire });
        assert.strictEqual(await ownRows(), 1, 'live keeps its own row');
        await d.prepare('DELETE FROM user_cosmetics').run();
        assert.strictEqual(state.calls.length, 0, 'nothing went to Inventory');

        process.env.INVENTORY_AUTHORITY = 'inventory';
        assert.strictEqual(cosmetics.authority(), 'inventory');

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

        // Live's own tables are not written in this mode.
        assert.strictEqual(await ownRows(), 0, 'no row in user_cosmetics or user_equipped');

        // A Live account without a Network subject holds nothing, and cannot be given anything.
        assert.deepStrictEqual(await cosmetics.getUnlocked(71), []);
        assert.match((await cosmetics.unlockCosmetic(71, 'fx_ice')).error, /subject/);

        // Inventory down: reads show nothing (never a chat error); writes say so.
        state.down = true;
        inventory.forget(A);
        assert.deepStrictEqual(await cosmetics.getCosmeticProfile(70), {});
        assert.match((await cosmetics.equipCosmetic(70, 'px_sparkle')).error, /unavailable|own/i);
        state.down = false;

        // An unknown value falls back to live.
        process.env.INVENTORY_AUTHORITY = 'nonsense';
        assert.strictEqual(cosmetics.authority(), 'live');
        process.stdout.write('cosmetics through OpenVibe.Inventory: all checks passed\n');
    } finally {
        server.close();
        await db.close?.();
    }
    process.exit(0);
})().catch((err) => { process.stderr.write(`${err.stack || err}\n`); process.exit(1); });
