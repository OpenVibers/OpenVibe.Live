/**
 * Legacy parity (roadmap D20): the broadcaster's "Viewer" preview opens what viewers see.
 *
 * openViewerPreview() (public/js/broadcast.js) opens a popup on the channel page of the stream being
 * broadcast: /@user/<slot>, the page viewers watch it on, through the real player. It used to put
 * `streamData.slug || streamId` in the slot position; the stream row has no `slug`, so it always
 * sent the LIVE STREAM's id, which the channel page resolves as a slot id: the popup showed another
 * slot (or the channel's default) instead of the one on air.
 *
 *   node test/broadcast-viewer-preview.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/** The source of a top-level function declaration, braces matched. */
function extract(src, name) {
    const m = new RegExp(`(?:async )?function ${name}\\(`).exec(src);
    assert.ok(m, `${name}() must exist`);
    let i = src.indexOf('{', m.index);
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}

const bc = read('public/js/broadcast.js');
const appJs = read('public/js/app.js');
const src = [extract(appJs, 'normalizeChannelUsername'), extract(appJs, 'channelPath'), extract(bc, 'openViewerPreview')].join('\n');

/** Runs the page's own openViewerPreview() against a broadcast state; returns what it opened. */
function preview({ user, activeStreamId, streamData }) {
    const opened = [];
    const toasts = [];
    const fixtures = {
        currentUser: user,
        broadcastState: { activeStreamId },
        getStreamState: (id) => (id === activeStreamId && streamData ? { streamData } : null),
        _viewerPreviewWindow: null,
        window: { open: (url, name, features) => { opened.push({ url, name, features }); return { closed: false, focus() {} }; } },
        toast: (msg, kind) => toasts.push([msg, kind]),
    };
    const scope = new Proxy(fixtures, {
        has: (t, k) => typeof k === 'string',
        get: (t, k) => (k === Symbol.unscopables ? undefined : (k in t ? t[k] : globalThis[k])),
        set: (t, k, v) => { t[k] = v; return true; },
    });
    // eslint-disable-next-line no-new-func
    const fn = new Function('scope', `with (scope) { ${src}\n return openViewerPreview; }`)(scope);
    fn();
    return { opened, toasts };
}

// A channel with two slots; the live stream on the "garden" slot happens to have id 1 — which is
// also the "desk" slot's id, exactly the collision the old code walked into.
const alice = { id: 3, username: 'alice' };
const gardenStream = { id: 1, user_id: 3, managed_stream_id: 2, managed_stream_slug: 'garden', protocol: 'webrtc' };

let r = preview({ user: alice, activeStreamId: 1, streamData: gardenStream });
assert.strictEqual(r.opened.length, 1);
assert.strictEqual(r.opened[0].url, '/@alice/garden', 'the popup opens the slot that is on air, by its slug');
assert.strictEqual(r.opened[0].name, 'viewer-preview', 'one named popup, reused');
console.log('OK the preview opens /@user/<slot slug> of the stream on air');

r = preview({ user: alice, activeStreamId: 1, streamData: { ...gardenStream, managed_stream_slug: null } });
assert.strictEqual(r.opened[0].url, '/@alice/2', 'a slot without a slug is addressed by the SLOT id, not the stream id');
console.log('OK a slot without a slug is opened by the slot id');

r = preview({ user: alice, activeStreamId: 7, streamData: { id: 7, user_id: 3, managed_stream_id: null } });
assert.strictEqual(r.opened[0].url, '/@alice', 'a stream with no slot is the channel page itself');
r = preview({ user: alice, activeStreamId: null, streamData: null });
assert.strictEqual(r.opened[0].url, '/@alice', 'nothing on air: the channel page');
console.log('OK a stream without a slot, or none, opens the channel page');

r = preview({ user: null, activeStreamId: null, streamData: null });
assert.deepStrictEqual([r.opened.length, r.toasts.length], [0, 1], 'a guest is told to sign in, nothing opens');
console.log('OK a guest gets a sign-in message');

// ── the channel page resolves that slot segment to the live session on it ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-viewer-preview-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.DATA_DIR = tmp;
const log = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) log(...a); };
const db = require('../server/db/database');
db.initDb();
db.getDb().prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, created_at)
    VALUES (3, 'alice', 'alice', 'alice@x', 'x', 'streamer', '2025-01-01 00:00:00')`).run();
const ch = db.ensureChannel(3);
db.createManagedStream({ user_id: 3, channel_id: ch.id, slug: 'desk', title: 'Desk', protocol: 'webrtc', stream_key: 'k'.repeat(40) });
db.createManagedStream({ user_id: 3, channel_id: ch.id, slug: 'garden', title: 'Garden', protocol: 'webrtc', stream_key: 'g'.repeat(40) });
const live = Number(db.createStream({ user_id: 3, channel_id: ch.id, managed_stream_id: 2, title: 'Garden live', protocol: 'webrtc' }).lastInsertRowid);
assert.strictEqual(live, 1);
// GET /api/streams/channel/:username/resolve/:ref (server/streaming/routes.js) resolves the segment
// with getManagedStreamByIdOrSlug, then takes that slot's live session.
assert.strictEqual(db.getManagedStreamByIdOrSlug(3, 'garden').id, 2, 'the new URL resolves to the slot on air');
assert.strictEqual(db.getManagedStreamByIdOrSlug(3, '2').id, 2);
assert.strictEqual(db.getManagedStreamByIdOrSlug(3, String(live)).slug, 'desk', 'the old URL (stream id 1) resolved to the other slot');
console.log = log;
console.log('OK the slot segment resolves to the slot on air (the stream id resolved to another slot)');

const html = read('public/fragments/broadcast.html');
assert.match(html, /onclick="openViewerPreview\(\)"[^>]*title="Open a popup showing exactly what viewers see"/, 'the live controls offer the Viewer popup');
assert.match(bc, /function toggleBroadcastPreview\(\)/, 'next to the local-preview toggle');
console.log('OK the live controls carry the Viewer button');

console.log('\n✅ viewer-style preview checks passed');
process.exit(0);
