#!/usr/bin/env node
'use strict';
/**
 * Live's OpenVibe.Events subscriptions to OpenVibe.Media's outcomes (roadmap Wave 3 exit):
 * media.vod.*, media.clip.* and media.storage.* → Live's POST /internal/media-events, signed with
 * the secret Live holds as MEDIA_EVENTS_SECRET (server/media-proxy/media-events.js). Events names
 * the consumer after the calling service, so this runs AS LIVE: it reads Live's env file (Live's
 * OAuth client, grant events.subscription.manage on audience openvibe.events) and asks Network for
 * a token with it. Nothing secret is printed. Run on the host as root (the env file is 0600):
 *
 *   sudo node /opt/openvibe.live/current/scripts/subscribe-media-events.js            # create (or report)
 *   sudo node /opt/openvibe.live/current/scripts/subscribe-media-events.js --dry-run  # list, change nothing
 *   sudo node /opt/openvibe.live/current/scripts/subscribe-media-events.js --disable  # rollback
 *   sudo node /opt/openvibe.live/current/scripts/subscribe-media-events.js --enable   # undo a --disable
 *   sudo node /opt/openvibe.live/current/scripts/subscribe-media-events.js --network  # Network's
 *        network.user.token_valid_after → /internal/network-events (server/auth/network-events.js;
 *        signed with LIVE_EVENTS_SECRET when set, else MEDIA_EVENTS_SECRET); combines with the flags above
 *
 *   [--live-env /etc/openvibe/live.env] [--endpoint http://127.0.0.1:3000/internal/media-events]
 *
 * Env names used (from the Live env file): OV_OAUTH_CLIENT_ID (default live), OV_OAUTH_CLIENT_SECRET,
 * OV_NETWORK_INTERNAL_URL (default http://127.0.0.1:4000), EVENTS_URL (default http://127.0.0.1:4300)
 * and MEDIA_EVENTS_SECRET (32+ characters; `openssl rand -hex 32`, put it in the env file and restart
 * Live first). An existing subscription with the same topic and endpoint is reported, not duplicated.
 * Subscribing changes nothing Live does until MEDIA_EVENTS_AUTHORITY is `both` or `events`: in the
 * default `webhook` mode deliveries are acknowledged and dropped. A new subscription gets no history;
 * replay with POST /api/v1/deliveries/replay (events.delivery.admin) if wanted — duplicates of
 * outcomes the webhook already applied are no-ops.
 */
const fs = require('fs');

const TOPICS = ['media.vod.*', 'media.clip.*', 'media.storage.*'];
const DEFAULT_ENDPOINT = 'http://127.0.0.1:3000/internal/media-events';
const NETWORK_TOPICS = ['network.user.token_valid_after'];
const NETWORK_ENDPOINT = 'http://127.0.0.1:3000/internal/network-events';
const DEFAULT_LIVE_ENV = '/etc/openvibe/live.env';

function parseArgs(argv) {
    const o = { liveEnv: DEFAULT_LIVE_ENV, endpoint: null, action: 'create', topics: TOPICS };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') o.action = 'list';
        else if (a === '--disable') o.action = 'disable';
        else if (a === '--enable') o.action = 'enable';
        else if (a === '--live-env') o.liveEnv = argv[++i];
        else if (a === '--endpoint') o.endpoint = argv[++i];
        else if (a === '--network') o.topics = NETWORK_TOPICS;
        else throw new Error(`unknown argument ${a}`);
    }
    if (o.endpoint === null) o.endpoint = o.topics === NETWORK_TOPICS ? NETWORK_ENDPOINT : DEFAULT_ENDPOINT;
    if (!o.liveEnv || !o.endpoint) throw new Error('--live-env and --endpoint need a value');
    return o;
}

function readLiveEnv(file = DEFAULT_LIVE_ENV) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) { throw new Error(`cannot read ${file} (${err.code}); run as root`); }
    return require('dotenv').parse(text);
}

async function readJson(res) {
    const text = await res.text();
    try { return text ? JSON.parse(text) : {}; } catch { return { detail: text.slice(0, 200) }; }
}

async function liveToken({ env, fetchImpl }) {
    const clientId = env.OV_OAUTH_CLIENT_ID || 'live';
    const network = String(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    const res = await fetchImpl(`${network}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: env.OV_OAUTH_CLIENT_SECRET, audience: 'openvibe.events' }).toString(),
        signal: AbortSignal.timeout(15000),
    });
    const tok = await readJson(res);
    if (!res.ok || !tok.access_token) throw new Error(`Network refused a token for ${clientId} (${res.status} ${tok.error || tok.code || ''})`.trim());
    return { token: tok.access_token, clientId };
}

/**
 * run({ action, endpoint, env, fetchImpl, log }) -> { action, subscriptions: [{ topic, subscription_id, created?, existed?, enabled? }] }
 * `env` is the parsed Live env file.
 */
async function run({ action = 'create', endpoint = DEFAULT_ENDPOINT, topics = TOPICS, env, fetchImpl = globalThis.fetch, log = console.log }) {
    const events = String(env.EVENTS_URL || 'http://127.0.0.1:4300').replace(/\/+$/, '');
    // Network events are verified with LIVE_EVENTS_SECRET when set (server/auth/network-events.js).
    const secret = (topics === NETWORK_TOPICS && env.LIVE_EVENTS_SECRET) || env.MEDIA_EVENTS_SECRET || '';
    if (!env.OV_OAUTH_CLIENT_SECRET) throw new Error('OV_OAUTH_CLIENT_SECRET is not set in the Live env file');
    if (action === 'create' && secret.length < 32) throw new Error('MEDIA_EVENTS_SECRET must be set in the Live env file first (32+ characters: openssl rand -hex 32)');

    const { token, clientId } = await liveToken({ env, fetchImpl });
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const listRes = await fetchImpl(`${events}/api/v1/subscriptions`, { headers, signal: AbortSignal.timeout(15000) });
    const list = await readJson(listRes);
    if (!listRes.ok) throw new Error(`Events answered ${listRes.status} listing subscriptions: ${list.code || ''} ${list.detail || ''}`.trim());
    const all = list.subscriptions || [];
    const isOn = (s) => !(s.enabled === false || s.enabled === 0);
    const describe = (s, topic) => `${s.id} (${topic} → ${endpoint}, ${isOn(s) ? 'enabled' : 'disabled'})`;

    const out = [];
    for (const topic of topics) {
        const existing = all.find((s) => s.topic_pattern === topic && s.endpoint === endpoint) || null;
        if (action === 'list') {
            log(existing ? `exists: ${describe(existing, topic)}` : `no subscription ${topic} → ${endpoint} for ${clientId}; would create one`);
            out.push({ topic, subscription_id: existing ? existing.id : null, existed: Boolean(existing) });
            continue;
        }
        if (action === 'disable' || action === 'enable') {
            if (!existing) { log(`no subscription ${topic} → ${endpoint} to ${action}`); out.push({ topic, subscription_id: null }); continue; }
            const r = await fetchImpl(`${events}/api/v1/subscriptions/${encodeURIComponent(existing.id)}/${action}`, { method: 'POST', headers, signal: AbortSignal.timeout(15000) });
            const b = await readJson(r);
            if (!r.ok) throw new Error(`Events answered ${r.status} to ${action} ${existing.id}: ${b.code || ''} ${b.detail || ''}`.trim());
            log(`${action}d: ${describe({ ...existing, enabled: action === 'enable' }, topic)}`);
            out.push({ topic, subscription_id: existing.id, enabled: action === 'enable' });
            continue;
        }
        if (existing) {
            log(`subscription exists: ${describe(existing, topic)}`);
            out.push({ topic, subscription_id: existing.id, existed: true, created: false });
            continue;
        }
        const r = await fetchImpl(`${events}/api/v1/subscriptions`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ topic_pattern: topic, endpoint, secret }),
            signal: AbortSignal.timeout(15000),
        });
        const b = await readJson(r);
        if (r.status === 409 && b.subscription_id) {
            log(`subscription exists: ${b.subscription_id} (${topic} → ${endpoint})`);
            out.push({ topic, subscription_id: b.subscription_id, existed: true, created: false });
            continue;
        }
        if (!r.ok) throw new Error(`Events answered ${r.status} for ${topic}: ${b.code || ''} ${b.detail || ''}`.trim());
        log(`subscribed: ${b.id} (${topic} → ${endpoint}), signed with Live's ${topics === NETWORK_TOPICS && env.LIVE_EVENTS_SECRET ? 'LIVE' : 'MEDIA'}_EVENTS_SECRET`);
        out.push({ topic, subscription_id: b.id, existed: false, created: true });
    }
    return { action, subscriptions: out };
}

if (require.main === module) {
    let o;
    let env;
    try { o = parseArgs(process.argv.slice(2)); env = readLiveEnv(o.liveEnv); } catch (err) { console.error(`subscribe-media-events: ${err.message}`); process.exit(2); }
    run({ action: o.action, endpoint: o.endpoint, topics: o.topics, env }).then(() => process.exit(0), (err) => { console.error(`subscribe-media-events: ${err.message}`); process.exit(1); });
}

module.exports = { run, parseArgs, TOPICS, DEFAULT_ENDPOINT, NETWORK_TOPICS, NETWORK_ENDPOINT };
