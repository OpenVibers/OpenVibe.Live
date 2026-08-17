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
const router = express.Router();
const db = require('../db/database');
const config = require('../config');
const { requireAuth } = require('../auth/auth');
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
router.get('/status', requireAuth, (req, res) => {
    try {
        const cfg = oauth.getConfig();
        const conn = db.getPowerchatConnection(req.user.id);
        const connected = !!(conn && conn.access_token);
        // Distinguish a real OAuth app connection (mints refresh tokens) from a
        // sandbox self-connect (no tokens) so the card can say which it is.
        const connection_kind = connected ? (conn.refresh_token ? 'app' : 'testing') : null;
        const scopes = conn && conn.scope ? String(conn.scope).split(/\s+/).filter(Boolean) : [];
        res.json({
            enabled: cfg.enabled,
            configured: oauth.isConfigured(),
            connected,
            connection_kind,
            username: conn ? conn.powerchat_username : null,
            tip_page_url: conn ? conn.tip_page_url : null,
            scope: conn ? conn.scope : null,
            scopes,
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

// ── POST /test-alert — fire PowerChat's own overlay test-alert (needs alerts:trigger) ─
// /test-alerts requires a `kind` discriminator (tip|subscribe|follow|host|emote-wall|
// view-count|channel_points) + kind-specific fields; an empty body 400s.
router.post('/test-alert', requireAuth, async (req, res) => {
    try {
        const actorName = req.user.display_name || req.user.username || 'Test';
        await oauth.apiRequest(req.user.id, {
            method: 'POST', path: '/test-alerts',
            body: { kind: 'tip', actorName, amountCents: 500, message: 'Test overlay alert from OpenVibe.Live ✨' },
        });
        res.json({ ok: true });
    } catch (err) {
        // Missing scope → tell the user to reconnect to grant it (friendly, actionable).
        if (err.status === 403 && /alerts:trigger/i.test(err.message || '')) {
            return res.status(403).json({ error: 'reconnect_required', message: 'Reconnect your PowerChat account to enable overlay test alerts (the "trigger alerts" permission was added).' });
        }
        res.status(err.status === 403 ? 403 : 502).json({ error: err.message });
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
