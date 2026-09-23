'use strict';
/**
 * Restore-drill mode: LIVE_DRILL=1 (`ovhost drill live`, see OpenVibe.Host docs/restore-drills.md).
 *
 * A drill starts a second Live from the production checkout, with the production env file, against
 * a restored copy of the database on a spare loopback port, and compares its public reads with
 * production's. That instance must serve reads from the copy and do nothing else. With LIVE_DRILL:
 *
 *   - assertSafe(): Live refuses to start unless DB_PATH and DATA_DIR are set and lie outside the
 *     checkout and outside /opt/openvibe.live (so neither can be production's), PORT is set and is not
 *     production's 3000, HOST is loopback, and no socket was handed over by systemd. It runs before
 *     anything opens a file. All of Live's files go under DATA_DIR (server/paths.js).
 *   - installGuards(): no outbound connection (net.Socket#connect, fetch), no program other than git
 *     (child_process; git only reads the checkout, for /release.json and the updates list), no UDP
 *     socket, and nothing listens except the drill's own HTTP port. To Live's code every other service
 *     looks down, so a route that asks Media or Community answers the way it does when they are down.
 *   - readOnly: 403 for every request that is not GET, HEAD or OPTIONS, on every path (the /api
 *     writes, and also /internal webhooks, WHIP, the ban page's Continue).
 *   - refuseUpgrade(): every WebSocket upgrade gets a 403.
 *   - server/index.js start() opens the database and serves HTTP, and starts nothing else: no job
 *     loop, no chat/broadcast/call/control socket server, no RTMP, SFU, JSMPEG or WHIP, no restream or
 *     relay resume, no AI job, no Media reconciler, no Events outbox, no chat bridge, no identity sync,
 *     no deploy notice, no star job, no registry refresh. Timers that modules start when they are
 *     loaded check `enabled` as well. TURN credentials are never minted (server/net/turn.js).
 *
 * The guards are there so that anything this list missed fails closed instead of reaching production.
 */
const path = require('path');
const fs = require('fs');

const TRUE = new Set(['1', 'true', 'on', 'yes']);

/** LIVE_DRILL as a switch (1/true/on/yes). */
function parse(value) {
    return TRUE.has(String(value == null ? '' : value).trim().toLowerCase());
}

const enabled = parse(process.env.LIVE_DRILL);

const REPO_ROOT = path.resolve(__dirname, '..');
/** Where production runs (OpenVibe.Host inventory: repo /opt/openvibe.live, database data/live.db). */
const PRODUCTION_ROOT = '/opt/openvibe.live';
const PRODUCTION_PORT = 3000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

function isLoopbackHost(host) {
    const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    return LOOPBACK_HOSTS.has(h) || /^127(\.\d{1,3}){3}$/.test(h);
}

/** The real location of p, following symlinks on the part of it that exists. */
function realish(p) {
    let head = path.resolve(p);
    const tail = [];
    for (;;) {
        try { return path.join(fs.realpathSync(head), ...tail.reverse()); } catch { /* not there (yet) */ }
        const parent = path.dirname(head);
        if (parent === head) return path.resolve(p);
        tail.push(path.basename(head));
        head = parent;
    }
}

function inside(p, root) {
    const rel = path.relative(root, p);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Why this environment is not safe for a drill ([] = safe). Pure, for tests.
 * `repoRoot` is the checkout the process runs from; `cwd` resolves relative paths.
 */
function problems(env = process.env, { repoRoot = REPO_ROOT, cwd = process.cwd(), pid = process.pid } = {}) {
    const out = [];
    const roots = [...new Set([repoRoot, realish(repoRoot), PRODUCTION_ROOT])];
    const productionDb = new Set([path.join(PRODUCTION_ROOT, 'data', 'live.db'), path.join(repoRoot, 'data', 'live.db'), path.join(cwd, 'data', 'live.db')]);
    const checkPath = (name, value) => {
        const abs = path.resolve(cwd, value);
        const real = realish(abs);
        if (name === 'DB_PATH' && (productionDb.has(abs) || productionDb.has(real))) {
            out.push(`DB_PATH (${abs}) is production's database; point it at the restored copy`);
            return;
        }
        const root = roots.find((r) => inside(abs, r) || inside(real, r));
        if (root) out.push(`${name} (${abs}${real !== abs ? ` → ${real}` : ''}) is inside ${root}; a drill writes nothing in the checkout or in production's data`);
    };
    if (!env.DB_PATH) out.push('DB_PATH is not set; it must name the restored copy of the database');
    else checkPath('DB_PATH', env.DB_PATH);
    if (!env.DATA_DIR) out.push('DATA_DIR is not set; it must name the drill\'s own data directory (Live writes all its files there)');
    else checkPath('DATA_DIR', env.DATA_DIR);
    if (!isLoopbackHost(env.HOST)) out.push(`HOST (${env.HOST || 'unset, i.e. 0.0.0.0'}) is not loopback; a drill binds 127.0.0.1 only`);
    const port = Number(env.PORT);
    if (!env.PORT || !Number.isInteger(port) || port < 1 || port > 65535) out.push('PORT is not set; it must be the drill\'s own port');
    else if (port === PRODUCTION_PORT) out.push(`PORT ${port} is production's port`);
    if (env.LISTEN_FDS && Number(env.LISTEN_PID) === pid) out.push('systemd handed this process a listening socket (LISTEN_FDS): a drill never serves on production\'s socket');
    return out;
}

class DrillRefused extends Error {
    constructor(list) {
        super(`LIVE_DRILL: refusing to start a restore-drill instance: ${list.join('; ')}`);
        this.code = 'LIVE_DRILL_UNSAFE';
        this.problems = list;
    }
}

/** Throws DrillRefused unless the environment is safe for a drill. */
function assertSafe(env = process.env, opts) {
    const list = problems(env, opts);
    if (list.length) throw new DrillRefused(list);
}

// ── Guards ───────────────────────────────────────────────────

const blocked = [];   // what the guards refused (newest last, bounded): { at, kind, target }
function note(kind, target) {
    blocked.push({ at: new Date().toISOString(), kind, target: String(target).slice(0, 200) });
    if (blocked.length > 50) blocked.shift();
    console.warn(`[Drill] refused ${kind}: ${target}`);
}

function drillError(message, code) {
    const err = new Error(`${message} (LIVE_DRILL: a restore-drill instance does not do this)`);
    err.code = code;
    return err;
}

/** Where a net.Socket#connect call is going: { host, port } or { path }. */
function connectTarget(args) {
    let a = args[0];
    if (Array.isArray(a)) a = a[0];   // net.connect() hands Socket#connect its normalized [options, cb]
    if (a && typeof a === 'object') return a.path != null ? { path: String(a.path) } : { host: a.host, port: Number(a.port) };
    if (typeof a === 'string' && !/^\d+$/.test(a)) return { path: a };
    return { host: typeof args[1] === 'string' ? args[1] : undefined, port: Number(a) };
}

const ALLOWED_PROGRAMS = new Set(['git']);

function programOf(fn, args) {
    const first = args[0];
    if (fn === 'exec' || fn === 'execSync') return String(first || '').trim().split(/\s+/)[0] || '';
    if (fn === 'fork') return 'node';
    return String(first || '');
}

let installed = false;

/**
 * Replace the process's ways out with ones that refuse (drill only). `port` is the drill's HTTP
 * port: the one address the process may connect to (itself, on loopback) and the one it may listen on.
 */
function installGuards({ port = Number(process.env.PORT) } = {}) {
    if (installed) return;
    installed = true;
    const net = require('net');
    const util = require('util');

    const isSelf = (t) => t && t.path == null && t.port === port && (t.host == null || isLoopbackHost(t.host));

    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function drillConnect(...args) {
        const t = connectTarget(args);
        if (isSelf(t)) return connect.apply(this, args);
        const where = t.path != null ? t.path : `${t.host || 'localhost'}:${t.port}`;
        note('connection', where);
        const err = drillError(`connect ECONNREFUSED ${where}`, 'ECONNREFUSED');
        err.syscall = 'connect';
        process.nextTick(() => this.destroy(err));
        return this;
    };

    if (typeof globalThis.fetch === 'function') {
        const fetch = globalThis.fetch;
        globalThis.fetch = function drillFetch(input, init) {
            let url = null;
            try { url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url); } catch { /* */ }
            if (url && isSelf({ host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) })) return fetch(input, init);
            note('fetch', url ? url.origin + url.pathname : String(input));
            return Promise.reject(new TypeError('fetch failed', { cause: drillError(`connect ECONNREFUSED ${url ? url.host : ''}`, 'ECONNREFUSED') }));
        };
    }

    const cp = require('child_process');
    for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        const orig = cp[fn];
        if (typeof orig !== 'function') continue;
        const check = (args) => {
            const program = programOf(fn, args);
            if (ALLOWED_PROGRAMS.has(path.basename(program))) return;
            note('program', program);
            throw drillError(`${fn}(${program}) refused`, 'EDRILL');
        };
        const guarded = function (...args) { check(args); return orig.apply(this, args); };
        const custom = orig[util.promisify.custom];
        if (custom) guarded[util.promisify.custom] = (...args) => { check(args); return custom(...args); };
        cp[fn] = guarded;
    }

    const dgram = require('dgram');
    dgram.createSocket = function drillUdp() {
        note('udp socket', 'dgram.createSocket');
        throw drillError('UDP socket refused', 'EDRILL');
    };

    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function drillListen(...args) {
        const a = args[0];
        const p = a && typeof a === 'object' ? Number(a.port) : Number(a);
        if (p === port && !(a && typeof a === 'object' && (a.fd != null || a.path != null))) return listen.apply(this, args);
        note('listener', a && typeof a === 'object' ? JSON.stringify(a) : String(a));
        throw drillError(`listen ${a && typeof a === 'object' ? JSON.stringify(a) : a} refused`, 'EDRILL');
    };
}

// ── HTTP ─────────────────────────────────────────────────────

/** Express middleware: reads only. */
function readOnly(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    res.status(403).json({ error: 'This is a restore-drill instance (LIVE_DRILL): it serves reads only', code: 'live.drill_read_only' });
}

/** Answer a WebSocket upgrade with 403 and close it. */
function refuseUpgrade(socket) {
    const body = 'restore-drill instance (LIVE_DRILL): no WebSockets\n';
    try {
        socket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => socket.destroy());
    } catch {
        try { socket.destroy(); } catch { /* */ }
    }
}

module.exports = {
    enabled,
    parse,
    problems,
    assertSafe,
    DrillRefused,
    installGuards,
    readOnly,
    refuseUpgrade,
    blocked,
    isLoopbackHost,
    PRODUCTION_ROOT,
    REPO_ROOT,
};
