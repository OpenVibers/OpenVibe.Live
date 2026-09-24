/**
 * Vibe-coding publication needs the narrow `vibe_coding_publish` scope.
 *
 * /ws/vibe-coding/publish and the /api/vibe-coding writes used to accept the broad `stream` scope
 * too, so any stream-control token (live state, restreams, VODs, clips) could publish a coding feed.
 * Now an hbt_ token with `stream` alone is closed with 4403 / refused, and a token with
 * `vibe_coding_publish` (the "GitHub Copilot Companion" preset) keeps working. Session sign-in is
 * unaffected. (Moving publication to Network project credentials in OpenVibe.Codes is later work.)
 *
 *   node test/vibe-coding-scope.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-vibe-scope-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

const db = require('../server/db/database');
db.initDb();
db.getDb().prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role) VALUES (7, 'coder', 'coder', 'c@x', 'x', 'streamer')`).run();
const slot = Number(db.createManagedStream({ user_id: 7, slug: 'camp-code', title: 'code', stream_key: 'key-code' }).lastInsertRowid);
const narrow = db.createApiToken(7, 'Copilot Companion', ['read', 'vibe_coding_publish']).token;
const broad = db.createApiToken(7, 'Stream Controller', ['read', 'stream', 'control']).token;

const auth = require('../server/auth/auth');
const WebSocket = require('ws');
const VibeCodingPublishServer = require('../server/vibe-coding/publish-server');

/** Connect and return how the socket ended up: { code } when closed, or { ready } on vibe-coding.ready. */
function connect(port, token) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/vibe-coding/publish?token=${token}&managedStreamId=${slot}&slotSlug=camp-code`);
        ws.on('message', (data) => {
            const msg = JSON.parse(String(data));
            if (msg.type === 'vibe-coding.ready') { ws.close(); resolve({ ready: true }); }
        });
        ws.on('close', (code) => resolve({ code }));
        ws.on('error', () => {});
    });
}

(async () => {
    // Scope check itself.
    const { hasVibeCodingPublishScope } = VibeCodingPublishServer;
    assert.strictEqual(hasVibeCodingPublishScope({ scopes: ['vibe_coding_publish'] }), true);
    assert.strictEqual(hasVibeCodingPublishScope({ scopes: ['read', 'stream', 'control'] }), false, 'the broad stream scope is not a publisher scope');

    // The real WebSocket endpoint with real hbt_ tokens.
    const pub = new VibeCodingPublishServer({ broadcastToStream() {} }, db);
    const server = http.createServer();
    pub.init(server);
    server.on('upgrade', (req, socket, head) => { if (!pub.handleUpgrade(req, socket, head)) socket.destroy(); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    assert.deepStrictEqual(await connect(port, broad), { code: 4403 }, 'a stream-scoped token is closed with 4403');
    assert.deepStrictEqual(await connect(port, narrow), { ready: true }, 'a vibe_coding_publish token still publishes');
    assert.deepStrictEqual(await connect(port, 'hbt_' + '0'.repeat(64)), { code: 4401 }, 'an unknown token is refused');
    server.close();

    // REST: the /api/vibe-coding writes take only the narrow scope.
    const t = (method, url, scopes) => auth.apiTokenAllows({ method, originalUrl: url }, scopes);
    assert.strictEqual(t('PUT', `/api/vibe-coding/managed/${slot}/settings`, ['read', 'stream', 'control']), false, 'stream no longer writes vibe-coding settings');
    assert.strictEqual(t('PUT', `/api/vibe-coding/managed/${slot}/settings`, ['read', 'vibe_coding_publish']), true);
    assert.strictEqual(t('GET', `/api/vibe-coding/managed/${slot}/events`, ['read']), true, 'reads are unchanged');
    assert.strictEqual(t('POST', '/api/streams/managed', ['stream']), true, 'the stream scope still covers stream control');

    fs.rmSync(tmp, { recursive: true, force: true });
    quiet('vibe-coding-scope: ok');
    process.exit(0);
})().catch((err) => {
    quiet(err);
    process.exit(1);
});
