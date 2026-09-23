'use strict';
/**
 * LIVE_DRILL=1 (server/drill.js): a restore-drill instance (`ovhost drill live`, OpenVibe.Host
 * docs/restore-drills.md) serves reads from a restored copy of the database and does nothing else.
 *
 *   - It refuses to start when DB_PATH is production's database, when DB_PATH or DATA_DIR are missing
 *     or inside the checkout, when HOST is not loopback or PORT is production's, and it refuses
 *     before any file is opened (a real `node server/index.js`, in a child process).
 *   - Booted for real (server/index.js, in this process) against a temp copy with production-like
 *     settings (EVENTS_URL, MEDIA_URL, a client secret, a TURN secret): one listener, its HTTP port on
 *     127.0.0.1; no setInterval, no long timer from Live's code, an empty jobs registry; no program
 *     but git; no outbound connection.
 *   - The endpoints the Host inventory compares answer from the copy and touch nothing but it; a
 *     route that asks Media answers as if Media were down (the call is refused, never sent).
 *   - Writes answer 403 on every path (the copy's rows stay as they were), WebSocket upgrades 403, and
 *     no TURN credential is minted.
 *
 * Run: node test/drill-mode.test.js
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-drill-test-'));
const DB_PATH = path.join(tmp, 'db', 'live.db');
const DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.error(`  ✗ ${name}\n    ${err.stack || err.message}`); }
}

function freePort() {
    return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// What the production env file sets: with these, a normal boot would publish events, call Media,
// mint service tokens and TURN credentials. A drill must ignore all of it.
const PROD_LIKE = {
    NODE_ENV: 'production',
    EVENTS_URL: 'http://127.0.0.1:9',
    MEDIA_URL: 'http://127.0.0.1:9',
    OV_OAUTH_CLIENT_SECRET: 's'.repeat(40),
    INTERNAL_API_KEY: 'k'.repeat(40),
    TURN_AUTH_SECRET: 't'.repeat(40),
    OV_NETWORK_INTERNAL_URL: 'http://127.0.0.1:9',
    EMOTES_PATH: path.join(REPO, 'data', 'emotes'),   // per-path overrides are ignored in a drill
};

// ── 1. The environment guard (pure) ──────────────────────────
const drillMod = require('../server/drill');   // LIVE_DRILL is unset here: `enabled` is false in this process until the boot below
const safe = { DB_PATH, DATA_DIR, HOST: '127.0.0.1', PORT: '13000' };

(async () => {
    console.log('drill-mode: environment guard');
    await check('LIVE_DRILL parses like a switch and is off by default', () => {
        for (const v of ['1', 'true', 'on', 'yes', 'TRUE']) assert.strictEqual(drillMod.parse(v), true, v);
        for (const v of ['', '0', 'false', 'off', undefined]) assert.strictEqual(drillMod.parse(v), false, String(v));
        assert.strictEqual(drillMod.enabled, false);
    });
    await check('a safe environment passes', () => {
        assert.deepStrictEqual(drillMod.problems(safe), []);
    });
    await check('refuses production\'s database, by the checkout\'s path and by /opt/openvibe.live', () => {
        for (const p of [path.join(REPO, 'data', 'live.db'), '/opt/openvibe.live/data/live.db']) {
            const list = drillMod.problems({ ...safe, DB_PATH: p });
            assert.ok(list.some((m) => /production's database/.test(m)), `${p}: ${list.join('; ')}`);
        }
        const rel = drillMod.problems({ ...safe, DB_PATH: './data/live.db' }, { cwd: REPO });
        assert.ok(rel.some((m) => /production's database/.test(m)), rel.join('; '));
    });
    await check('refuses missing DB_PATH / DATA_DIR and anything inside the checkout or /opt/openvibe.live', () => {
        assert.ok(drillMod.problems({ ...safe, DB_PATH: '' }).some((m) => /DB_PATH is not set/.test(m)));
        assert.ok(drillMod.problems({ ...safe, DATA_DIR: '' }).some((m) => /DATA_DIR is not set/.test(m)));
        assert.ok(drillMod.problems({ ...safe, DATA_DIR: path.join(REPO, 'data') }).some((m) => /DATA_DIR .* is inside/.test(m)));
        assert.ok(drillMod.problems({ ...safe, DB_PATH: path.join(REPO, 'drill.db') }).some((m) => /DB_PATH .* is inside/.test(m)));
        assert.ok(drillMod.problems({ ...safe, DATA_DIR: '/opt/openvibe.live/data-drill' }).some((m) => /is inside \/opt\/openvibe\.live/.test(m)));
    });
    await check('refuses a symlink that leads into the checkout', () => {
        const link = path.join(tmp, 'sneaky');
        fs.symlinkSync(path.join(REPO, 'data'), link);
        const list = drillMod.problems({ ...safe, DATA_DIR: link });
        assert.ok(list.some((m) => /DATA_DIR .* is inside/.test(m)), list.join('; '));
        fs.unlinkSync(link);
    });
    await check('refuses a non-loopback HOST, production\'s PORT and a socket handed over by systemd', () => {
        for (const h of ['', '0.0.0.0', '::', '192.168.1.5']) assert.ok(drillMod.problems({ ...safe, HOST: h }).some((m) => /not loopback/.test(m)), h);
        for (const h of ['127.0.0.1', '::1', 'localhost', '127.0.0.2']) assert.deepStrictEqual(drillMod.problems({ ...safe, HOST: h }), [], h);
        assert.ok(drillMod.problems({ ...safe, PORT: '3000' }).some((m) => /production's port/.test(m)));
        assert.ok(drillMod.problems({ ...safe, PORT: '' }).some((m) => /PORT is not set/.test(m)));
        assert.ok(drillMod.problems({ ...safe, LISTEN_FDS: '1', LISTEN_PID: '42' }, { pid: 42 }).some((m) => /LISTEN_FDS/.test(m)));
    });

    // ── 2. A real `node server/index.js` refuses before touching anything ──
    console.log('drill-mode: refusal at boot');
    const refusalPort = await freePort();
    const boot = (env) => spawnSync(process.execPath, [path.join(SERVER, 'index.js')], {
        cwd: REPO, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, ...PROD_LIKE, LIVE_DRILL: '1', DATA_DIR, HOST: '127.0.0.1', PORT: String(refusalPort), ...env },
    });
    const stamp = (p) => { try { const s = fs.statSync(p); return `${s.size}:${s.mtimeMs}`; } catch { return 'absent'; } };
    await check('DB_PATH = production\'s database: exit 1, the file untouched', () => {
        const prod = path.join(REPO, 'data', 'live.db');
        const before = [prod, `${prod}-wal`, `${prod}-shm`].map(stamp);
        const r = boot({ DB_PATH: prod });
        assert.strictEqual(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stderr, /refusing to start a restore-drill instance: DB_PATH .* is production's database/);
        assert.deepStrictEqual([prod, `${prod}-wal`, `${prod}-shm`].map(stamp), before, 'production\'s database files are unchanged');
    });
    await check('HOST 0.0.0.0: exit 1 before the database is created', () => {
        const other = path.join(tmp, 'never', 'live.db');
        const r = boot({ DB_PATH: other, HOST: '0.0.0.0' });
        assert.strictEqual(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stderr, /HOST \(0\.0\.0\.0\) is not loopback/);
        assert.ok(!fs.existsSync(path.dirname(other)), 'nothing created');
    });

    // ── 3. The restored copy (a normal-mode process fills it, as production would have) ──
    const seed = spawnSync(process.execPath, ['-e', `
        const db = require('./server/db/database');
        db.initDb();
        require('./server/themes/theme-service').seedBuiltinThemes();
        const star = db.createUser({ username: 'drillstar', password_hash: 'x', display_name: 'Drill Star', stream_key: 'secretkey123' }).lastInsertRowid;
        const fan = db.createUser({ username: 'drillfan', password_hash: 'x', display_name: 'Drill Fan', stream_key: 'fankey456' }).lastInsertRowid;
        db.ensureChannel(star); db.ensureChannel(fan);
        db.run("INSERT INTO streams (user_id, title, protocol, is_live, viewer_count, started_at, last_heartbeat) VALUES (?, 'Restored stream', 'webrtc', 1, 3, datetime('now'), datetime('now'))", [star]);
        db.run("INSERT INTO streams (user_id, title, protocol, is_live, started_at, ended_at) VALUES (?, 'Old stream', 'webrtc', 0, datetime('now', '-2 days'), datetime('now', '-2 days', '+1 hour'))", [star]);
        db.run("INSERT INTO emotes (user_id, code, url, is_global) VALUES (?, 'drillWave', '/api/emotes/file/wave.png', 1)", [star]);
        db.run('INSERT INTO follows (follower_id, streamer_id) VALUES (?, ?)', [fan, star]);
        db.run("INSERT INTO chat_messages (stream_id, user_id, username, message) VALUES (1, ?, 'drillfan', 'hello from the backup')", [fan]);
        db.initDb();   // production booted since these rows were written (its backfills already ran on them)
        db.close();
    `], { cwd: REPO, encoding: 'utf8', env: { ...process.env, DB_PATH, DATA_DIR, NODE_ENV: 'test' } });
    assert.strictEqual(seed.status, 0, `seeding the copy failed:\n${seed.stdout}\n${seed.stderr}`);
    const Database = require('better-sqlite3');
    const COUNTED = ['users', 'channels', 'managed_streams', 'streams', 'follows', 'chat_messages'];
    const counts = () => { const d = new Database(DB_PATH, { readonly: true }); try { return Object.fromEntries(COUNTED.map((t) => [t, d.prepare(`SELECT count(*) AS n FROM ${t}`).get().n])); } finally { d.close(); } };
    const countsBefore = counts();

    // ── 4. Boot the real server in drill mode, in this process, with spies ──
    const port = await freePort();
    Object.assign(process.env, PROD_LIKE, { LIVE_DRILL: '1', DB_PATH, DATA_DIR, HOST: '127.0.0.1', PORT: String(port) });
    const inRepoServer = (stack) => {
        const frame = stack.split('\n').slice(2).find((l) => l.includes(REPO) && !l.includes(`${path.sep}node_modules${path.sep}`) && !l.includes(__filename));
        return frame && frame.includes(`${SERVER}${path.sep}`) ? frame.trim() : null;
    };
    const spied = { intervals: [], longTimeouts: [], listens: [], programs: [], udp: 0 };
    const realSetInterval = global.setInterval;
    global.setInterval = function (fn, ms, ...a) { spied.intervals.push({ ms, at: (new Error().stack.split('\n')[2] || '').trim() }); return realSetInterval(fn, ms, ...a); };
    const realSetTimeout = global.setTimeout;
    global.setTimeout = function (fn, ms, ...a) { if (ms >= 1000) { const at = inRepoServer(new Error().stack); if (at) spied.longTimeouts.push({ ms, at }); } return realSetTimeout(fn, ms, ...a); };
    const realListen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...a) { spied.listens.push(a[0]); return realListen.apply(this, a); };
    const cp = require('child_process');
    for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        const orig = cp[fn];
        cp[fn] = function (...a) { spied.programs.push(fn === 'exec' || fn === 'execSync' ? String(a[0]).split(/\s+/)[0] : String(a[0])); return orig.apply(this, a); };
    }
    const analyticsInRepo = stamp(path.join(REPO, 'data', 'analytics.db'));

    // drill.js read LIVE_DRILL (unset) when section 1 loaded it; the server must load it afresh.
    delete require.cache[require.resolve('../server/drill')];
    require('../server/index.js');
    const drill = require('../server/drill');
    const base = `http://127.0.0.1:${port}`;
    const request = (method, p, { headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
        const req = http.request(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
            let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, text: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
        });
        req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: 101, upgraded: true }); });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
    let ready = null;
    for (let i = 0; i < 150 && !(ready && ready.status === 200); i++) {
        try { ready = await request('GET', '/api/ready'); } catch { /* not listening yet */ }
        if (!ready || ready.status !== 200) await new Promise((r) => realSetTimeout(r, 100));
    }
    // Let anything deferred by a few seconds show itself.
    await new Promise((r) => realSetTimeout(r, 1500));

    console.log('drill-mode: a booted drill instance');
    await check('/api/ready is 200 and says mode: drill (Media not asked)', () => {
        assert.strictEqual(ready && ready.status, 200, ready && ready.text);
        assert.strictEqual(ready.json.ready, true);
        assert.strictEqual(ready.json.mode, 'drill');
        assert.strictEqual(ready.json.checks.media.error, 'not checked (restore drill)');
    });
    await check('one listener: its HTTP port on 127.0.0.1 (no RTMP, JSMPEG, SFU, WHIP, egress proxy)', () => {
        assert.deepStrictEqual(spied.listens, [{ port, host: '127.0.0.1' }]);
        const servers = process._getActiveHandles().filter((h) => h instanceof net.Server && h.listening);
        assert.deepStrictEqual(servers.map((s) => s.address()), [{ address: '127.0.0.1', family: 'IPv4', port }]);
        assert.strictEqual(process._getActiveHandles().filter((h) => h && h.constructor && h.constructor.name === 'Socket' && typeof h.send === 'function' && h.type).length, 0, 'no UDP socket');
    });
    await check('no timers: no setInterval at all, no timer of a second or more from Live\'s code, an empty jobs registry', () => {
        assert.deepStrictEqual(spied.intervals, [], JSON.stringify(spied.intervals, null, 1));
        assert.deepStrictEqual(spied.longTimeouts, [], JSON.stringify(spied.longTimeouts, null, 1));
        assert.deepStrictEqual(require('../server/utils/jobs').snapshot(), []);
    });
    await check('no program but git ran, and nothing was refused (nothing tried to leave)', () => {
        assert.ok(spied.programs.every((p) => path.basename(p) === 'git'), spied.programs.join(', '));
        assert.deepStrictEqual(drill.blocked, []);
    });
    await check('files go to DATA_DIR: analytics.db there, the checkout\'s untouched', () => {
        assert.ok(fs.existsSync(path.join(DATA_DIR, 'analytics.db')));
        assert.strictEqual(stamp(path.join(REPO, 'data', 'analytics.db')), analyticsInRepo);
        assert.strictEqual(require('../server/paths').dir('EMOTES_PATH', 'emotes'), path.join(DATA_DIR, 'emotes'), 'EMOTES_PATH from the env file is ignored');
    });

    console.log('drill-mode: reads');
    const head = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    await check('the endpoints the Host inventory compares answer from the copy and ask nobody', async () => {
        const rel = await request('GET', '/release.json');
        assert.strictEqual(rel.status, 200);
        assert.strictEqual(rel.json.release, head);
        const streams = await request('GET', '/api/streams');
        assert.strictEqual(streams.status, 200);
        assert.deepStrictEqual(streams.json.streams.map((s) => [s.title, s.user_id, s.username]), [['Restored stream', 1, 'drillstar']]);
        assert.ok(!/secretkey123/.test(streams.text), 'no ingest key');
        const themes = await request('GET', '/api/themes');
        assert.strictEqual(themes.status, 200);
        assert.ok(themes.json.themes.length > 0);
        const emotes = await request('GET', '/api/emotes/global');
        assert.deepStrictEqual(emotes.json.emotes.map((e) => e.code), ['drillWave']);
        const live = await request('GET', '/api/streams/channel/drillstar/live');
        assert.strictEqual(live.status, 200);
        assert.strictEqual(live.json.streams.length, 1);
        const chEmotes = await request('GET', '/api/emotes/channel/1');
        assert.strictEqual(chEmotes.status, 200);
        assert.deepStrictEqual(drill.blocked, [], 'none of these asked another service');
        assert.deepStrictEqual(counts(), countsBefore, 'and none of them wrote');
    });
    await check('/api/streams/recently-online asks Media for thumbnails only (the inventory ignores vod_thumbnail)', async () => {
        const online = await request('GET', '/api/streams/recently-online?limit=20');
        assert.strictEqual(online.status, 200);
        assert.deepStrictEqual(online.json.streamers.map((x) => [x.username, x.managed_streams.length, x.managed_streams[0].vod_thumbnail]), [['drillstar', 1, null]]);
        assert.deepStrictEqual(drill.blocked.map((b) => b.target), ['http://127.0.0.1:9/api/v1/live/vods/latest-thumbs'], 'the thumbnail lookup, refused');
        drill.blocked.length = 0;
    });
    await check('other reads from Live\'s own DB work (home, channel poll, SPA shell)', async () => {
        for (const p of ['/api/home/stats-live', '/api/home/digest', '/api/home/featured', '/api/streams/channel/drillstar?pollOnly=1', '/api/health', '/']) {
            const r = await request('GET', p, { headers: p === '/' ? { Accept: 'text/html' } : {} });
            assert.strictEqual(r.status, 200, `${p}: ${r.status} ${r.text.slice(0, 200)}`);
        }
        const stats = await request('GET', '/api/home/stats-live');
        assert.strictEqual(stats.json.liveNow === undefined ? 1 : stats.json.liveNow, 1);
        assert.strictEqual(stats.json.chatMessages, 1);
    });
    await check('a route that asks Media answers as if Media were down: the call is refused, not sent', async () => {
        const r = await request('GET', '/api/streams/channel/drillstar');
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.deepStrictEqual(r.json.vods, []);
        assert.ok(drill.blocked.length > 0, 'the Media call was refused by the drill guard');
        assert.ok(drill.blocked.every((b) => b.kind === 'fetch' || b.kind === 'connection'), JSON.stringify(drill.blocked));
    });

    console.log('drill-mode: writes, sockets, credentials');
    await check('writes answer 403 on every path, and change nothing', async () => {
        const before = counts();
        const writes = [
            ['POST', '/api/streams', { title: 'x' }], ['PUT', '/api/streams/1', { title: 'y' }], ['PATCH', '/api/streams/1', { title: 'y' }],
            ['DELETE', '/api/streams/1', null], ['POST', '/api/chat/send', { message: 'hi' }], ['POST', '/api/auth/logout', null],
            ['POST', '/internal/media-events', { type: 'media.vod.ready' }], ['POST', '/internal/media-webhook', {}], ['POST', '/whip/1', null],
            ['POST', '/banned/continue', null], ['POST', '/api/csp-report', {}],
        ];
        for (const [m, p, body] of writes) {
            const r = await request(m, p, { body });
            assert.strictEqual(r.status, 403, `${m} ${p}: ${r.status}`);
            assert.strictEqual(r.json && r.json.code, 'live.drill_read_only', `${m} ${p}`);
        }
        assert.deepStrictEqual(counts(), before);
    });
    await check('WebSocket upgrades are refused with 403', async () => {
        for (const p of ['/ws/chat', '/ws/broadcast', '/ws/call', '/ws/control', '/ws/robotstreamer-publish']) {
            const r = await request('GET', p, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
            assert.strictEqual(r.status, 403, `${p} answered ${r.status}`);
            assert.ok(!r.upgraded);
        }
    });
    await check('no TURN credential is minted, even with TURN_AUTH_SECRET set', () => {
        const turn = require('../server/net/turn');
        assert.strictEqual(turn.turnCredentials('x'), null);
        assert.deepStrictEqual(turn.turnEntries('turn:turn.example:3478', 'x'), []);
    });
    await check('the guards refuse a connection, a program and a listener that code might still try', async () => {
        await assert.rejects(fetch('https://openvibe.media/healthz'), /fetch failed/);
        const sock = net.connect({ host: '127.0.0.1', port: 9 });
        const err = await new Promise((resolve) => sock.on('error', resolve));
        assert.strictEqual(err.code, 'ECONNREFUSED');
        assert.throws(() => cp.spawn('ffmpeg', ['-version']), (e) => e.code === 'EDRILL');
        assert.throws(() => net.createServer().listen(1935), (e) => e.code === 'EDRILL');
        assert.throws(() => require('dgram').createSocket('udp4'), (e) => e.code === 'EDRILL');
    });

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    if (failures) { console.error(`\n${failures} drill-mode check(s) failed`); process.exit(1); }
    console.log('\ndrill-mode: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
