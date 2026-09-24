/**
 * Anonymous Go Live: a guest on /broadcast gets a sign-in gate and nothing is created.
 *
 * The page used to render the slot workspace for a guest: its requests answered 401, the 401 was
 * swallowed, and the empty state offered "Create stream slot". Now loadBroadcastPage() shows the
 * gate and returns before any request; the create-slot entry point refuses a guest; and the
 * server still answers 401 to a slot creation without a session and writes nothing.
 *
 *   node test/broadcast-signin-gate.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/** The source of a top-level function declaration, braces matched. */
function extract(src, name) {
    const m = new RegExp(`(?:async )?function ${name}\\(`).exec(src);
    assert.ok(m, `${name}() must exist`);
    let i = src.indexOf('{', m.index);
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}

/** Minimal DOM: the elements the gate touches, plus a recorder for everything else. */
function fakeDom() {
    const classes = new Set();
    const els = {
        'bc-signin-gate': { hidden: true },
        'bc-stream-manager': {
            style: {},
            classList: {
                toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
                contains: (c) => classes.has(c),
            },
        },
    };
    return { els, document: { getElementById: (id) => els[id] || null, querySelector: () => null } };
}

/**
 * Runs the page's own functions with every free identifier they touch recorded: a guest must
 * reach nothing but the gate and showStreamManager().
 */
function load(files, names, fixtures) {
    const calls = [];
    const scope = new Proxy({}, {
        has: (t, k) => typeof k === 'string',
        get: (t, k) => {
            if (k === Symbol.unscopables) return undefined;
            if (Object.prototype.hasOwnProperty.call(fixtures, k)) return fixtures[k];
            if (k in globalThis) return globalThis[k];
            return (...args) => { calls.push(k); return Promise.resolve(null); };
        },
        set: (t, k, v) => { fixtures[k] = v; return true; },
    });
    const src = names.map(([file, name]) => extract(files[file], name)).join('\n');
    // eslint-disable-next-line no-new-func
    const fns = new Function('scope', `with (scope) { ${src}\n return { ${names.map(([, n]) => n).join(', ')} }; }`)(scope);
    return { fns, calls };
}

const files = { bc: read('public/js/broadcast.js'), ws: read('public/js/broadcast-workspace.js') };
const NAMES = [['bc', '_broadcastSignInGate'], ['bc', 'loadBroadcastPage'], ['ws', 'showCreateManagedStreamModal']];

(async () => {
    // ── A guest: the gate, and nothing else ──────────────────────────────────────────
    {
        const dom = fakeDom();
        const { fns, calls } = load(files, NAMES, { currentUser: null, document: dom.document, broadcastState: { streams: new Map() } });
        await fns.loadBroadcastPage();
        assert.strictEqual(dom.els['bc-signin-gate'].hidden, false, 'the sign-in gate is shown');
        assert.ok(dom.els['bc-stream-manager'].classList.contains('bc-guest'), 'the workspace is hidden behind it');
        assert.deepStrictEqual(calls, ['showStreamManager'], `a guest triggers no request and no loader (got ${calls.join(', ')})`);

        calls.length = 0;
        fns.showCreateManagedStreamModal();
        assert.ok(!calls.includes('showModal'), 'a guest cannot open the create-slot form');
        assert.strictEqual(dom.els['bc-signin-gate'].hidden, false);
    }

    // ── Signed in: no gate, the workspace loads ──────────────────────────────────────
    {
        const dom = fakeDom();
        dom.els['bc-signin-gate'].hidden = false;
        const { fns, calls } = load(files, NAMES, { currentUser: { id: 1, username: 'alex' }, document: dom.document, broadcastState: { streams: new Map(), activeStreamId: null } });
        await fns.loadBroadcastPage();
        assert.strictEqual(dom.els['bc-signin-gate'].hidden, true, 'no gate for a signed-in user');
        assert.ok(!dom.els['bc-stream-manager'].classList.contains('bc-guest'));
        for (const fn of ['loadBroadcastSettings', 'initBroadcastWorkspace', 'loadRestreamDestinations']) {
            assert.ok(calls.includes(fn), `a signed-in user loads ${fn}()`);
        }
        calls.length = 0;
        fns.showCreateManagedStreamModal();
        assert.deepStrictEqual(calls, ['showModal'], 'a signed-in user gets the create-slot form');
    }

    // ── The markup and styles exist ──────────────────────────────────────────────────
    const fragment = read('public/fragments/broadcast.html');
    const gate = /<div class="bc-signin-gate" id="bc-signin-gate" hidden>([\s\S]*?)<\/div>/.exec(fragment);
    assert.ok(gate, 'the broadcast fragment carries the gate, hidden until the script decides');
    assert.ok(gate[1].includes('href="/api/auth/sso/login?next=%2Fbroadcast"'), 'the gate signs in and comes back to /broadcast');
    assert.ok(!/free|\$0/i.test(gate[1]), 'no "free" copy');
    assert.ok(fragment.indexOf('id="bc-signin-gate"') < fragment.indexOf('id="bc-workspace"'), 'the gate sits above the workspace');
    const css = read('public/css/features/broadcast.css');
    assert.ok(/#bc-stream-manager\.bc-guest > :not\(h2\):not\(\.bc-signin-gate\)\s*\{\s*display:\s*none/.test(css), 'the guest class hides the workspace');

    // ── The server creates nothing for a guest ──────────────────────────────────────
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-bc-gate-'));
    process.env.DB_PATH = path.join(tmp, 'live.db');
    process.env.NODE_ENV = 'test';
    const quiet = console.log;
    console.log = () => {};
    console.warn = () => {};
    const db = require('../server/db/database');
    db.initDb();
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/streams', require('../server/streaming/routes'));
    const server = http.createServer(app).listen(0);
    const post = (p, body) => new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({ port: server.address().port, path: p, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end(data);
    });
    const before = db.getDb().prepare('SELECT COUNT(*) AS n FROM managed_streams').get().n;
    assert.strictEqual(await post('/api/streams/managed', { title: 'guest slot' }), 401, 'creating a slot without a session is refused');
    assert.strictEqual(await post('/api/streams', { title: 'guest stream' }), 401, 'starting a stream without a session is refused');
    assert.strictEqual(db.getDb().prepare('SELECT COUNT(*) AS n FROM managed_streams').get().n, before, 'and nothing was created');
    assert.strictEqual(db.getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n, 0, 'no identity was created either');
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    quiet('broadcast-signin-gate: ok');
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
