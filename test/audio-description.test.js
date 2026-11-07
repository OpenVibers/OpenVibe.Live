'use strict';
/**
 * Audio description (X1, consent plan 2026-10-31, "AI and data"): Live's scene notes become a WebVTT
 * `kind="descriptions"` track, timed into the silences between speech. Public and link VODs/clips are
 * described for anyone; a private one only answers its owner (server/ai/descriptions.js + the routes in
 * media-proxy/vods.js and clips.js). The AI's text may describe people; it never describes sex acts, and a
 * video with an explicit scene note gets no track at all (server/ai/explicit.js).
 *
 *   node test/audio-description.test.js
 */
const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const VODS = {
    100: { id: 100, app_id: 'live', user_id: 3, stream_id: 500, title: 'Public VOD', visibility: 'public', is_public: 1, status: 'ready', duration_seconds: 60 },
    101: { id: 101, app_id: 'live', user_id: 3, stream_id: 500, title: 'Private VOD', visibility: 'private', is_public: 0, status: 'ready', duration_seconds: 60 },
    102: { id: 102, app_id: 'live', user_id: 3, stream_id: 501, title: 'Explicit VOD', visibility: 'public', is_public: 1, status: 'ready', duration_seconds: 30 },
    103: { id: 103, app_id: 'games', user_id: 3, stream_id: 500, title: 'Another app', visibility: 'public', is_public: 1, status: 'ready', duration_seconds: 60 },
};
const CLIPS = {
    200: { id: 200, app_id: 'live', user_id: 3, stream_id: 500, vod_id: 100, title: 'Public clip', visibility: 'public', is_public: 1, status: 'ready', start_time: 3, end_time: 15, duration_seconds: 12 },
    201: { id: 201, app_id: 'live', user_id: 3, stream_id: 500, vod_id: 100, title: 'Private clip', visibility: 'private', is_public: 0, status: 'ready', start_time: 3, end_time: 15, duration_seconds: 12 },
};

function cuesOf(vtt) {
    const out = [];
    const re = /(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})\n([^\n]+)/g;
    let m;
    const sec = (t) => {
        const [h, mm, rest] = t.split(':');
        const [s, ms] = rest.split('.');
        return Number(h) * 3600 + Number(mm) * 60 + Number(s) + Number(ms) / 1000;
    };
    while ((m = re.exec(vtt))) out.push({ start: sec(m[1]), end: sec(m[2]), text: m[3] });
    return out;
}

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    // Fixed ids: the Media stubs below name them, and the person the owner check expects.
    await raw.prepare(`INSERT INTO users (id, username, display_name, stream_key) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?)`)
        .run(3, 'alice', 'alice', 'a'.repeat(32));
    await raw.prepare(`INSERT INTO users (id, username, display_name, stream_key) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?)`)
        .run(4, 'bob', 'bob', 'b'.repeat(32));
    const alice = 3;
    for (const [id, title] of [[500, 'Described stream'], [501, 'Explicit stream']]) {
        await raw.prepare(`INSERT INTO streams (id, user_id, title, category, protocol, is_live, started_at) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, 'irl', 'rtmp', 1, ov_now())`)
            .run(id, alice, title);
    }
    const s500 = 500, s501 = 501;

    // Scene notes: one in a gap, one during speech, and an explicit note on another stream.
    await db.addStreamMemory({ stream_id: s500, user_id: alice, offset_seconds: 5, description: 'A person in a red coat opens a blue door.' });
    await db.addStreamMemory({ stream_id: s500, user_id: alice, offset_seconds: 9, description: 'A dog sleeps on the sofa.' });
    await db.addStreamMemory({ stream_id: s501, user_id: alice, offset_seconds: 5, description: 'A person waves at the camera.' });
    await db.addStreamMemory({ stream_id: s501, user_id: alice, offset_seconds: 12, description: 'The streamer is having sex on camera.' });
    await db.addTimelineEvents([
        { stream_id: s500, user_id: alice, vod_id: 100, kind: 'speech', start_sec: 0, end_sec: 4, text: 'Hello and welcome.' },
        { stream_id: s500, user_id: alice, vod_id: 100, kind: 'speech', start_sec: 8, end_sec: 12, text: 'Today we build a table.' },
    ]);

    // ── The cue builder on its own: gaps, no overlap, dedupe, and the explicit fail-closed rule ──
    const { cueList, buildVtt, gapStart } = require('../server/ai/descriptions');
    const speech = [{ start: 0, end: 4 }, { start: 8, end: 12 }];
    const list = cueList([
        { at: 5, text: 'A person in a red coat opens a blue door.' },
        { at: 9, text: 'A dog sleeps on the sofa.' },
        { at: 5, text: 'A person in a red coat opens a blue door.' },
    ], speech, 60);
    assert.strictEqual(list.length, 2, 'a repeated note becomes one cue');
    for (const cue of list) {
        assert.ok(cue.end > cue.start, 'a cue has duration');
        for (const s of speech) {
            assert.ok(cue.end <= s.start + 0.001 || cue.start >= s.end - 0.001, `cue "${cue.text}" does not overlap speech ${s.start}-${s.end}`);
        }
    }
    assert.ok(list.find((c) => /dog/.test(c.text)).start >= 12.3, 'a note during speech waits for the next silence');
    assert.ok(gapStart(5, 3, speech, 60) != null, 'a gap can be found at the note');
    assert.ok(buildVtt(list).startsWith('WEBVTT\n'), 'WebVTT header');
    assert.deepStrictEqual(cueList([{ at: 5, text: 'A person waves.' }, { at: 12, text: 'sexual acts on camera' }], speech, 60), [], 'one explicit note means no track');
    assert.deepStrictEqual(cueList([{ at: 5, text: 'A nude figure drawing session.' }], speech, 60).length, 1, 'nudity is art, not explicit');

    // ── The routes, with Media stubbed ──
    const media = require('../server/media-client');
    const notFound = (what) => new media.MediaApiError(`${what} not found`, 404, { error: `${what} not found` });
    media.getVod = async (id) => { const v = VODS[Number(id)]; if (!v) throw notFound('VOD'); return { ...v }; };
    media.getClip = async (id) => { const c = CLIPS[Number(id)]; if (!c) throw notFound('Clip'); return { ...c }; };

    const express = require('express');
    const app = express();
    // optionalAuth leaves an already-present req.user alone; this stands in for a signed-in Live session.
    app.use((req, res, next) => {
        const as = req.headers['x-test-user'];
        if (as) req.user = { id: Number(as), username: as === '3' ? 'alice' : 'bob', role: 'user' };
        next();
    });
    app.use('/api/vods', require('../server/media-proxy/vods'));
    app.use('/api/clips', require('../server/media-proxy/clips'));
    const server = http.createServer(app).listen(0);
    await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
    const get = (path, headers = {}) => new Promise((resolve, reject) => {
        http.get({ port: server.address().port, path, headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on('error', reject);
    });

    // Public VOD: a descriptions track for anyone.
    const pub = await get('/api/vods/100/descriptions.vtt');
    assert.strictEqual(pub.status, 200);
    assert.match(pub.headers['content-type'], /^text\/vtt/);
    assert.match(pub.headers['cache-control'], /public/);
    const pubCues = cuesOf(pub.body);
    assert.strictEqual(pubCues.length, 2);
    assert.ok(pubCues.some((c) => /red coat/.test(c.text)));
    assert.ok(pubCues.some((c) => /dog/.test(c.text)));
    assert.ok(pubCues.find((c) => /dog/.test(c.text)).start >= 12.3, 'the route keeps the note out of speech');

    // Private VOD: the missing-VOD answer until its owner asks; the owner and nobody else gets the track.
    const privAnon = await get('/api/vods/101/descriptions.vtt');
    assert.strictEqual(privAnon.status, 404, 'a private VOD is not described for a visitor');
    assert.deepStrictEqual(privAnon.body, JSON.stringify({ error: 'VOD not found' }));
    const privOther = await get('/api/vods/101/descriptions.vtt', { 'x-test-user': '4' });
    assert.strictEqual(privOther.status, 404, 'not for another person');
    const privOwner = await get('/api/vods/101/descriptions.vtt', { 'x-test-user': '3' });
    assert.strictEqual(privOwner.status, 200, 'the owner asks and gets it');
    assert.match(privOwner.headers['cache-control'], /private/);

    // A video with an explicit scene note: no track, not even for its owner.
    for (const who of [null, '3']) {
        const r = await get('/api/vods/102/descriptions.vtt', who ? { 'x-test-user': who } : {});
        assert.strictEqual(r.status, 404, 'explicit scenes are never described');
    }

    // Another app's media is not Live's to describe.
    assert.strictEqual((await get('/api/vods/103/descriptions.vtt')).status, 404);

    // A clip: the source notes inside its window, in the clip's own time, between speech.
    const clip = await get('/api/clips/200/descriptions.vtt');
    assert.strictEqual(clip.status, 200);
    const clipCues = cuesOf(clip.body);
    assert.strictEqual(clipCues.length, 2, 'both notes fall inside the clip window');
    assert.ok(clipCues.every((c) => c.end <= 12.001), 'clip cues stay inside the clip');
    assert.ok(clipCues.find((c) => /red coat/.test(c.text)).start <= 2.1, 'a note moves into the clip time');
    assert.strictEqual((await get('/api/clips/201/descriptions.vtt')).status, 404, 'a private clip needs its owner');
    assert.strictEqual((await get('/api/clips/201/descriptions.vtt', { 'x-test-user': '3' })).status, 200);

    server.close();
    console.log('audio description: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
