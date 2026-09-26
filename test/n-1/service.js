'use strict';
/**
 * Live's side of the N-1 harness (test/n-1/harness.js): its clients, how a release boots and is
 * seeded, where its SQL lives. Used by scripts/n-1-record.js (on N-1, in a temporary worktree) and by
 * test/n-1.test.js (on this checkout), so both boot and seed the same way.
 *
 * A release boots as a real `node server/index.js` in the restore-drill sandbox (LIVE_DRILL: loopback
 * only, no outbound connection, program, listener or background job; Media and Community look down),
 * with test/n-1/preload.js lifting the drill's read-only guard so writes reach their routes. Sign-in is
 * a Network RS256 token signed with a key made for the run (DATA_DIR/keys).
 */
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { readTree } = require('./harness');

const PRELOAD = path.join(__dirname, 'preload.js');
const ISSUER = 'https://openvibe.network';

// Served by OpenVibe.Chat on openvibe.live (Chat's deploy/nginx/openvibe.live-chat.locations.conf):
// Live's chat widget and messenger are Chat's N-1 clients, checked there.
const CHAT_PATHS = /^\/(api\/(chat|dm|tts)\/|api\/sounds(\/|$)|ws\/)/;

function freePort() {
    return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

/** A clean environment: nothing from the caller's shell reaches the release but PATH and HOME. */
function baseEnv(extra) {
    return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || '/tmp', NODE_ENV: 'test', ...extra };
}

const SEED = `
    console.log = () => {}; console.warn = () => {};
    const db = require('./server/db/database');
    db.initDb();
    const d = db.getDb();
    const star = Number(db.createUser({ username: 'n1star', display_name: 'N1 Star', password_hash: 'x', stream_key: 'n1starkey' }).lastInsertRowid);
    const fan = Number(db.createUser({ username: 'n1fan', display_name: 'N1 Fan', password_hash: 'x', stream_key: 'n1fankey' }).lastInsertRowid);
    d.prepare("UPDATE users SET role = 'streamer', bio = 'Seeded for the N-1 test' WHERE id = ?").run(star);
    db.ensureChannel(star); db.ensureChannel(fan);
    d.prepare("INSERT INTO streams (user_id, title, category, protocol, is_live, viewer_count, started_at, last_heartbeat) VALUES (?, 'N-1 live stream', 'tech', 'webrtc', 1, 2, datetime('now', '-10 minutes'), datetime('now'))").run(star);
    d.prepare("INSERT INTO streams (user_id, title, category, protocol, is_live, started_at, ended_at) VALUES (?, 'N-1 past stream', 'irl', 'webrtc', 0, datetime('now', '-2 days'), datetime('now', '-2 days', '+1 hour'))").run(star);
    db.followUser(fan, star);
    d.prepare("INSERT INTO chat_messages (stream_id, user_id, username, message) VALUES (1, ?, 'n1fan', 'hello from N-1')").run(fan);
    db.close();
`;

module.exports = {
    service: 'live',

    /** The browser client: the SPA and the standalone pages. */
    clientFiles(dir) {
        return readTree(dir, ['public/js', 'public/fragments', 'public/obs', 'public/index.html', 'public/kiosk.html',
            'public/media-player.html', 'public/popout-chat.html', 'public/whip-publisher.html', 'public/banned.html',
            'public/live-notify.js', 'public/service-worker.js'], ['.js', '.html']);
    },
    callers: [
        { name: 'api', prefix: '/api' },
        { name: 'apiSWR', prefix: '/api' },
        { name: 'dmApi', prefix: '/api/dm' },
        { name: 'fetch' },
        { name: 'mpApi' },
        { name: 'ownerAction', methodArg: 1 },
        { name: 'patchJson', method: 'PATCH' },
        { name: 'navigator.sendBeacon', method: 'POST' },
    ],
    strip: ['API', 'location.origin', 'window.location.origin'],
    keep: (pathname) => !CHAT_PATHS.test(pathname),
    /** Values for template expressions, first match wins: the seeded streamer, ids of seeded rows. */
    samples: [
        [/id\)*$/i, '1'],
        [/offset|cursor|before|after|since/i, '0'],
        [/limit|count|size|per_?page|max/i, '5'],
        [/page\)*$/i, '1'],
        [/user_?name|login|handle|channel|slug|streamer|name\)*$/i, 'n1star'],
        [/^q$|query|search|term/i, 'n1'],
    ],

    sqlDirs: ['server'],
    ledgerTables: ['schema_migrations'],

    /** Seeds a database with the release in `dir` (its initDb migrates first). */
    seed({ dir, dbPath, dataDir }) {
        const r = spawnSync(process.execPath, ['-e', SEED], { cwd: dir, encoding: 'utf8', timeout: 120000, env: baseEnv({ DB_PATH: dbPath, DATA_DIR: dataDir }) });
        if (r.status !== 0) throw new Error(`seeding failed:\n${String(r.stderr || '').slice(-2000)}`);
    },

    /** Boots the release in `dir` → { url, headers(auth), close() }. */
    async boot({ dir, dbPath, dataDir, sqlOut = '' }) {
        const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
        fs.mkdirSync(path.join(dataDir, 'keys'), { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'keys', 'openvibe-tools-public.pem'), keys.publicKey);
        const port = await freePort();
        const child = spawn(process.execPath, ['-r', PRELOAD, 'server/index.js'], {
            cwd: dir,
            env: baseEnv({ LIVE_DRILL: '1', DB_PATH: dbPath, DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port), N1_SQL_OUT: sqlOut }),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let log = '';
        child.stdout.on('data', (c) => { log = (log + c).slice(-20000); });
        child.stderr.on('data', (c) => { log = (log + c).slice(-20000); });
        const exited = new Promise((resolve) => child.on('exit', resolve));
        const url = `http://127.0.0.1:${port}`;
        for (let i = 0; ; i++) {
            if (child.exitCode != null) throw new Error(`the release in ${dir} exited while booting:\n${log.slice(-3000)}`);
            try { const r = await fetch(`${url}/api/ready`); if (r.status === 200) break; } catch { /* not listening yet */ }
            if (i > 300) { child.kill('SIGKILL'); throw new Error(`the release in ${dir} did not become ready:\n${log.slice(-3000)}`); }
            await new Promise((r) => setTimeout(r, 100));
        }
        const jwt = require('jsonwebtoken');
        const token = jwt.sign({ sub: 'n1-network-user', username: 'n1star', display_name: 'N1 Star', role: 'streamer' },
            keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
        return {
            url,
            log: () => log,
            headers: (auth) => (auth === 'user' ? { authorization: `Bearer ${token}` } : {}),
            async close() {
                if (child.exitCode == null) child.kill('SIGTERM');
                const t = setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 5000);
                await exited;
                clearTimeout(t);
            },
        };
    },
};
