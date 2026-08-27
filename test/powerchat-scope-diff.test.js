// Scope-diff diagnostic (GET /me): pure diff + fetchMe envelope handling + the
// apiRequest 429 path end to end with a mocked fetch. No DB, no network.
const assert = require('assert');
const path = require('path');

function stub(modPath, exportsObj) {
    const full = require.resolve(modPath);
    require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}
const settings = { powerchat_enabled: 'true', powerchat_base_url: 'https://pc.example', powerchat_client_id: 'pca_x', powerchat_client_secret: 'sec',
    powerchat_scopes: 'profile:read webhooks:events checkout:attribute chat:write chat:read' };
const conn = { user_id: 5, powerchat_username: 'goosely', access_token: 'tok', refresh_token: 'ref', token_expires_at: Date.now() + 3600e3, scope: 'profile:read webhooks:events' };
stub(path.join(__dirname, '../server/db/database'), {
    getSetting: (k) => settings[k] ?? null,
    getPowerchatConnection: (id) => (id === 5 ? conn : null),
    updatePowerchatTokens: () => {}, setPowerchatConnectionError: () => {},
});
stub(path.join(__dirname, '../server/config'), { baseUrl: 'https://openvibe.live' });

const oauth = require('../server/integrations/powerchat-oauth');

(async () => {
    // ── scopeDiff ──────────────────────────────────────────────────
    let d = oauth.scopeDiff('profile:read webhooks:events', 'profile:read webhooks:events checkout:attribute chat:write');
    assert.deepStrictEqual(d.missing, ['checkout:attribute', 'chat:write']);
    assert.deepStrictEqual(d.extra, []);
    d = oauth.scopeDiff(['chat:write', 'legacy:thing', 'chat:write'], 'chat:write');
    assert.deepStrictEqual(d, { granted: ['chat:write', 'legacy:thing'], wanted: ['chat:write'], missing: [], extra: ['legacy:thing'] });
    d = oauth.scopeDiff('  a:b,c:d  ', 'c:d\na:b');
    assert.deepStrictEqual(d.missing, [], 'comma/whitespace/newline delimiters all normalize');
    d = oauth.scopeDiff(null, 'x:y');
    assert.deepStrictEqual(d, { granted: [], wanted: ['x:y'], missing: ['x:y'], extra: [] });
    d = oauth.scopeDiff('x:y', '');
    assert.deepStrictEqual(d.missing, []);

    // ── fetchMe: hits /api/dev/v1/me (not /streamers/…), unwraps { data } ──
    const calls = [];
    const responses = [];
    global.fetch = async (url, init) => {
        calls.push({ url: String(url), auth: init.headers.Authorization });
        const r = responses.shift() || { status: 200, body: {} };
        return { ok: r.status < 400, status: r.status, headers: { get: (h) => (r.headers || {})[h.toLowerCase()] ?? null }, json: async () => r.body };
    };
    responses.push({ status: 200, body: { data: { id: 42, username: 'goosely', displayName: 'Goosely', tipPageUrl: 'https://pc.example/goosely/tip', appId: 'app_1', scopes: ['profile:read', 'webhooks:events', 'chat:write'] } } });
    let me = await oauth.fetchMe(5);
    assert.strictEqual(calls[0].url, 'https://pc.example/api/dev/v1/me');
    assert.strictEqual(calls[0].auth, 'Bearer tok');
    assert.deepStrictEqual(me, { id: '42', username: 'goosely', displayName: 'Goosely', tipPageUrl: 'https://pc.example/goosely/tip', appId: 'app_1', scopes: ['profile:read', 'webhooks:events', 'chat:write'] });
    const diff = oauth.scopeDiff(me.scopes, settings.powerchat_scopes);
    assert.deepStrictEqual(diff.missing, ['checkout:attribute', 'chat:read'], 'live grant vs wanted list surfaces exactly the un-requested scopes');

    // Older / bare envelope and a space-delimited scope string are tolerated.
    responses.push({ status: 200, body: { id: 'u1', username: 'x', scopes: 'a:b c:d' } });
    me = await oauth.fetchMe(5);
    assert.deepStrictEqual(me.scopes, ['a:b', 'c:d']);
    assert.strictEqual(me.appId, null);

    // ── apiRequest honours Retry-After on a 429, then succeeds ──
    calls.length = 0;
    responses.push({ status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Too many requests', code: 'RATE_LIMITED' } } });
    responses.push({ status: 200, body: { data: { ok: true } } });
    const out = await oauth.apiRequest(5, { method: 'GET', path: '/profile' });
    assert.deepStrictEqual(out, { data: { ok: true } });
    assert.strictEqual(calls.length, 2, 'one retry after the 429');
    assert.strictEqual(calls[0].url, 'https://pc.example/api/dev/v1/streamers/goosely/profile');

    // A 403 is terminal: one call, error carries status + code.
    calls.length = 0;
    responses.push({ status: 403, body: { error: { message: 'missing scope chat:read', code: 'FORBIDDEN' } } });
    await assert.rejects(oauth.apiRequest(5, { method: 'GET', path: '/chat/history' }), (e) => e.status === 403 && e.code === 'FORBIDDEN' && /chat:read/.test(e.message));
    assert.strictEqual(calls.length, 1);

    // retry:false → a 429 surfaces immediately (callers that must not block).
    calls.length = 0;
    responses.push({ status: 429, headers: { 'retry-after': '0' }, body: {} });
    await assert.rejects(oauth.apiRequest(5, { method: 'POST', path: '/chat', body: { a: 1 }, retry: false }), (e) => e.status === 429);
    assert.strictEqual(calls.length, 1);

    console.log('✅ powerchat scope-diff / me tests passed');
})().catch((e) => { console.error('❌', e); process.exit(1); });
