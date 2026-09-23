'use strict';

// scripts/subscribe-media-events.js against a stub Network and Events (fetch is injected): Live's
// token for openvibe.events, one subscription per Media topic created with MEDIA_EVENTS_SECRET,
// existing ones reported (not duplicated), --dry-run, --disable/--enable for rollback, and no
// secret in anything it prints.

const assert = require('assert');
const { run, parseArgs, TOPICS, DEFAULT_ENDPOINT } = require('../scripts/subscribe-media-events');

const SECRET = 's'.repeat(64);
const CLIENT_SECRET = 'c'.repeat(48);
const ENV = { OV_OAUTH_CLIENT_ID: 'live', OV_OAUTH_CLIENT_SECRET: CLIENT_SECRET, OV_NETWORK_INTERNAL_URL: 'http://network.test', EVENTS_URL: 'http://events.test/', MEDIA_EVENTS_SECRET: SECRET };

function stub({ subscriptions = [], tokenStatus = 200 } = {}) {
    const calls = [];
    const subs = subscriptions.map((s) => ({ ...s }));
    const reply = (status, body) => ({ status, ok: status < 300, text: async () => JSON.stringify(body) });
    const fetchImpl = async (url, opts = {}) => {
        const method = opts.method || 'GET';
        calls.push({ method, url, body: opts.body || null });
        if (url === 'http://network.test/oauth/token') {
            const p = new URLSearchParams(opts.body);
            assert.strictEqual(p.get('grant_type'), 'client_credentials');
            assert.strictEqual(p.get('client_id'), 'live');
            assert.strictEqual(p.get('audience'), 'openvibe.events');
            return tokenStatus === 200 ? reply(200, { access_token: 'tok-live', token_type: 'Bearer', expires_in: 300 }) : reply(tokenStatus, { error: 'invalid_client' });
        }
        assert.strictEqual(opts.headers.Authorization, 'Bearer tok-live');
        if (url === 'http://events.test/api/v1/subscriptions' && method === 'GET') return reply(200, { subscriptions: subs });
        if (url === 'http://events.test/api/v1/subscriptions' && method === 'POST') {
            const b = JSON.parse(opts.body);
            const row = { id: `sub_${subs.length + 1}`, consumer: 'live', topic_pattern: b.topic_pattern, endpoint: b.endpoint, enabled: true };
            subs.push(row);
            return reply(201, { ...row, secret: b.secret });
        }
        const m = /^http:\/\/events\.test\/api\/v1\/subscriptions\/([^/]+)\/(enable|disable)$/.exec(url);
        if (m && method === 'POST') {
            const s = subs.find((x) => x.id === m[1]);
            s.enabled = m[2] === 'enable';
            return reply(200, s);
        }
        return reply(404, { code: 'not_found' });
    };
    return { fetchImpl, calls, subs };
}
const logs = () => { const lines = []; const log = (s) => lines.push(String(s)); log.lines = lines; return log; };
const noSecret = (lines) => { for (const l of lines) for (const s of [SECRET, CLIENT_SECRET, 'tok-live']) assert.ok(!l.includes(s), `printed a secret: ${l}`); };

(async () => {
    assert.deepStrictEqual(TOPICS, ['media.vod.*', 'media.clip.*', 'media.storage.*']);
    assert.strictEqual(DEFAULT_ENDPOINT, 'http://127.0.0.1:3000/internal/media-events');

    // Create: one per topic, Live's secret, the media-events endpoint; one already there is reported.
    let s = stub({ subscriptions: [{ id: 'sub_old', topic_pattern: 'media.clip.*', endpoint: DEFAULT_ENDPOINT, enabled: true },
        { id: 'sub_openre', topic_pattern: 'openre.session.*', endpoint: 'http://127.0.0.1:3000/internal/openre-events', enabled: true }] });
    let log = logs();
    let r = await run({ env: ENV, fetchImpl: s.fetchImpl, log });
    assert.deepStrictEqual(r.subscriptions.map(x => [x.topic, x.created]), [['media.vod.*', true], ['media.clip.*', false], ['media.storage.*', true]]);
    const posts = s.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/v1/subscriptions')).map(c => JSON.parse(c.body));
    assert.deepStrictEqual(posts, [
        { topic_pattern: 'media.vod.*', endpoint: DEFAULT_ENDPOINT, secret: SECRET },
        { topic_pattern: 'media.storage.*', endpoint: DEFAULT_ENDPOINT, secret: SECRET },
    ]);
    noSecret(log.lines);

    // Re-running changes nothing.
    const before = s.subs.length;
    r = await run({ env: ENV, fetchImpl: s.fetchImpl, log: logs() });
    assert.ok(r.subscriptions.every(x => x.existed));
    assert.strictEqual(s.subs.length, before);

    // --dry-run lists only.
    const s2 = stub();
    log = logs();
    r = await run({ action: 'list', env: ENV, fetchImpl: s2.fetchImpl, log });
    assert.ok(r.subscriptions.every(x => !x.existed));
    assert.ok(!s2.calls.some(c => c.method === 'POST' && !c.url.endsWith('/oauth/token')));
    assert.strictEqual(log.lines.filter(l => /would create/.test(l)).length, 3);

    // --disable / --enable (rollback and undo).
    r = await run({ action: 'disable', env: ENV, fetchImpl: s.fetchImpl, log: logs() });
    assert.ok(s.subs.filter(x => TOPICS.includes(x.topic_pattern)).every(x => x.enabled === false));
    assert.ok(s.subs.find(x => x.id === 'sub_openre').enabled, 'other subscriptions untouched');
    await run({ action: 'enable', env: ENV, fetchImpl: s.fetchImpl, log: logs() });
    assert.ok(s.subs.every(x => x.enabled));

    // Refusals: no secret, short secret, no client secret, Network refuses the token.
    await assert.rejects(run({ env: { ...ENV, MEDIA_EVENTS_SECRET: 'short' }, fetchImpl: stub().fetchImpl, log: logs() }), /MEDIA_EVENTS_SECRET must be set/);
    await assert.rejects(run({ env: { ...ENV, OV_OAUTH_CLIENT_SECRET: '' }, fetchImpl: stub().fetchImpl, log: logs() }), /OV_OAUTH_CLIENT_SECRET/);
    await assert.rejects(run({ env: ENV, fetchImpl: stub({ tokenStatus: 401 }).fetchImpl, log: logs() }), /Network refused a token/);

    assert.deepStrictEqual(parseArgs(['--dry-run', '--endpoint', 'http://x/internal/media-events']), { liveEnv: '/etc/openvibe/live.env', endpoint: 'http://x/internal/media-events', action: 'list' });
    assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
    console.log('subscribe-media-events: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
