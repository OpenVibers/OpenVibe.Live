'use strict';
/**
 * Stream keys never reach anyone but their owner (roadmap WS-R task 5, the stream-key class).
 *
 * Twice an ingest key went out to anonymous callers (the public channel endpoint's
 * managed_streams[].stream_key, then the stream detail's managed_stream_key; see
 * public-serializers.test.js and security-redaction.test.js), enough to publish to someone's slot
 * over RTMP or WHIP. Those tests pin the endpoints that leaked. This one covers the class: it seeds
 * a streamer whose every credential is a sentinel (account key, a Live slot key, an OpenRe slot's
 * rotated Live key, a restream key and SRT passphrase, RobotStreamer / platform / PowerChat tokens,
 * AI keys, control key and API token hashes, a camera password hash), boots the real server as a
 * restore-drill instance (test/security-crawl.js), and requests EVERY GET route Express knows,
 * plus the SPA pages, as five other people: anonymous, a viewer, another streamer, a global mod and
 * an admin. No response body or header, and no log line written while serving them, may contain
 * any sentinel. Then the owner's own key endpoints must show them (so the sentinels are live and a
 * crawl that found nothing means something), and the payloads Live sends out about a stream (the
 * live.stream.started/ended events, the search document, the go-live SSE and the Network go-live
 * call) must not carry them either.
 *
 *   node test/security-stream-keys.test.js
 */
const assert = require('assert');
const crawl = require('./security-crawl');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.log(`  ✗ ${name}\n    ${String(err.stack || err.message).split('\n').slice(0, 12).join('\n    ')}`); }
}

// Every credential the owner has. Low-entropy, obviously fake; hex where Live expects hex keys.
const K = {
    account: 'a1'.repeat(16),
    slotMain: 'b2'.repeat(20),
    slotOpenre: 'c3'.repeat(20),
    restreamKey: 'restream-sentinel-key-e5e5e5e5',
    srtPassphrase: 'srt-sentinel-passphrase-e6e6',
    rsToken: 'robotstreamer-sentinel-token-f6f6',
    platformAccess: 'platform-sentinel-access-a7a7',
    platformRefresh: 'platform-sentinel-refresh-b8b8',
    powerchatAccess: 'powerchat-sentinel-access-c8c8',
    powerchatRefresh: 'powerchat-sentinel-refresh-d8d8',
    aiBotToken: 'aibot-sentinel-token-c9c9',
    byoKey: 'sentinel-not-a-secret-byo',
    controlKeyHash: 'e1'.repeat(32),
    apiTokenHash: 'f2'.repeat(32),
    cameraPasswordHash: 'camera-sentinel-hash-a3a3',
    // The other people's own account keys: none of them may see another's, and the crawl must not
    // echo a caller's own key on a page about someone else either.
    fan: 'd4'.repeat(16),
    peer: 'e5'.repeat(16),
    mod: 'f6'.repeat(16),
    admin: 'a7'.repeat(16),
};

const SEED = `
    const db = require('./server/db/database');
    db.initDb();
    const K = JSON.parse(process.env.SENTINELS);
    const mk = (u, role, key) => {
        const id = db.createUser({ username: u, password_hash: 'x', display_name: u, email: u + '@example.test', stream_key: key }).lastInsertRowid;
        db.run('UPDATE users SET role = ? WHERE id = ?', [role, id]);
        db.ensureChannel(id);
        db.getDb().prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, service_username) VALUES (?, 'network', ?, ?)").run(id, String(9000 + Number(id)), u);
        return Number(id);
    };
    const owner = mk('keyowner', 'streamer', K.account);
    const fan = mk('keyfan', 'user', K.fan);
    const peer = mk('keypeer', 'streamer', K.peer);
    const mod = mk('keymod', 'global_mod', K.mod);
    const admin = mk('keyadmin', 'admin', K.admin);
    const ch = db.getChannelByUserId(owner);
    const slot = Number(db.createManagedStream({ user_id: owner, channel_id: ch.id, slug: 'main', title: 'Main slot', protocol: 'rtmp', stream_key: K.slotMain }).lastInsertRowid);
    const slot2 = Number(db.createManagedStream({ user_id: owner, channel_id: ch.id, slug: 'relay', title: 'OpenRe slot', protocol: 'rtmp', stream_key: K.slotOpenre }).lastInsertRowid);
    const cols = db.all('PRAGMA table_info(managed_streams)').map((c) => c.name);
    if (cols.includes('ingest_authority')) db.run("UPDATE managed_streams SET ingest_authority = 'openre', openre_stream_id = 'std_sentinel' WHERE id = ?", [slot2]);
    const live = Number(db.createStream({ user_id: owner, channel_id: ch.id, managed_stream_id: slot, title: 'Live now', protocol: 'rtmp' }).lastInsertRowid);
    const ended = Number(db.createStream({ user_id: owner, channel_id: ch.id, managed_stream_id: slot2, title: 'Earlier', protocol: 'rtmp' }).lastInsertRowid);
    db.endStream(ended);
    db.run("UPDATE streams SET last_heartbeat = datetime('now'), viewer_count = 3 WHERE id = ?", [live]);
    db.createRestreamDestination(owner, { platform: 'custom', name: 'Mirror', server_url: 'srt://ingest.example.test:9000', stream_key: K.restreamKey, srt_passphrase: K.srtPassphrase, managed_stream_id: slot });
    const ins = (sql, args) => db.getDb().prepare(sql).run(...args);
    ins('INSERT INTO robotstreamer_integrations (user_id, enabled, token, robot_id, owner_id, stream_name, owner_name) VALUES (?, 1, ?, ?, ?, ?, ?)', [owner, K.rsToken, 'r1', 'o1', 'keyowner', 'keyowner']);
    ins("INSERT INTO platform_connections (user_id, platform, platform_user_id, platform_username, access_token, refresh_token) VALUES (?, 'twitch', 't1', 'keyowner', ?, ?)", [owner, K.platformAccess, K.platformRefresh]);
    ins('INSERT INTO powerchat_connections (user_id, powerchat_username, powerchat_user_id, access_token, refresh_token) VALUES (?, ?, ?, ?, ?)', [owner, 'keyowner', 'p1', K.powerchatAccess, K.powerchatRefresh]);
    ins('INSERT INTO ai_chatbot_configs (user_id, enabled, api_token) VALUES (?, 1, ?)', [owner, K.aiBotToken]);
    ins('INSERT INTO channel_ai_config (user_id, enabled, use_shared_key, byo_key) VALUES (?, 1, 0, ?)', [owner, K.byoKey]);
    ins('INSERT INTO api_keys (user_id, key_hash, label) VALUES (?, ?, ?)', [owner, K.controlKeyHash, 'Robot']);
    ins('INSERT INTO api_tokens (user_id, token_hash, label, scopes) VALUES (?, ?, ?, ?)', [owner, K.apiTokenHash, 'Bot', '["chat","read"]']);
    const cam = Number(ins('INSERT INTO camera_profiles (user_id, stream_id, name, onvif_url, username, password_hash) VALUES (?, ?, ?, ?, ?, ?)', [owner, live, 'Desk cam', 'http://camera.example.test', 'admin', K.cameraPasswordHash]).lastInsertRowid);
    db.run('INSERT INTO follows (follower_id, streamer_id) VALUES (?, ?)', [fan, owner]);
    db.run("INSERT INTO chat_messages (stream_id, user_id, username, message) VALUES (?, ?, 'keyfan', 'hello')", [live, fan]);

    // What Live sends out about the stream, built from these rows the way production builds it.
    (async () => {
        const out = {};
        const ev = require('./server/events/stream-events');
        out.started = ev.envelopeFor('started', live);
        out.ended = ev.envelopeFor('ended', ended);
        try { out.searchDocument = require('./server/events/search-documents').documentFor(owner); } catch (e) { out.searchDocumentError = e.message; }
        const raw = db.get('SELECT s.*, ms.stream_key AS managed_stream_key, ms.slug AS managed_stream_slug FROM streams s LEFT JOIN managed_streams ms ON ms.id = s.managed_stream_id WHERE s.id = ?', [live]);
        const streamer = db.getUserById(owner);
        const writes = [];
        const le = require('./server/streaming/live-events');
        le.subscribe({ on() {} }, { writeHead() {}, write(s) { writes.push(String(s)); } });
        le.announceGoLive(raw, streamer);
        out.sse = writes.join('');
        const posted = [];
        global.fetch = async (url, opts = {}) => { posted.push(String(opts.body || '')); return { ok: true, status: 200, json: async () => ({}) }; };
        require('./server/streaming/golive-notify').notifyFollowersGoLive(streamer, raw, { force: true });
        await new Promise((r) => setTimeout(r, 300));
        out.goLive = posted;
        out.rawHadKey = raw.managed_stream_key === K.slotMain && streamer.stream_key === K.account;
        db.close();
        console.log(JSON.stringify({ ids: { owner, fan, peer, mod, admin, channel: ch.id, slot, slot2, live, ended, cam }, out }));
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
`;

function hits(text, needles) {
    return Object.entries(needles).filter(([, v]) => v && String(text).includes(v)).map(([k]) => k);
}

(async () => {
    const tmp = crawl.tempEnv('stream-keys');
    const seeded = crawl.seed(tmp, SEED, { SENTINELS: JSON.stringify(K), INTERNAL_API_KEY: 'internal-sentinel-for-golive', OV_NETWORK_INTERNAL_URL: 'http://127.0.0.1:9' });
    assert.ok(seeded && seeded.ids, 'seed printed its ids');
    const { ids, out } = seeded;

    console.log('stream keys: what Live sends out about a stream');
    await check('the seeded rows really carry the keys (raw stream row and user row)', () => {
        assert.strictEqual(out.rawHadKey, true);
    });
    await check('live.stream.started / live.stream.ended envelopes carry no credential', () => {
        assert.ok(out.started && out.ended, 'both envelopes built');
        assert.deepStrictEqual(hits(JSON.stringify([out.started, out.ended]), K), []);
    });
    await check('the channel\'s search document carries no credential', () => {
        assert.ok(out.searchDocument || out.searchDocumentError === undefined, out.searchDocumentError);
        assert.deepStrictEqual(hits(JSON.stringify(out.searchDocument || {}), K), []);
    });
    await check('the go-live SSE event (every open page hears it) carries no credential, even from a raw row with the key', () => {
        assert.match(out.sse, /stream-live/);
        assert.deepStrictEqual(hits(out.sse, K), []);
    });
    await check('the go-live call to Network carries no credential', () => {
        assert.ok(out.goLive.length >= 1, 'Network was called');
        assert.deepStrictEqual(hits(out.goLive.join('\n'), K), []);
    });

    // ── The booted server ──
    const keys = crawl.networkKeys(tmp);
    const srv = await crawl.boot(tmp, { ...keys.env, NODE_ENV: 'production' });
    const token = (id, username, role) => keys.sign({ sub: String(9000 + id), id: 9000 + id, username, role });
    const owner = { Authorization: `Bearer ${token(ids.owner, 'keyowner', 'streamer')}` };
    const people = {
        anonymous: {},
        viewer: { Authorization: `Bearer ${token(ids.fan, 'keyfan', 'user')}` },
        'another streamer': { Authorization: `Bearer ${token(ids.peer, 'keypeer', 'streamer')}` },
        'global mod': { Authorization: `Bearer ${token(ids.mod, 'keymod', 'global_mod')}` },
        admin: { Authorization: `Bearer ${token(ids.admin, 'keyadmin', 'admin')}` },
    };

    console.log('stream keys: the owner sees their own keys (the sentinels are live)');
    await check('GET /api/auth/stream-key shows the owner their account key', async () => {
        const r = await srv.request('GET', '/api/auth/stream-key', { headers: owner });
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.ok(r.text.includes(K.account), 'account key shown to its owner');
    });
    await check('GET /api/streams/managed shows the owner their slot key', async () => {
        const r = await srv.request('GET', '/api/streams/managed', { headers: owner });
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.ok(r.text.includes(K.slotMain), 'slot key shown to its owner');
    });
    await check('each person is signed in as themselves (their own account key comes back to them)', async () => {
        for (const [who, headers] of Object.entries(people)) {
            if (who === 'anonymous') continue;
            const r = await srv.request('GET', '/api/auth/stream-key', { headers });
            assert.strictEqual(r.status, 200, `${who}: ${r.text.slice(0, 200)}`);
        }
    });

    // Parameter values: every seeded id and name, so each route is asked about the owner's things.
    const numeric = [ids.live, ids.slot, ids.owner, ids.channel, ids.ended, ids.slot2, ids.cam, 1];
    const byName = {
        username: ['keyowner'], user: ['keyowner'], userId: [ids.owner], channelId: [ids.channel],
        streamId: [ids.live, ids.ended], managedStreamId: [ids.slot, ids.slot2], slotIdOrSlug: ['main', ids.slot, 'relay'],
        ref: ['main', ids.slot, 'relay'], platform: ['twitch', 'youtube', 'kick', 'custom'], anonId: ['anon1'], num: [1],
        file: ['x.mp3'], filename: ['x.png'], slug: ['keyowner'], stat: ['wins'], type: ['vod', 'clip', 'stream'],
        namespace: ['live.site_settings'], kind: ['user'], idOrSlug: ['default'], metric: ['viewers'], name: ['whip'],
        ip: ['127.0.0.1'], commentId: [1],
    };
    const values = (n) => byName[n] || numeric;
    const paths = crawl.getPaths(srv, values, {
        query: `q=keyowner&username=keyowner&user_id=${ids.owner}&stream_id=${ids.live}&managed_stream_id=${ids.slot}`,
        // The pages (SPA fallback + server-rendered SEO), which the route list shows only as '*'.
        extra: ['/', '/@keyowner', '/@keyowner/main', '/@keyowner/relay', `/stream/${ids.live}`, `/recap/${ids.live}`, '/dashboard',
            '/broadcast', '/broadcast/main', '/search?q=keyowner', '/content', '/moments', '/sitemap.xml', '/llms.txt', '/robots.txt',
            `/overlay/chat/keyowner/${ids.slot}`, '/obs/chat/keyowner', `/popout/${ids.live}`, '/kiosk'],
    });

    console.log(`stream keys: ${paths.length} GET paths from ${srv.routes.length} routes, as ${Object.keys(people).length} people who are not the owner`);
    const own = { viewer: 'fan', 'another streamer': 'peer', 'global mod': 'mod', admin: 'admin' };
    const logs = crawl.captureLogs();
    let result;
    try {
        // Everyone else's own key is a secret to each person too, except their own.
        result = await crawl.crawlAll(srv, paths, people, (who) => Object.fromEntries(Object.entries(K).filter(([k]) => k !== own[who])));
    } finally { logs.stop(); }
    const { found, answered } = result;
    console.log(`  (answers: ${JSON.stringify(result.statuses)}; held open past the timeout: ${result.timedOut.join(', ') || 'none'})`);

    await check('the crawl reached the server (most requests answered)', () => {
        assert.ok(answered > paths.length * 4, `${answered} answers for ${paths.length * 5} requests`);
    });
    await check('no GET route or page shows the owner\'s credentials (or anyone else\'s) to anonymous, a viewer, another streamer, a mod or an admin', () => {
        assert.deepStrictEqual(found, []);
    });
    await check('no log line written while serving those requests contains a credential', () => {
        const bad = logs.lines.filter((l) => hits(l, K).length).map((l) => `${hits(l, K).join(',')}: ${l.slice(0, 200)}`);
        assert.deepStrictEqual(bad, []);
    });

    tmp.cleanup();
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\nsecurity-stream-keys: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
