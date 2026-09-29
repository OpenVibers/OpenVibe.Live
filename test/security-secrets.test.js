'use strict';
/**
 * Live's own secrets never leave in a response (roadmap WS-R task 5, the internal-secret class).
 *
 * Boots the real server as a restore-drill instance (test/security-crawl.js) with a sentinel value in
 * every secret environment variable Live reads (the Network OAuth client secret, the internal API
 * keys, Media's webhook/event secrets, the Events and OpenRe subscription secrets, TURN,
 * PayPal, the admin password, GitHub tokens, the ops webhook) and in every secret site setting an
 * owner can store (GIF, TTS, AI, Twitch/Kick/YouTube, soundboard keys, the Discord and ops
 * webhooks), then requests every GET route Express knows, the pages, the probes (/api/ready,
 * /api/health, /metrics, /release.json) and the error paths (nonsense ids, unknown paths, refused
 * writes with broken bodies) as anonymous, a viewer, a streamer, a global mod, an admin and the
 * site owner. No body or header may contain an environment secret, whoever asks; the stored
 * settings are shown to the site owner only (the settings page is where they are edited), never
 * to an admin who is not the owner. The events Live sends (stream lifecycle, release) and the log
 * lines written while serving all of that may not contain them either.
 *
 *   node test/security-secrets.test.js
 */
const assert = require('assert');
const crawl = require('./security-crawl');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.log(`  ✗ ${name}\n    ${String(err.stack || err.message).split('\n').slice(0, 14).join('\n    ')}`); }
}

// Environment secrets: obviously fake, low entropy.
const ENV = {
    JWT_SECRET: 'sentinel-not-a-secret-jwt',
    OV_OAUTH_CLIENT_SECRET: 'sentinel-not-a-secret-oauth-client',
    INTERNAL_API_KEY: 'sentinel-not-a-secret-internal-api-key',
    OV_INTERNAL_KEY: 'sentinel-not-a-secret-ov-internal-key',
    MEDIA_WEBHOOK_SECRET: 'sentinel-not-a-secret-media-webhook',
    MEDIA_EVENTS_SECRET: 'sentinel-not-a-secret-media-events',
    LIVE_EVENTS_SECRET: 'sentinel-not-a-secret-live-events',
    OPENRE_EVENTS_SECRET: 'sentinel-not-a-secret-openre-events',
    TURN_AUTH_SECRET: 'sentinel-not-a-secret-turn-auth',
    PAYPAL_CLIENT_SECRET: 'sentinel-not-a-secret-paypal',
    ADMIN_PASSWORD: 'sentinel-not-a-secret-admin-password',
    GITHUB_TOKEN: 'sentinel-not-a-secret-github-token',
    GH_TOKEN: 'sentinel-not-a-secret-gh-token',
    OPS_ALERT_WEBHOOK_URL: 'https://hooks.example.test/sentinel-not-a-secret-ops-webhook',
};
// What makes the process production-like (the drill refuses every connection to these anyway).
const PROD_LIKE = {
    NODE_ENV: 'production',
    EVENTS_URL: 'http://127.0.0.1:9',
    MEDIA_URL: 'http://127.0.0.1:9',
    OV_NETWORK_INTERNAL_URL: 'http://127.0.0.1:9',
    OV_COMMUNITY_INTERNAL_URL: 'http://127.0.0.1:9',
    OV_CHAT_INTERNAL_URL: 'http://127.0.0.1:9',
    OV_OAUTH_CLIENT_ID: 'openvibe-live',
    PAYPAL_CLIENT_ID: 'paypal-client-id-public',
};
// Secret site settings (live.site_settings), stored the way the owner's settings page stores them.
const SETTINGS = {
    gif_giphy_api_key: 'sentinel-not-a-secret-giphy',
    gif_tenor_api_key: 'sentinel-not-a-secret-tenor',
    tts_aws_access_key_id: 'sentinel-not-a-secret-aws-id',
    tts_aws_secret_access_key: 'sentinel-not-a-secret-aws-key',
    tts_google_api_key: 'sentinel-not-a-secret-google-tts',
    tts_google_service_account: '{"private_key":"sentinel-not-a-secret-google-sa"}',
    twitch_client_secret: 'sentinel-not-a-secret-twitch',
    kick_client_secret: 'sentinel-not-a-secret-kick',
    youtube_api_key: 'sentinel-not-a-secret-youtube',
    soundboard_101_api_key: 'sentinel-not-a-secret-soundboard',
    discord_webhook_url: 'https://discord.example.test/api/webhooks/1/sentinel-not-a-secret-discord',
    ops_alert_webhook_url: 'https://hooks.example.test/sentinel-not-a-secret-ops-setting',
};
const SETTING_NEEDLES = Object.fromEntries(Object.entries(SETTINGS).map(([k, v]) => [k, v.includes('{') ? 'sentinel-not-a-secret-google-sa' : v]));

const SEED = `
    const db = require('./server/db/database');
    db.initDb();
    const S = JSON.parse(process.env.SETTINGS_SEED);
    const mk = (u, role, owner) => {
        const id = Number(db.createUser({ username: u, password_hash: 'x', display_name: u, email: u + '@example.test', stream_key: null }).lastInsertRowid);
        db.run('UPDATE users SET role = ?, is_owner = ? WHERE id = ?', [role, owner ? 1 : 0, id]);
        db.ensureChannel(id);
        db.getDb().prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, service_username) VALUES (?, 'network', ?, ?)").run(id, String(9000 + id), u);
        return id;
    };
    const ids = {
        streamer: mk('secstreamer', 'streamer'), viewer: mk('secviewer', 'user'), mod: mk('secmod', 'global_mod'),
        admin: mk('secadmin', 'admin'), owner: mk('secowner', 'admin', true),
    };
    for (const [k, v] of Object.entries(S)) db.setSetting(k, v);
    db.setSetting('tts_enabled', '1');
    const ch = db.getChannelByUserId(ids.streamer);
    ids.channel = ch.id;
    ids.live = Number(db.createStream({ user_id: ids.streamer, channel_id: ch.id, title: 'Live now', protocol: 'webrtc' }).lastInsertRowid);
    ids.ended = Number(db.createStream({ user_id: ids.streamer, channel_id: ch.id, title: 'Earlier', protocol: 'webrtc' }).lastInsertRowid);
    db.endStream(ids.ended);
    db.run("UPDATE streams SET last_heartbeat = datetime('now') WHERE id = ?", [ids.live]);
    const ev = require('./server/events/stream-events');
    const events = [ev.envelopeFor('started', ids.live), ev.envelopeFor('ended', ids.ended),
        require('./server/events/release-events').envelopeFor({ head: 'a'.repeat(40), previous: 'b'.repeat(40), commits: [] })];
    db.close();
    console.log(JSON.stringify({ ids, events }));
`;

function hits(text, needles) {
    return Object.entries(needles).filter(([, v]) => v && String(text).includes(v)).map(([k]) => k);
}

(async () => {
    const tmp = crawl.tempEnv('secrets');
    const seeded = crawl.seed(tmp, SEED, { ...PROD_LIKE, ...ENV, NODE_ENV: 'test', SETTINGS_SEED: JSON.stringify(SETTINGS) });
    assert.ok(seeded && seeded.ids, 'seed printed its ids');
    const { ids, events } = seeded;

    console.log('secrets: what Live sends out');
    await check('stream lifecycle and release event envelopes carry no secret (built with every secret set)', () => {
        assert.strictEqual(events.length, 3);
        assert.deepStrictEqual(hits(JSON.stringify(events), { ...ENV, ...SETTING_NEEDLES }), []);
    });

    const keys = crawl.networkKeys(tmp);
    const srv = await crawl.boot(tmp, { ...PROD_LIKE, ...ENV, ...keys.env });
    const bearer = (id, username, role) => ({ Authorization: `Bearer ${keys.sign({ sub: String(9000 + id), id: 9000 + id, username, role })}` });
    const people = {
        anonymous: {},
        viewer: bearer(ids.viewer, 'secviewer', 'user'),
        streamer: bearer(ids.streamer, 'secstreamer', 'streamer'),
        'global mod': bearer(ids.mod, 'secmod', 'global_mod'),
        admin: bearer(ids.admin, 'secadmin', 'admin'),
        'site owner': bearer(ids.owner, 'secowner', 'admin'),
    };

    console.log('secrets: the sentinels are live');
    await check('the site owner\'s settings page shows the stored keys (so a crawl that finds none means something)', async () => {
        const r = await srv.request('GET', '/api/admin/settings', { headers: people['site owner'] });
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.ok(r.text.includes(SETTINGS.gif_tenor_api_key), 'owner sees a stored key');
    });
    await check('an admin who is not the owner gets them redacted', async () => {
        const r = await srv.request('GET', '/api/admin/settings', { headers: people.admin });
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.ok(!r.text.includes(SETTINGS.gif_tenor_api_key));
        assert.match(r.text, /gif_tenor_api_key/);
    });
    await check('each signed-in person is who the crawl says (GET /api/auth/me)', async () => {
        for (const [who, headers] of Object.entries(people)) {
            if (who === 'anonymous') continue;
            const r = await srv.request('GET', '/api/auth/me', { headers });
            assert.strictEqual(r.status, 200, `${who}: ${r.text.slice(0, 200)}`);
        }
    });

    // Real ids first, then nonsense for the error paths.
    const nonsense = ['-1', '99999999999', "'\"<x>", 'x'.repeat(300), '..%2F..%2Fetc%2Fpasswd'];
    const numeric = [ids.live, ids.streamer, ids.channel, ids.ended, 1, ...nonsense];
    const byName = {
        username: ['secstreamer', ...nonsense], user: ['secstreamer'], userId: [ids.streamer, ...nonsense],
        platform: ['twitch', 'youtube', 'kick', 'nope'], namespace: ['live.site_settings', 'nope'], name: ['whip', 'nope'],
        file: ['x.mp3'], filename: ['x.png', '..%2F..%2F.env'], slug: ['secstreamer'], anonId: ['anon1'], kind: ['user'],
        type: ['vod', 'clip'], metric: ['viewers', 'nope'], ip: ['127.0.0.1'],
    };
    const values = (n) => byName[n] || numeric;
    const paths = crawl.getPaths(srv, values, {
        query: 'q=secstreamer&provider=tenor&id=%27&limit=-1',
        extra: ['/', '/@secstreamer', `/stream/${ids.live}`, '/dashboard', '/admin', '/settings', '/search?q=x', '/sitemap.xml',
            '/llms.txt', '/robots.txt', '/metrics', '/api/ready', '/api/health', '/release.json', '/api/nope', '/nope/nope',
            '/.env', '/api/%', '/api/chat/gif/trending?provider=tenor', '/api/chat/gif/search?provider=giphy&q=cats'],
    });
    const envNeedles = ENV;
    const allNeedles = { ...ENV, ...SETTING_NEEDLES };

    console.log(`secrets: ${paths.length} GET paths from ${srv.routes.length} routes, as ${Object.keys(people).length} people`);
    const logs = crawl.captureLogs();
    let result;
    let writes = [];
    try {
        result = await crawl.crawlAll(srv, paths, people, (who) => (who === 'site owner' ? envNeedles : allNeedles));
        // Error paths of writes: a drill refuses them all, and the refusal (like a body-parser error)
        // must not echo anything.
        for (const [who, headers] of Object.entries({ anonymous: {}, admin: people.admin })) {
            for (const r of srv.routes.filter((x) => x.methods.some((m) => ['post', 'put', 'patch', 'delete'].includes(m))).slice(0, 400)) {
                const method = r.methods.find((m) => ['post', 'put', 'patch', 'delete'].includes(m)).toUpperCase();
                for (const p of crawl.expand(r.path, values).slice(0, 1)) {
                    const res = await srv.request(method, p, { headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"broken": ', timeoutMs: 3000 });
                    for (const l of crawl.leaks(res, allNeedles)) writes.push(`${who}: ${method} ${p} → ${res.status} carries ${l.label} in its ${l.where}`);
                }
            }
        }
    } finally { logs.stop(); }
    console.log(`  (answers: ${JSON.stringify(result.statuses)}; held open past the timeout: ${result.timedOut.join(', ') || 'none'})`);

    await check('the crawl reached the server (most requests answered)', () => {
        assert.ok(result.answered > paths.length * 5, `${result.answered} answers for ${paths.length * 6} requests`);
    });
    await check('no GET route, page, probe or error shows an environment secret to anyone, or a stored key to anyone but the site owner', () => {
        assert.deepStrictEqual(result.found, []);
    });
    await check('refused writes with broken bodies echo no secret', () => {
        assert.deepStrictEqual(writes, []);
    });
    await check('no log line written while serving those requests contains a secret', () => {
        const bad = logs.lines.filter((l) => hits(l, allNeedles).length).map((l) => `${hits(l, allNeedles).join(',')}: ${l.slice(0, 200)}`);
        assert.deepStrictEqual(bad, []);
    });

    tmp.cleanup();
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\nsecurity-secrets: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
