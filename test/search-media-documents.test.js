'use strict';
// Live's VOD and clip pages in OpenVibe.Search (WS-O task 10, Contracts 0.45.0): a public, ready VOD goes
// through the outbox as live.index_document.upserted type vod (valid against the contract, canonical on
// Live, with Live's AI overview and transcript), again only when it changed; a recording VOD is never
// sent; a VOD made private gets one tombstone; an AI clip and a clip of an NSFW stream are noindex; a 404
// is a deletion; the daily refresh removes what Media stopped listing, but never after a partial listing;
// a change through /api/vods is re-checked right after it succeeds.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-searchmedia-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.LIVE_SEARCH_TOUCH_DELAY_MS = '10';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const published = [];
const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
        if (req.url === '/api/v1/events' && req.method === 'POST') {
            const parsed = JSON.parse(body);
            const list = parsed.events || [parsed];
            const { validate } = require('openvibe-contracts');
            const bad = list.find((e) => !validate('events.event-envelope@1', e).valid);
            if (bad) { res.statusCode = 422; return res.end(JSON.stringify({ code: 'events.invalid_envelope' })); }
            const results = list.map((e) => { published.push(e); return { event_id: e.event_id, seq: published.length, duplicate: false }; });
            return res.end(JSON.stringify(parsed.events ? { results } : results[0]));
        }
        res.statusCode = 404; res.end('{}');
    });
});

// Media as Live's service sees it: listings hold public items only; get returns any of Live's.
const items = { vod: new Map(), clip: new Map() };
let listFails = false;
const notFound = () => Object.assign(new Error('not found'), { status: 404 });
const media = {
    async listVods({ limit, offset }) { if (listFails) throw new Error('Media unreachable'); const all = [...items.vod.values()].filter((v) => v.visibility === 'public' && !v.is_recording); return { vods: all.slice(offset, offset + limit), hasMore: offset + limit < all.length }; },
    async listClips({ limit, offset }) { if (listFails) throw new Error('Media unreachable'); const all = [...items.clip.values()].filter((c) => c.visibility === 'public'); return { clips: all.slice(offset, offset + limit), hasMore: offset + limit < all.length }; },
    async getVod(id) { const v = items.vod.get(Number(id)); if (!v) throw notFound(); return v; },
    async getClip(id) { const c = items.clip.get(Number(id)); if (!c) throw notFound(); return c; },
};
const vod = (id, extra = {}) => ({ id, app_id: 'live', user_id: 1, stream_id: 1, title: 'Building a forum', description: '', status: 'ready', visibility: 'public', is_public: true, is_recording: false, clips_only: false, duration_seconds: 5400, created_at: '2026-09-24 19:00:00', readiness: { playable: true }, ...extra });

(async () => {
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${stub.address().port}`;
    process.env.OV_NETWORK_INTERNAL_URL = base;
    const { validate } = require('openvibe-contracts');
    const db = require('../server/db/database');
    db.initDb();
    const d = db.getDb();
    d.prepare("INSERT INTO users (id, username, display_name, password_hash) VALUES (1, 'alex', 'Alex', 'x'), (2, 'viewer', 'Viewer', 'x')").run();
    const s1 = db.createStream({ user_id: 1, title: 'Building a forum', category: 'tech', protocol: 'webrtc', is_nsfw: 0 }).lastInsertRowid;
    const s2 = db.createStream({ user_id: 1, title: 'Late night', category: 'irl', protocol: 'webrtc', is_nsfw: 1 }).lastInsertRowid;
    const streamEvents = require('../server/events/stream-events');
    const outbox = streamEvents.init({ eventsUrl: base, clientSecret: 's3cret', intervalMs: 50 });
    const docs = require('../server/events/search-media-documents');
    docs._setMedia(media);
    const index = () => published.filter((e) => /^live\.index_document\./.test(e.event_type));
    const valid = (ev) => { const v = validate(ev.event_type + '@1', ev.payload); assert.ok(v.valid, `${ev.event_type}: ${JSON.stringify(v.errors)}`); };

    // A public, ready VOD with Live's AI overview and transcript.
    items.vod.set(912, vod(912, { stream_id: s1 }));
    db.setVodAiOverview(912, 'Alex builds the rating menu of the forum and fixes it on phones.');
    d.prepare('UPDATE vod_ai_state SET ai_transcript_json = ? WHERE vod_id = 912').run(JSON.stringify([{ text: 'okay so today' }, { text: 'we are building the forum' }]));
    items.vod.set(913, vod(913, { is_recording: true, status: 'recording' }));
    assert.strictEqual(await docs.scan(), 1);
    assert.strictEqual(await docs.touch('vod', 913), 'unchanged', 'a recording is never sent');
    await outbox.flush();
    let ev = index()[0];
    assert.strictEqual(ev.event_type, 'live.index_document.upserted'); valid(ev);
    assert.deepStrictEqual(ev.subject, { type: 'vod', id: '912', revision: 1 });
    assert.strictEqual(ev.payload.canonical_url, 'https://openvibe.live/vod/912');
    assert.ok(ev.payload.summary.startsWith('Alex builds the rating menu'));
    assert.ok(ev.payload.body.includes('we are building the forum'), 'the transcript is searchable');
    assert.deepStrictEqual(ev.payload.facets, { duration_seconds: 5400, channel: 'alex', category: 'tech' });
    assert.strictEqual(ev.payload.indexability.decision, 'index');
    assert.strictEqual(docs.publish('vod', 912, items.vod.get(912)), 'unchanged', 'nothing changed: nothing sent');

    // An AI clip, and a person's clip of an NSFW stream.
    items.clip.set(3107, { id: 3107, app_id: 'live', vod_id: 912, stream_id: s1, channel_user_id: 1, user_id: null, title: 'Chat erupts', status: 'ready', visibility: 'public', is_public: true, auto_generated: true, duration_seconds: 30, created_at: '2026-09-24 21:00:00' });
    items.clip.set(3108, { id: 3108, app_id: 'live', vod_id: null, stream_id: s2, channel_user_id: 1, user_id: 2, title: '', status: 'ready', visibility: 'public', is_public: true, auto_generated: false, duration_seconds: 12, created_at: '2026-09-25 01:00:00' });
    assert.strictEqual(await docs.touch('clip', 3107), 'sent');
    assert.strictEqual(await docs.touch('clip', 3108), 'sent');
    await outbox.flush();
    const [ai, nsfw] = index().slice(1, 3);
    valid(ai); valid(nsfw);
    assert.strictEqual(ai.payload.authorship, 'ai_generated');
    assert.deepStrictEqual(ai.payload.indexability, { decision: 'noindex', reasons: ['ai_unreviewed'] });
    assert.strictEqual(ai.payload.facets.vod_id, '912'); assert.strictEqual(ai.payload.facets.ai_clip, true);
    assert.strictEqual(nsfw.payload.title, 'Clip'); assert.strictEqual(nsfw.payload.authorship, 'human');
    assert.deepStrictEqual(nsfw.payload.indexability, { decision: 'noindex', reasons: ['sensitive'] });

    // Made private: one tombstone.
    items.vod.set(912, vod(912, { stream_id: s1, visibility: 'private', is_public: false }));
    assert.strictEqual(await docs.touch('vod', 912), 'tombstone');
    assert.strictEqual(await docs.touch('vod', 912), 'unchanged', 'a tombstone is sent once');
    await outbox.flush();
    ev = index()[3];
    assert.strictEqual(ev.event_type, 'live.index_document.deleted'); valid(ev);
    assert.deepStrictEqual(ev.payload, { type: 'vod', id: '912', revision: 2 });

    // Deleted on Media: a 404 is a deletion. A failed read changes nothing.
    const realGet = media.getClip;
    media.getClip = async () => { throw Object.assign(new Error('Media timed out'), { status: 0 }); };
    assert.strictEqual(await docs.touch('clip', 3108), 'skipped', 'Media unreachable: nothing removed');
    media.getClip = realGet;
    items.clip.delete(3108);
    assert.strictEqual(await docs.touch('clip', 3108), 'tombstone');

    // The daily refresh: a partial listing removes nothing; a complete one removes what Media stopped listing.
    items.clip.get(3107).visibility = 'unlisted';
    listFails = true;
    await docs.refresh();
    assert.strictEqual(d.prepare("SELECT deleted FROM search_media_pushes WHERE kind = 'clip' AND media_id = 3107").get().deleted, 0);
    listFails = false;
    await docs.refresh();
    assert.strictEqual(d.prepare("SELECT deleted FROM search_media_pushes WHERE kind = 'clip' AND media_id = 3107").get().deleted, 1, 'unlisted: removed');

    // A successful change through /api/vods is re-checked; a failed one is not.
    items.vod.set(912, vod(912, { stream_id: s1 }));
    const call = (method, p, status, body) => {
        const res = new EventEmitter(); res.statusCode = status;
        docs.afterChange('vod')({ method, path: p, body }, res, () => {});
        res.emit('finish');
    };
    call('PUT', '/912', 403);
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(d.prepare("SELECT deleted FROM search_media_pushes WHERE kind = 'vod' AND media_id = 912").get().deleted, 1, 'a refused change is not followed');
    call('POST', '/bulk', 200, { ids: [912], action: 'public' });
    await new Promise((r) => setTimeout(r, 60));
    const row = d.prepare("SELECT deleted, revision FROM search_media_pushes WHERE kind = 'vod' AND media_id = 912").get();
    assert.deepStrictEqual(row, { deleted: 0, revision: 3 }, 'made public again: sent at the next revision');

    outbox.stop && outbox.stop();
    stub.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    quiet('search media documents: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
