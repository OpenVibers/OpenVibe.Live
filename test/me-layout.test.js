'use strict';
/**
 * The account picture-in-picture layout (Live's half of the Person's place ask).
 *
 *   GET   /api/me/layout   the record's data, or {} when there is none
 *   PATCH /api/me/layout   merge { pip: { "<slot>:<source>": place | null } }, answer the merged data
 *
 * Network is stubbed with an in-memory module store and the contracts registry is injected with the live.layout
 * manifest (the pinned one does not carry it until the release is pinned). Sign-in is stubbed with an x-test-user
 * header as agent-streams.test.js does; the subject comes from linked_accounts, as in production.
 *
 *   node test/me-layout.test.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};

const SID = {
    ann: 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1',
    bob: 'usr_01JAB2C3D4E5F6G7H8J9K0MNB2',
    cat: 'usr_01JAB2C3D4E5F6G7H8J9K0MNC3',
};
const USER = Object.fromEntries(Object.entries(SID).map(([name, subject], i) => [i + 1, { id: i + 1, username: name, subject }]));

const KEY_RE = /^[0-9]{1,12}:[0-9]{1,12}$/;
const MANIFEST = { namespace: 'live.layout', quotaBytes: 8192 };

/** The manifest's rules, as the pinned openvibe-contracts would apply them after the release. */
function validateLayout(data) {
    const errors = [];
    const bad = (path, message) => errors.push({ path, message });
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { valid: false, errors: [{ path: '/', message: 'must be an object' }] };
    for (const key of Object.keys(data)) if (key !== 'pip') bad('/', `unknown property ${key}`);
    if (!data.pip || typeof data.pip !== 'object' || Array.isArray(data.pip)) bad('/pip', 'must be an object');
    else {
        const entries = Object.entries(data.pip);
        if (entries.length > 60) bad('/pip', 'at most 60 places');
        for (const [key, value] of entries) {
            if (!KEY_RE.test(key)) { bad(`/pip/${key}`, 'key must be <slot>:<source>'); continue; }
            if (!value || typeof value !== 'object' || Array.isArray(value)) { bad(`/pip/${key}`, 'must be a place'); continue; }
            for (const field of Object.keys(value)) if (!['x', 'y', 'w', 'mode', 'tuck', 'muted', 'at'].includes(field)) bad(`/pip/${key}/${field}`, 'unknown field');
            for (const field of ['x', 'y', 'w']) {
                if (typeof value[field] !== 'number' || !(value[field] >= 0 && value[field] <= 1)) bad(`/pip/${key}/${field}`, 'must be a number 0..1');
            }
            if (!['dock', 'float'].includes(value.mode)) bad(`/pip/${key}/mode`, 'must be dock or float');
            if (![null, 'left', 'right'].includes(value.tuck)) bad(`/pip/${key}/tuck`, 'must be left, right or null');
            if (typeof value.muted !== 'boolean') bad(`/pip/${key}/muted`, 'must be a boolean');
            if (!Number.isInteger(value.at) || value.at < 0) bad(`/pip/${key}/at`, 'must be an integer millisecond');
            for (const field of ['x', 'y', 'w', 'mode', 'tuck', 'muted', 'at']) if (!(field in value)) bad(`/pip/${key}/${field}`, 'is required');
        }
    }
    return { valid: errors.length === 0, errors };
}

const layoutModules = {
    get: (ns) => (ns === 'live.layout' ? MANIFEST : undefined),
    validateData: (ns, data) => (ns === 'live.layout' ? validateLayout(data) : { valid: false, errors: [{ path: '/', message: 'unknown namespace' }] }),
};
const missingModules = { ...layoutModules, get: () => undefined };

/** Network's module store: one record per subject, revisions guarded as the real PUT does. */
function moduleStore() {
    const rows = new Map();
    const key = (ns, subject) => `${ns}|${subject}`;
    return {
        rows,
        async get(ns, subject) {
            const row = rows.get(key(ns, subject));
            return row ? { data: JSON.parse(JSON.stringify(row.data)), revision: row.revision } : null;
        },
        async put(ns, subject, data, { revision } = {}) {
            const row = rows.get(key(ns, subject));
            if ((row ? row.revision : 0) !== revision) {
                const err = new Error('revision conflict');
                err.status = 412;
                throw err;
            }
            const saved = { data: JSON.parse(JSON.stringify(data)), revision: (row ? row.revision : 0) + 1 };
            rows.set(key(ns, subject), saved);
            return { data: JSON.parse(JSON.stringify(saved.data)), revision: saved.revision };
        },
    };
}

const place = (at, extra = {}) => ({ x: 0.1, y: 0.2, w: 0.3, mode: 'dock', tuck: null, muted: true, at, ...extra });

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    for (const [id, user] of Object.entries(USER)) {
        await raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, is_owner) OVERRIDING SYSTEM VALUE
            VALUES (?, ?, ?, ?, 'x', 'user', 0)`).run(Number(id), user.username, user.username, `${user.username}@x`);
        await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, 'network', ?, ?)").run(Number(id), String(100 + Number(id)), user.subject);
    }

    const { createLayoutRouter } = require('../server/me/routes');
    const auth = (req, res, next) => {
        const user = USER[Number(req.get('x-test-user') || 0)];
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        req.user = user;
        next();
    };

    const store = moduleStore();
    const app = express();
    app.use(express.json());
    app.use('/api/me', createLayoutRouter({ modules: layoutModules, store, auth }));
    app.use('/api/missing', createLayoutRouter({ modules: missingModules, store, auth }));
    const server = await new Promise((ok) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => ok(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, { as = 1, body, headers = {} } = {}) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', ...(as ? { 'x-test-user': String(as) } : {}), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let data; try { data = JSON.parse(text); } catch { data = text; }
        return { status: res.status, data };
    };

    try {
        await check('GET with no record answers {}', async () => {
            const r = await call('GET', '/api/me/layout');
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(r.data, {});
        });

        await check('PATCH adds a place and answers the merged data', async () => {
            const r = await call('PATCH', '/api/me/layout', { body: { pip: { '12:34': place(100) } } });
            assert.strictEqual(r.status, 200, JSON.stringify(r.data));
            assert.deepStrictEqual(r.data.pip['12:34'], place(100));
            const got = await call('GET', '/api/me/layout');
            assert.deepStrictEqual(got.data.pip['12:34'], place(100), 'the place is in the account record');
        });

        await check('PATCH merges into the record and a newer at replaces the place', async () => {
            const r = await call('PATCH', '/api/me/layout', { body: { pip: { '12:34': place(200, { w: 0.5 }), '56:78': place(150, { mode: 'float' }) } } });
            assert.strictEqual(r.status, 200, JSON.stringify(r.data));
            assert.strictEqual(Object.keys(r.data.pip).length, 2);
            assert.deepStrictEqual(r.data.pip['12:34'], place(200, { w: 0.5 }));
            assert.deepStrictEqual(r.data.pip['56:78'], place(150, { mode: 'float' }));
        });

        await check('a null entry removes a place', async () => {
            const r = await call('PATCH', '/api/me/layout', { body: { pip: { '12:34': null } } });
            assert.strictEqual(r.status, 200, JSON.stringify(r.data));
            assert.deepStrictEqual(Object.keys(r.data.pip), ['56:78']);
            assert.strictEqual((await call('GET', '/api/me/layout')).data.pip['12:34'], undefined);
        });

        await check('over 60 places keeps the 60 newest by at', async () => {
            const pip = {};
            for (let i = 1; i <= 61; i++) pip[`1:${i}`] = place(i);
            const r = await call('PATCH', '/api/me/layout', { as: 2, body: { pip } });
            assert.strictEqual(r.status, 200, JSON.stringify(r.data));
            assert.strictEqual(Object.keys(r.data.pip).length, 60, 'trimmed to 60');
            assert.strictEqual(r.data.pip['1:1'], undefined, 'the oldest place went');
            assert.ok(r.data.pip['1:61'], 'the newest place stayed');
            assert.strictEqual((await call('GET', '/api/me/layout', { as: 2 })).data.pip['1:61'].at, 61);
        });

        await check('a place key that is not <slot>:<source> is a 400', async () => {
            for (const pip of [{ 'slot:source': place(1) }, { '1:2:3': place(1) }, { '1:2': { ...place(1), x: 1.5 } }, { '1:2': { ...place(1), extra: true } }]) {
                const r = await call('PATCH', '/api/me/layout', { body: { pip } });
                assert.strictEqual(r.status, 400, JSON.stringify(r.data));
            }
            const extra = await call('PATCH', '/api/me/layout', { body: { pip: {}, other: true } });
            assert.strictEqual(extra.status, 400);
        });

        await check('over the quota is a 413', async () => {
            const big = {};
            for (let i = 0; i < 60; i++) big[`${100000000000 + i}:${200000000000 + i}`] = place(123456789012345, { x: 0.123456789012345, y: 0.123456789012345, w: 0.123456789012345, mode: 'float', tuck: 'right', muted: false });
            const r = await call('PATCH', '/api/me/layout', { as: 3, body: { pip: big } });
            assert.strictEqual(r.status, 413, JSON.stringify(r.data));
        });

        await check('a signed-out request is a 401', async () => {
            assert.strictEqual((await call('GET', '/api/me/layout', { as: 0 })).status, 401);
            assert.strictEqual((await call('PATCH', '/api/me/layout', { as: 0, body: { pip: {} } })).status, 401);
        });

        await check('without the namespace the route answers 404 for both verbs', async () => {
            assert.strictEqual((await call('GET', '/api/missing/layout')).status, 404);
            assert.strictEqual((await call('PATCH', '/api/missing/layout', { body: { pip: {} } })).status, 404);
        });

        await check('a revision conflict reads again and applies the same patch', async () => {
            assert.strictEqual((await call('PATCH', '/api/me/layout', { as: 3, body: { pip: { '9:9': place(1) } } })).status, 200);
            const row = store.rows.get(`live.layout|${SID.cat}`);
            assert.ok(row, 'the subject has a record to race');
            // Give the next write a moved revision once: the PUT is refused, the retry re-reads and succeeds.
            const realPut = store.put;
            let conflicts = 0;
            store.put = async (...args) => {
                if (conflicts++ === 0) { row.revision += 1; const err = new Error('revision conflict'); err.status = 412; throw err; }
                return realPut(...args);
            };
            try {
                const r = await call('PATCH', '/api/me/layout', { as: 3, body: { pip: { '3:4': place(7) } } });
                assert.strictEqual(r.status, 200, JSON.stringify(r.data));
                assert.deepStrictEqual(r.data.pip['3:4'], place(7));
            } finally {
                store.put = realPut;
            }
        });
    } finally {
        server.close();
    }

    if (failures) { quiet(`me-layout: ${failures} failed`); process.exit(1); }
    quiet('me-layout: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
