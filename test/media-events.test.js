'use strict';

// Media outcomes over OpenVibe.Events (roadmap Wave 3 exit). The same completion reaches Live as a
// signed Media webhook (/internal/media-webhook) and as a signed Events delivery
// (/internal/media-events); it is applied exactly once whichever arrives first (inbox receipt keyed
// by Media object + event id), and MEDIA_EVENTS_AUTHORITY=webhook|both|events decides which path
// acts. Events deliveries need signature v2; other tenants' VODs and non-Media events are ignored.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-events-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.MEDIA_WEBHOOK_SECRET = 'w'.repeat(40);
process.env.MEDIA_EVENTS_SECRET = 'e'.repeat(64);
process.env.MEDIA_APP_ID = 'live';
delete process.env.MEDIA_EVENTS_AUTHORITY;
delete process.env.OPS_ALERT_WEBHOOK_URL;

let seq = 0;
const newEventId = () => {
    const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let s = '';
    for (let i = 0; i < 26; i++) s += A[crypto.randomInt(32)];
    seq++;
    return `evt_${s}`;
};

(async () => {
    const express = require('express');
    const db = require('../server/db/database');
    db.initDb();
    const outcomes = require('../server/media-proxy/outcomes');
    const { signDelivery, signDeliveryHeaders } = require('openvibe-sdk/events');

    // Count Live's writes per outcome: a second application would show up here.
    const calls = { vod: [], clip: [] };
    const realVod = db.setVodTranscriptStatus;
    const realClip = db.setClipTranscriptStatus;
    db.setVodTranscriptStatus = (id, status, ...rest) => { calls.vod.push([id, status]); return realVod(id, status, ...rest); };
    db.setClipTranscriptStatus = (id, status, ...rest) => { calls.clip.push([id, status]); return realClip(id, status, ...rest); };
    const origError = console.error;
    const storageLines = [];
    console.error = (...a) => { if (String(a[0]).includes('STORAGE ALERT')) storageLines.push(a.join(' ')); else origError(...a); };

    const app = express();
    app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.post('/internal/media-webhook', require('../server/media-proxy/webhook'));
    app.post('/internal/media-events', require('../server/media-proxy/media-events').handler);
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    // Media's two copies of one outcome (server/webhooks.js announce + server/events.js record).
    const outcome = (event, data, eventId = newEventId()) => {
        const type = event.startsWith('storage.') ? 'storage' : event.split('.')[0];
        const id = type === 'storage' ? data.kind : String(data.id);
        return {
            eventId,
            webhook: { event, app_id: data.app_id === undefined ? 'live' : data.app_id, data, ...(eventId ? { event_id: eventId } : {}) },
            envelope: {
                event_id: eventId, event_type: `media.${event}`, version: 1, source: 'media', actor: { type: 'service', id: 'media' },
                timestamp: new Date().toISOString(), priority: 'important', visibility: 'internal', subject: { type, id },
                payload: { app_id: data.app_id === undefined ? 'live' : data.app_id, ...data },
            },
        };
    };
    const postWebhook = async (body, { secret = process.env.MEDIA_WEBHOOK_SECRET } = {}) => {
        const raw = JSON.stringify(body);
        const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
        const res = await fetch(`${base}/internal/media-webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OVMedia-Signature': sig }, body: raw });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const postEvent = async (envelope, { v1Only = false, secret = process.env.MEDIA_EVENTS_SECRET } = {}) => {
        const raw = JSON.stringify({ event: envelope, seq: ++seq, subscription_id: 'sub_media' });
        const headers = v1Only ? { 'X-OpenVibe-Signature': signDelivery(raw, secret) } : signDeliveryHeaders(raw, secret);
        const res = await fetch(`${base}/internal/media-events`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw });
        return { status: res.status };
    };
    const receipts = () => db.getDb().prepare('SELECT event_id FROM idempotency_receipts WHERE consumer = ?').all(outcomes.CONSUMER).map(r => r.event_id);

    // ── authority=webhook (default): the webhook acts; Events deliveries are acknowledged, dropped.
    assert.strictEqual(outcomes.authority(), 'webhook');
    const a = outcome('vod.ready', { id: 101, stream_id: null, duration: 60 });
    assert.deepStrictEqual((await postWebhook(a.webhook)).body, { ok: true });
    assert.deepStrictEqual(calls.vod, [[101, 'pending']]);
    assert.deepStrictEqual(receipts(), [`media:vod:101:${a.eventId}`], 'the webhook claims the receipt');
    assert.strictEqual((await postEvent(a.envelope)).status, 204);
    const b = outcome('vod.ready', { id: 102 });
    assert.strictEqual((await postEvent(b.envelope)).status, 204);
    assert.deepStrictEqual(calls.vod, [[101, 'pending']], 'events do not act under webhook authority');

    // ── authority=both: whichever copy arrives first acts; the other is a no-op.
    process.env.MEDIA_EVENTS_AUTHORITY = 'both';
    assert.strictEqual((await postEvent(a.envelope)).status, 204, 'the Events copy of an outcome the webhook applied');
    assert.deepStrictEqual(calls.vod, [[101, 'pending']], 'applied once');
    const c = outcome('clip.ready', { id: 7, stream_id: null });
    assert.strictEqual((await postEvent(c.envelope)).status, 204);
    assert.deepStrictEqual(calls.clip, [[7, 'pending']]);
    assert.deepStrictEqual((await postWebhook(c.webhook)).body, { ok: true, duplicate: true }, 'the webhook copy after Events');
    assert.deepStrictEqual(calls.clip, [[7, 'pending']], 'applied once');
    assert.strictEqual((await postEvent(c.envelope)).status, 204, 'an Events redelivery');
    assert.deepStrictEqual(calls.clip, [[7, 'pending']]);
    // A later outcome for the same clip (retry failed, then succeeded) is a new event and applies.
    const c2 = outcome('clip.failed', { id: 7, error: 'cut failed' });
    await postWebhook(c2.webhook);
    await postEvent(c2.envelope);
    assert.deepStrictEqual(calls.clip, [[7, 'pending'], [7, 'failed']]);

    // ── authority=events: Events acts; a webhook with an event_id is only acknowledged.
    process.env.MEDIA_EVENTS_AUTHORITY = 'events';
    const d = outcome('vod.failed', { id: 103, error: 'short' });
    assert.deepStrictEqual((await postWebhook(d.webhook)).body, { ok: true, ignored: 'events_authority' });
    assert.ok(!calls.vod.some(([id]) => id === 103), 'the webhook did not act');
    assert.strictEqual((await postEvent(d.envelope)).status, 204);
    assert.deepStrictEqual(calls.vod.filter(([id]) => id === 103), [[103, 'failed']]);
    // A webhook without event_id (a Media whose outbox is off) has no durable twin: it still acts.
    const e = outcome('vod.ready', { id: 104 }, null);
    assert.deepStrictEqual((await postWebhook(e.webhook)).body, { ok: true });
    assert.deepStrictEqual(calls.vod.filter(([id]) => id === 104), [[104, 'pending']]);

    // Storage alerts are service-wide (app_id null) and apply from Events.
    const s = outcome('storage.alert', { kind: 'disk_critical', app_id: null, disk_pct: 97, free_gb: 3 });
    assert.strictEqual((await postEvent(s.envelope)).status, 204);
    assert.strictEqual(storageLines.length, 1);
    assert.match(storageLines[0], /disk_critical/);
    assert.ok(receipts().includes(`media:storage:disk_critical:${s.eventId}`));

    // ── What Live ignores (acknowledged, never applied, never retried).
    const before = JSON.stringify(calls);
    const other = outcome('vod.ready', { id: 900, app_id: 'tools' });
    assert.strictEqual((await postEvent(other.envelope)).status, 204, 'another tenant');
    const upload = outcome('object.uploaded', { id: 'med_01J0000000000000000000000Z' });
    upload.envelope.event_type = 'media.object.uploaded';
    assert.strictEqual((await postEvent(upload.envelope)).status, 204, 'object uploads');
    const foreign = outcome('vod.ready', { id: 901 });
    foreign.envelope.source = 'tools';
    assert.strictEqual((await postEvent(foreign.envelope)).status, 204, 'not from Media');
    assert.strictEqual(JSON.stringify(calls), before);

    // ── Signatures.
    const f = outcome('vod.ready', { id: 105 });
    assert.strictEqual((await postEvent(f.envelope, { v1Only: true })).status, 401, 'v1-only deliveries are refused');
    assert.strictEqual((await postEvent(f.envelope, { secret: 'x'.repeat(64) })).status, 401);
    assert.strictEqual((await postWebhook(f.webhook, { secret: 'nope' })).status, 401);
    delete process.env.MEDIA_EVENTS_SECRET;
    assert.strictEqual((await postEvent(f.envelope)).status, 503, 'no secret, no endpoint');
    assert.ok(!calls.vod.some(([id]) => id === 105));

    const st = outcomes.status();
    assert.strictEqual(st.authority, 'events');
    assert.ok(st.applied.webhook >= 2 && st.applied.events >= 3 && st.duplicate.webhook === 1 && st.duplicate.events >= 2);

    db.setVodTranscriptStatus = realVod;
    db.setClipTranscriptStatus = realClip;
    console.error = origError;
    server.close();
    console.log('media events: webhook ⇄ Events transition, applied once per outcome, authority switch, v2 signatures, tenant filter — all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
