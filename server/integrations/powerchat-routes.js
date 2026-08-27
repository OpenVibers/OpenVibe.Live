/**
 * powerchat-routes.js — PowerChat integration API (mounted at /api/powerchat).
 *
 *   GET    /status                    my connection + app-config state
 *   GET    /oauth/start               begin OAuth (opened in a popup)
 *   GET    /oauth/callback            code exchange → store grant (state-cookie auth)
 *   DELETE /oauth/connection          revoke + disconnect
 *   GET    /tip-link                  attribution deep link to the streamer's tip page
 *   POST   /test-alert                fire a PowerChat test alert (alerts:trigger)
 *   POST   /webhook                   signed event receiver (no auth; HMAC verified)
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db/database');
const config = require('../config');
const { requireAuth, optionalAuth } = require('../auth/auth');
const oauth = require('./powerchat-oauth');
const webhook = require('./powerchat-webhook');

const STATE_COOKIE = 'powerchat_oauth_state';
function cookieOpts() {
    const secure = String(config.baseUrl).startsWith('https');
    return { httpOnly: true, sameSite: 'lax', secure, maxAge: 10 * 60 * 1000, path: '/api/powerchat/oauth' };
}

function resultPage(payload) {
    const data = JSON.stringify(payload);
    return `<!doctype html><html><head><meta charset="utf-8"><title>Connecting…</title>
<style>
:root{color-scheme:dark}
body{font-family:system-ui,-apple-system,sans-serif;background:radial-gradient(circle at 50% 30%,#1b1b22,#0c0c11);color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;padding:24px;animation:rise .4s cubic-bezier(.34,1.4,.64,1)}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.icon{width:72px;height:72px;border-radius:50%;margin:0 auto 18px;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:800}
.ok .icon{background:#0f3a17;color:#53fc18;box-shadow:0 0 0 3px rgba(83,252,24,.35);animation:pop .5s cubic-bezier(.34,1.7,.5,1)}
.err .icon{background:#3a0f14;color:#ff6b6b;box-shadow:0 0 0 3px rgba(255,107,107,.3);animation:shake .5s}
@keyframes pop{0%{transform:scale(0)}70%{transform:scale(1.2)}100%{transform:scale(1)}}
@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
h2{margin:0 0 6px;font-size:1.4rem}.ok h2{color:#53fc18}.err h2{color:#ff6b6b}
p{color:#aaa;margin:0;max-width:340px;line-height:1.5}
.close-hint{margin-top:16px;font-size:.78rem;color:#666}
</style></head>
<body><div class="box ${payload.ok ? 'ok' : 'err'}"><div class="icon">${payload.ok ? '✓' : '✕'}</div>
<h2>${payload.ok ? 'Connected!' : 'Connection failed'}</h2>
<p>${payload.ok ? 'PowerChat account linked. Returning to OpenVibe.Live…' : (payload.error || 'Something went wrong.')}</p>
<div class="close-hint">${payload.ok ? 'This window closes automatically.' : 'You can close this window.'}</div></div>
<script>(function(){
  var msg = Object.assign({ type: 'powerchat-oauth' }, ${data});
  try { if (window.opener) window.opener.postMessage(msg, '${config.baseUrl}'); } catch(e){}
  try { var bc = new BroadcastChannel('powerchat-oauth'); bc.postMessage(msg); setTimeout(function(){try{bc.close();}catch(e){}},500); } catch(e){}
  try { localStorage.setItem('powerchat-oauth', JSON.stringify(Object.assign({ t: Date.now() }, msg))); } catch(e){}
  setTimeout(function(){ try { window.close(); } catch(e){} }, ${payload.ok ? 900 : 2500});
})();</script></body></html>`;
}

// ── GET /status ──────────────────────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
    try {
        const cfg = oauth.getConfig();
        let conn = db.getPowerchatConnection(req.user.id);
        const connected = !!(conn && conn.access_token);
        // Distinguish a real OAuth app connection (mints refresh tokens) from a
        // sandbox self-connect (no tokens) so the card can say which it is.
        const connection_kind = connected ? (conn.refresh_token ? 'app' : 'testing') : null;
        const wanted = String(cfg.scopes).split(/\s+/).filter(Boolean);
        const diagnosis = [];

        // ?live=1 → ask PowerChat itself (GET /me, no scope needed) which streamer this
        // token belongs to and which scopes the grant REALLY carries. The stored scope
        // column is what the token response said at connect time; the live grant is the
        // truth (streamers can switch capabilities off later, and a scope registered
        // in the dashboard but never requested never lands on the grant at all).
        let live = null, live_error = null;
        if (connected && conn.refresh_token && String(req.query.live || '') === '1') {
            try {
                live = await oauth.fetchMe(req.user.id);
                if (live) {
                    const patch = {};
                    const liveScope = live.scopes.join(' ');
                    if (liveScope && liveScope !== String(conn.scope || '')) patch.scope = liveScope;
                    if (live.id && String(live.id) !== String(conn.powerchat_user_id || '')) patch.powerchat_user_id = live.id;
                    if (live.tipPageUrl && live.tipPageUrl !== conn.tip_page_url) patch.tip_page_url = live.tipPageUrl;
                    if (live.username && conn.powerchat_username && live.username.toLowerCase() !== String(conn.powerchat_username).toLowerCase()) {
                        diagnosis.push({ level: 'warn', code: 'identity_mismatch', message: `This token belongs to PowerChat user "${live.username}", but the connection was saved as "${conn.powerchat_username}". Reconnect to fix.` });
                    }
                    if (Object.keys(patch).length) conn = db.upsertPowerchatConnection(req.user.id, patch) || conn;
                }
            } catch (e) {
                live_error = { status: e.status || null, message: e.message };
                diagnosis.push({
                    level: e.status === 401 ? 'error' : 'warn', code: 'me_failed',
                    message: e.status === 401
                        ? 'PowerChat no longer accepts this connection\'s token — reconnect.'
                        : `Couldn't verify the grant with PowerChat right now (${e.status || e.message}).`,
                });
            }
        }

        const scopes = live ? live.scopes : (conn && conn.scope ? String(conn.scope).split(/\s+/).filter(Boolean) : []);
        // Scopes the app now requests that this grant was minted WITHOUT. Grants never
        // gain scopes retroactively — the fix is a reconnect (re-consent).
        const diff = oauth.scopeDiff(scopes, wanted);
        const missing_scopes = (connected && scopes.length) ? diff.missing : [];
        if (missing_scopes.length) {
            diagnosis.push({
                level: 'warn', code: 'missing_scopes',
                message: `${live ? 'PowerChat reports' : 'This connection was saved with'} a grant missing: ${missing_scopes.join(', ')}. ` +
                    'Those features fail with 403 until you reconnect (one click, same account) so the grant is re-minted with them.',
                scopes: missing_scopes,
            });
        } else if (live) {
            diagnosis.push({ level: 'ok', code: 'scopes_ok', message: `Verified live with PowerChat: all ${wanted.length} permissions are granted to @${live.username}.` });
        }
        // Fixed-price checkouts: are intents available on this PowerChat deployment?
        try {
            const intents = require('./powerchat-checkout').checkoutIntentSupport();
            if (intents.state === 'unsupported') diagnosis.push({ level: 'info', code: 'intents_unsupported', message: 'Fixed-price checkout intents are not deployed on this PowerChat yet — subscriptions and Vibes packs use canonical pinned links (amount still enforced by our webhook checks).' });
        } catch { /* optional */ }
        if (conn && conn.last_error) diagnosis.push({ level: 'warn', code: 'last_error', message: conn.last_error });

        res.json({
            enabled: cfg.enabled,
            configured: oauth.isConfigured(),
            connected,
            connection_kind,
            username: conn ? conn.powerchat_username : null,
            tip_page_url: conn ? conn.tip_page_url : null,
            scope: conn ? conn.scope : null,
            scopes,
            wanted_scopes: wanted,
            missing_scopes,
            extra_scopes: connected ? diff.extra : [],
            live: live ? { username: live.username, id: live.id, app_id: live.appId, verified_at: new Date().toISOString() } : null,
            live_error,
            diagnosis,
            last_error: conn ? conn.last_error : null,
            sandbox_username: cfg.sandboxUsername,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load PowerChat status' });
    }
});

// ── GET /oauth/start ─────────────────────────────────────────────────────────
router.get('/oauth/start', requireAuth, (req, res) => {
    try {
        const cfg = oauth.getConfig();
        if (!cfg.enabled) return res.status(400).send(resultPage({ ok: false, error: 'PowerChat is not enabled by the site admin yet.' }));
        if (!oauth.isConfigured()) return res.status(400).send(resultPage({ ok: false, error: 'PowerChat app credentials are not configured yet.' }));
        // The streamer's PowerChat username (their :username segment). Defaults to the
        // sandbox username so the app owner can test before approval.
        const username = String(req.query.username || cfg.sandboxUsername || '').trim();
        const { url, stateToken } = oauth.buildAuthorize({ userId: req.user.id, username });
        res.cookie(STATE_COOKIE, stateToken, cookieOpts());
        res.redirect(url);
    } catch (err) {
        res.status(400).send(resultPage({ ok: false, error: err.message }));
    }
});

// ── GET /oauth/callback ──────────────────────────────────────────────────────
router.get('/oauth/callback', async (req, res) => {
    const send = (p) => res.set('Content-Type', 'text/html').send(resultPage(p));
    try {
        const { code, state, error, error_description } = req.query;

        // Checkout RETURN redirect (app_redirect_uri points at this registered URI):
        // PowerChat sends the viewer back here after a tip with powerchat_status +
        // powerchat_event_id + our app_ref. This is UX + correlation ONLY — the signed
        // webhook is the sole authoritative confirmation, so this page never credits
        // anything; it just tells the viewer and nudges open tabs to refresh balances.
        if (req.query.powerchat_status) {
            const ok = String(req.query.powerchat_status) === 'completed';
            const html = `<!doctype html><html><head><meta charset="utf-8"><title>${ok ? 'Payment received' : 'Checkout'}</title>
<style>:root{color-scheme:dark}body{font-family:system-ui,sans-serif;background:#0c0c11;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
h2{color:${ok ? '#53fc18' : '#f0a742'};margin-bottom:6px}p{color:#aaa;max-width:360px;line-height:1.5}</style></head>
<body><div><h2>${ok ? '✓ Tip received!' : 'Checkout not completed'}</h2>
<p>${ok ? 'Thanks! Your purchase is confirmed automatically within a few seconds — you can close this window.' : 'The tip wasn\'t completed. You can close this window and try again.'}</p></div>
<script>try{var bc=new BroadcastChannel('powerchat-checkout');bc.postMessage({status:${JSON.stringify(String(req.query.powerchat_status))},ref:${JSON.stringify(String(req.query.app_ref || ''))}});setTimeout(function(){bc.close();window.close();},1800);}catch(e){}</script></body></html>`;
            return res.set('Content-Type', 'text/html').send(html);
        }
        // Surface PowerChat's full RFC-6749 error: error_description carries the actionable
        // diagnosis (e.g. "Not registered for this app: follows:write … add them to the app
        // registration first"), which the bare error code alone hides.
        if (error) {
            const desc = error_description ? String(error_description) : '';
            return send({ ok: false, error: desc ? `${desc} (${error})` : String(error) });
        }
        const stateData = oauth.verifyState(req.cookies ? req.cookies[STATE_COOKIE] : null);
        res.clearCookie(STATE_COOKIE, { path: '/api/powerchat/oauth' });
        if (!stateData) return send({ ok: false, error: 'OAuth session expired — please try again.' });
        if (!code || state !== stateData.nonce) return send({ ok: false, error: 'Invalid OAuth response (state mismatch).' });

        const tokens = await oauth.exchangeCode(String(code), stateData.codeVerifier);
        const userId = stateData.userId;

        // Identity comes from the token response's `streamer` field (the documented source);
        // the access token itself is opaque and must not be parsed. Fall back to the JWT
        // claim only if `streamer` is somehow absent, then to the sandbox username.
        const ident = (tokens.streamer && (tokens.streamer.username || tokens.streamer.id))
            ? { username: tokens.streamer.username || null, id: tokens.streamer.id != null ? String(tokens.streamer.id) : null }
            : oauth.identityFromToken(tokens.access_token);
        let username = ident.username || stateData.username || oauth.getConfig().sandboxUsername;

        // Store the grant first (so getValidAccessToken works), then confirm via profile.
        db.upsertPowerchatConnection(userId, {
            powerchat_username: username,
            powerchat_user_id: ident.id || null,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            token_expires_at: tokens.token_expires_at,
            scope: tokens.scope,
            last_error: null,
        });
        // Best-effort profile fetch to confirm identity + capture the canonical username +
        // tip page URL (authoritative over the JWT claim).
        try {
            const prof = await oauth.fetchProfile(userId, username);
            // Every 2xx REST body is wrapped as { data: <payload> }.
            const p = (prof && prof.data) || prof.profile || prof;
            db.upsertPowerchatConnection(userId, {
                powerchat_username: p.username || username,
                powerchat_user_id: (p.id != null ? String(p.id) : ident.id) || null,
                tip_page_url: p.tipPageUrl || p.tip_page_url || null,
            });
            if (p.username) username = p.username;
        } catch (e) {
            console.warn('[PowerChat] profile fetch after connect failed:', e.message);
        }
        res.set('Content-Type', 'text/html').send(resultPage({ ok: true, username }));
    } catch (err) {
        console.error('[PowerChat] OAuth callback error:', err.message);
        send({ ok: false, error: err.message || 'Connection failed' });
    }
});

// ── DELETE /oauth/connection ─────────────────────────────────────────────────
router.delete('/oauth/connection', requireAuth, async (req, res) => {
    try {
        const conn = db.getPowerchatConnection(req.user.id);
        if (conn) {
            if (conn.refresh_token) await oauth.revokeToken(conn.refresh_token);
            else if (conn.access_token) await oauth.revokeToken(conn.access_token);
            db.deletePowerchatConnection(req.user.id);
        }
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to disconnect' });
    }
});

// ── GET /tip-link — attribution deep link into the streamer's tip page ────────
// ?ref=<opaque>  or  ?goal_id=<id>  → app_ref="goal:<id>" so donation webhooks echo it.
router.get('/tip-link', requireAuth, (req, res) => {
    try {
        const cfg = oauth.getConfig();
        const conn = db.getPowerchatConnection(req.user.id);
        if (!conn || !conn.powerchat_username) return res.status(404).json({ error: 'PowerChat not connected' });
        let ref = req.query.ref ? String(req.query.ref) : '';
        if (!ref && req.query.goal_id) ref = `goal:${parseInt(req.query.goal_id, 10)}`;
        const params = new URLSearchParams({ app_client_id: cfg.clientId });
        if (ref) params.set('app_ref', ref);
        const url = `${cfg.baseUrl}/${encodeURIComponent(conn.powerchat_username)}/tip?${params.toString()}`;
        res.json({ url, tip_page_url: conn.tip_page_url || `${cfg.baseUrl}/${conn.powerchat_username}/tip` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to build tip link' });
    }
});

// ── GET /donate-link — DIRECT PowerChat tip link (viewer-facing) ──────────────
// ?streamer=<username> or ?streamer_id=<id>, optional &goal_id. Only streamers with
// their OWN PowerChat connected get a link — money goes to them directly, their
// webhook fires the celebration, the site never mints anything. Streamers without
// PowerChat 404 here: viewers buy Vibes instead (Buy Vibes modal, any channel) and
// donate from their balance.
router.get('/donate-link', optionalAuth, (req, res) => {
    try {
        const streamer = req.query.streamer_id
            ? db.getUserById(parseInt(req.query.streamer_id, 10))
            : db.getUserByUsername(String(req.query.streamer || ''));
        if (!streamer) return res.status(404).json({ error: 'Streamer not found' });

        // Optional goal pick — rides in app_purpose ("goal:<id>") so the streamer's
        // webhook credits that exact goal.
        let goalId = null;
        if (req.query.goal_id) {
            const g = db.getDonationGoalById(parseInt(req.query.goal_id, 10));
            if (g && Number(g.user_id) === Number(streamer.id) && g.is_active) goalId = g.id;
        }

        const direct = require('./powerchat-checkout').buildDonateLink(streamer.id, req.user ? req.user.id : null, { goalId });
        if (!direct) return res.status(404).json({ error: 'This channel does not take PowerChat tips directly', direct: false });
        res.json({ url: direct.url, mode: 'direct', goal_id: goalId });
    } catch (err) {
        res.status(500).json({ error: 'Failed to build tip link' });
    }
});

// ── POST /test-tip — simulate a tip through the LOCAL pipeline (no PowerChat call) ─
// The most useful test: confirms the streamer's alert sound + chat celebration render.
router.post('/test-tip', requireAuth, async (req, res) => {
    try {
        const amount = Math.max(1, Math.min(999, parseInt(req.body.amount, 10) || 5));
        const donor = req.user.display_name || req.user.username || 'Test Tipper';
        const r = webhook.simulateDonation(req.user.id, { amountUsd: amount, donor, message: 'Test tip — this is what a real PowerChat tip looks like ✨' });
        // Also render it on the streamer's actual PowerChat overlay (display-only custom
        // alert) when connected, so the test shows up on PowerChat too — not just here.
        let powerchat = false;
        try { powerchat = await require('./powerchat-platform').sendCustomAlert(req.user.id, { actorName: donor, message: 'Test tip from OpenVibe.Live ✨', amountCents: amount * 100 }); } catch { /* */ }
        res.json({ ok: true, powerchat, ...r });
    } catch (err) {
        res.status(500).json({ error: 'Test tip failed' });
    }
});

// ── POST /test-alert — fire a fake event of any kind on the PowerChat overlay ─────────
// body: { kind } — so the streamer can verify each part of the integration end to end.
//
// Two transports, chosen per kind:
//  - tip/subscribe/follow/channel_points/host → PowerChat's /test-alerts endpoint
//    (alerts:trigger). Purpose-built for this: display-only, attributed to the app,
//    never credits goals/subathon/leaderboards. Body is a discriminated union — `kind`
//    at the top level, kind-specific fields nested under `payload` (strict validation
//    rejects loose top-level fields). App calls may not use the view-count/emote-wall
//    kinds (rejected), which is why those go through the real intake below.
//  - chat → the REAL POST /chat intake (chat:write): a test line through the actual
//    moderation pipeline into the unified chat overlay — harmless, and the truest test.
//  - view-count → the REAL POST /view-count intake (viewcount:write): the branded chip
//    appears with the streamer's live count (or 42 when offline); PowerChat's ~90s
//    freshness sweep clears a test push on its own.
const TEST_KINDS = {
    tip:            { scope: 'alerts:trigger',  note: 'A tip alert should appear on your PowerChat overlay now.' },
    subscribe:      { scope: 'alerts:trigger',  note: 'A subscription alert should appear on your PowerChat overlay now.' },
    follow:         { scope: 'alerts:trigger',  note: 'A follow alert should appear on your PowerChat overlay now.' },
    channel_points: { scope: 'alerts:trigger',  note: 'A channel-points redeem alert should appear on your PowerChat overlay now.' },
    host:           { scope: 'alerts:trigger',  note: 'A host alert should appear on your PowerChat overlay now.' },
    chat:           { scope: 'chat:write',      note: 'A test message should appear in your PowerChat unified chat overlay now.' },
    'view-count':   { scope: 'viewcount:write', note: 'The OpenVibe.Live viewer chip should appear on PowerChat now (a test push clears itself within ~90s).' },
};
router.post('/test-alert', requireAuth, async (req, res) => {
    const kind = String((req.body && req.body.kind) || 'tip');
    const spec = TEST_KINDS[kind];
    if (!spec) return res.status(400).json({ error: `Unknown test kind "${kind}"` });
    const actorName = String(req.user.display_name || req.user.username || 'Test').slice(0, 48);
    try {
        if (kind === 'chat') {
            await oauth.apiRequest(req.user.id, {
                method: 'POST', path: '/chat',
                body: {
                    chatterName: actorName,
                    externalChatterId: `test-u${req.user.id}`,
                    message: 'Test message from OpenVibe.Live — your chat relay works ✨',
                    messageId: `test-${crypto.randomUUID()}`,
                },
            });
        } else if (kind === 'view-count') {
            // Push the real live count when there is one, so the chip shows the truth;
            // 42 is the recognizable stand-in when testing while offline.
            let live = [];
            try { live = db.getLiveStreamsByUserId(req.user.id) || []; } catch { /* */ }
            const count = live.length ? live.reduce((a, s) => a + (s.viewer_count || 0), 0) : 42;
            await oauth.apiRequest(req.user.id, { method: 'POST', path: '/view-count', body: { count } });
        } else {
            const payloads = {
                tip: { amountCents: 500, currency: 'usd', tipperName: actorName, message: 'Test tip alert from OpenVibe.Live ✨' },
                subscribe: { subscriberName: actorName, tier: '1' },
                follow: { followerName: actorName },
                channel_points: { redeemerName: actorName, rewardName: 'Test Reward', rewardCost: 500, userInput: 'Test redeem from OpenVibe.Live ✨' },
                host: { fromChannel: actorName, viewers: 42 },
            };
            await oauth.apiRequest(req.user.id, {
                method: 'POST', path: '/test-alerts', idempotent: false,
                body: { kind, payload: payloads[kind] },
            });
        }
        res.json({ ok: true, kind, note: spec.note });
    } catch (err) {
        // Missing scope → tell the user to reconnect to grant it (friendly, actionable).
        if (err.status === 403) {
            return res.status(403).json({ error: 'reconnect_required', message: `Reconnect your PowerChat account to enable this test (it needs the "${spec.scope}" permission).` });
        }
        res.status(502).json({ error: err.message });
    }
});

// ── GET /authorize-url — the OAuth start URL, for a manual copy/paste fallback ─
router.get('/authorize-url', requireAuth, (req, res) => {
    res.json({ url: `${String(config.baseUrl).replace(/\/+$/, '')}/api/powerchat/oauth/start` });
});

// ── POST /webhook — signed event receiver ────────────────────────────────────
// No auth middleware: authenticity is the HMAC signature. Ack fast, process async.
router.post('/webhook', (req, res) => {
    try {
        const raw = req.rawBody || (req.body ? Buffer.from(JSON.stringify(req.body)) : Buffer.alloc(0));
        const check = webhook.verifySignature(raw, req.headers);
        if (!check.ok) {
            console.warn('[PowerChat] webhook rejected:', check.reason);
            return res.status(401).json({ error: 'invalid signature' });
        }
        const deliveryId = req.headers['x-powerchat-delivery-id'] || null;
        const eventType = req.headers['x-powerchat-event-type'] || (req.body && req.body.type) || null;

        // Dedupe at-least-once deliveries.
        if (deliveryId && !db.powerchatDeliveryIsNew(deliveryId, eventType)) {
            return res.status(200).json({ ok: true, deduped: true });
        }

        // Ack immediately; process off the response path.
        res.status(200).json({ ok: true });
        const envelope = req.body && typeof req.body === 'object' ? req.body : (() => { try { return JSON.parse(raw.toString('utf8')); } catch { return null; } })();
        setImmediate(() => { try { if (envelope) webhook.processEvent(envelope); } catch (e) { console.warn('[PowerChat] webhook process error:', e.message); } });
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: 'webhook error' });
    }
});

module.exports = router;
