/**
 * Tranche 3 contract: the picture-in-picture camera is a SLOT, not a second track. Since migration 0021 a slot shows up to
 * three of them (stream_pips), from any streamer's slots (owner, 2026-10-26: "it should be able to use other streams …
 * like any streams on the site … set their default position/size while also allowing users to adjust them"), and the
 * channel page draws them (it never did: /api/streams/channel/:username sent no overlay, so PIPs had stopped showing).
 *
 * Modelling the camera as an ordinary slot publishing an ordinary stream is what lets it
 * inherit everything the platform already does per stream — its own VOD, clips,
 * transcript and restreams — and what lets a viewer move and resize it independently of
 * the screen share underneath. It also means a streamer can point at someone else's slot
 * (a co-host, a moderator), which a camera welded into their own capture could not do.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const db = require('../server/db/database');
const http = require('http');
const express = require('express');
// The routes take requireAuth/optionalAuth from the auth module when they load: act as `actAs` instead.
const auth = require('../server/auth/auth');
let actAs = null;
auth.requireAuth = (req, res, next) => { if (!actAs) return res.status(401).json({ error: 'Authentication required' }); req.user = actAs; next(); };
auth.optionalAuth = (req, res, next) => { if (actAs) req.user = actAs; next(); };

(async () => {
await db.initDb();
await db.run("INSERT INTO users (id, username, password_hash) OVERRIDING SYSTEM VALUE VALUES (1, 'owner', 'x'), (2, 'someone-else', 'x')");
await db.run(`INSERT INTO managed_streams (id, user_id, title, stream_key) OVERRIDING SYSTEM VALUE VALUES
    (10, 1, 'Screen', 'key-screen'), (11, 1, 'Webcam', 'key-cam'), (12, 2, 'Other user slot', 'key-other')`);

// ── A: schema carries the linkage ────────────────────────────────────────────────────
const cols = (await db.all("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'managed_streams'")).map(c => c.name);
assert.ok(cols.includes('pip_source_msid'), 'managed_streams needs pip_source_msid');
assert.ok(cols.includes('pip_defaults'), 'managed_streams needs pip_defaults for the starting geometry');
console.log('OK A: slot linkage and default geometry columns exist');

// ── B: no overlay until one is configured ────────────────────────────────────────────
assert.strictEqual(await db.getPipOverlayForManagedStream(10), null, 'unconfigured slot must report no overlay');
console.log('OK B: unconfigured slot reports no overlay');

// ── C: configured but the camera is offline -> resolves, marked not live ─────────────
await db.updateManagedStream(10, 1, { pip_source_msid: 11, pip_defaults: { x: 0.7, y: 0.6, w: 0.3 } });
let ov = await db.getPipOverlayForManagedStream(10);
assert.ok(ov, 'a configured overlay must resolve');
assert.strictEqual(ov.source_msid, 11);
assert.strictEqual(ov.live, false, 'no live session yet');
assert.strictEqual(ov.stream_id, null, 'nothing for the player to consume yet');
assert.deepStrictEqual(ov.defaults, { x: 0.7, y: 0.6, w: 0.3 }, 'broadcaster defaults must round-trip');
console.log('OK C: configured-but-offline resolves with live=false so the player renders nothing');

// ── D: camera goes live -> the player gets a stream id ───────────────────────────────
await db.run('INSERT INTO streams (id, user_id, managed_stream_id, is_live) OVERRIDING SYSTEM VALUE VALUES (500, 1, 11, 1)');
ov = await db.getPipOverlayForManagedStream(10);
assert.strictEqual(ov.live, true, 'a live camera slot must report live');
assert.strictEqual(ov.stream_id, 500, 'the player needs the live stream id to consume');
console.log('OK D: a live camera slot hands the player a stream id to consume');

// ── E: self-reference is refused — it would ask the player to render itself ──────────
await db.updateManagedStream(11, 1, { pip_source_msid: 11 });
assert.strictEqual(await db.getPipOverlayForManagedStream(11), null, 'a slot pointing at itself must resolve to nothing');
console.log('OK E: self-reference resolves to no overlay');

// ── F: candidate list excludes the slot being configured ─────────────────────────────
const cands = (await db.getPipCandidateSlots(1, 10)).map(c => c.id);
assert.ok(cands.includes(11), 'the owner\'s other slots are candidates');
assert.ok(!cands.includes(10), 'a slot must not offer itself as its own camera');
assert.ok(!cands.includes(12), 'another user\'s slot must not appear in this owner\'s list');
console.log('OK F: candidate list excludes self and other owners');

// ── G: the API validates ownership and self-reference ────────────────────────────────
const routes = read('server/streaming/routes.js');
const put = routes.slice(routes.indexOf("router.put('/managed/:id'"), routes.indexOf("router.put('/managed/:id'") + 6000);
assert.ok(/cannot be its own picture-in-picture camera/.test(put), 'self-reference must be rejected with a clear error');
assert.ok(/That slot belongs to someone else/.test(put), 'cross-owner references must be rejected');
assert.ok(/stream\.pip_overlay = first \?/.test(routes), 'the viewer endpoints still expose the first live PIP for the N-1 player');
assert.ok(/await attachPips\(liveStream\);/.test(routes), 'the channel page\'s live streams carry their PIPs (they never did)');
assert.ok(/router\.get\('\/:id', optionalAuth[\s\S]{0,4000}await attachPips\(stream\);/.test(routes), 'and GET /:id');
console.log('OK G: the old single-PIP field keeps its checks; both stream routes carry PIPs');

// ── H: the viewer overlay is an independent session, torn down with the player ───────
const pip = read('public/js/stream-pip.js');
const player = read('public/js/stream-player.js');
// The player loads as a feature (public/features.json → player), in order.
const playerJs = JSON.parse(read('public/features.json')).features.player.js;
assert.ok(playerJs.includes('/js/stream-pip.js'), 'the player feature must load stream-pip.js');
assert.ok(playerJs.indexOf('/js/stream-player.js') < playerJs.indexOf('/js/stream-pip.js'),
    'stream-pip.js relies on loadMediasoupClient/sanitizeIceServers from stream-player.js');
assert.ok(JSON.parse(read('public/features.json')).features.channel.deps.includes('player'), 'channel pages load the player');
assert.ok(/streamPip\?\.attach\(stream\)/.test(player), 'initPlayer must attach the overlay');
assert.ok(/streamPip\?\.detach\(\)/.test(player),
    'destroyPlayer must detach it — the overlay owns a websocket and a transport of its own');
for (const msg of ['sfu-viewer-create-transport', 'sfu-viewer-consume', 'sfu-viewer-connect-transport', 'sfu-viewer-resume']) {
    assert.ok(pip.includes(msg), `the overlay must speak ${msg} like any other viewer`);
}
console.log('OK H: overlay is a full independent viewer session, attached and detached with the player');

// ── I: viewer control — geometry persists, and hiding stays recoverable ──────────────
assert.ok(/localStorage\.setItem\(LS_KEY\(o\.hostId, o\.pip\.source_msid\)/.test(pip), 'geometry must persist per stream and per PIP');
assert.ok(/if \(!raw && first\) raw = JSON\.parse\(localStorage\.getItem\(LS_OLD\(streamId\)\)/.test(pip), 'the first PIP keeps where a viewer put the old single one');
assert.ok(/ov-pip-restore/.test(pip) && read('public/css/style.css').includes('.ov-pip-restore'),
    'hiding the overlay must leave a way to bring it back');
assert.ok(/muted: pip\.muted !== false/.test(pip),
    'the overlay starts as the streamer chose, muted unless they said otherwise');
assert.ok(/is-offline/.test(pip), 'a camera going offline must degrade to a badge, not a broken overlay');
console.log('OK I: geometry persists, hide is recoverable, audio defaults to muted, offline degrades gracefully');

// ── J: workspace placement — Settings owns the control profile and the PiP section ───
{
    const ws = read('public/js/broadcast-workspace.js');
    const at = (name) => ws.indexOf(`data-wstabpanel="${name}"`);
    const [prof, settings, endpoint] = [at('profile'), at('settings'), at('endpoint')];
    assert.ok(prof > 0 && settings > prof && endpoint > settings, 'expected profile/settings/endpoint panels in order');
    const streamPanel = ws.slice(prof, settings);
    const settingsPanel = ws.slice(settings, endpoint);

    // Live's robot controls are gone (robots are OpenVibe.Bot's): no control profile select anywhere.
    assert.ok(!ws.includes('id="bc-control-config"'), 'no control profile select in the workspace');
    assert.ok(settingsPanel.includes('id="bc-ws-pip-list"') && settingsPanel.includes('id="bc-ws-pip-add"'),
        'the PIP list must render in the Settings tab');

    // It is its own collapsible section, matching the other Settings groups.
    for (const label of ['Picture-in-picture']) {
        // Anchor on the SUMMARY text: an HTML comment carries the same label just above
        // the <details>, and matching that would look in the wrong place entirely.
        const idx = settingsPanel.indexOf(`${label}</summary>`);
        assert.ok(idx > 0, `Settings must have a "${label}" collapsible section`);
        const before = settingsPanel.slice(Math.max(0, idx - 400), idx);
        assert.ok(before.includes('<details class="bc-ws-slot-settings" id="bc-ws-pip-details">'),
            `"${label}" must be a collapsible <details> section like the rest of Settings`);
    }
    console.log('OK J: the PiP camera is a collapsible section under Settings, and there is no control profile');
}

// ── K: PiP starting geometry round-trips through corner/size ─────────────────────────
{
    const ws = read('public/js/broadcast-workspace.js');
    assert.ok(/function _wsPipCornerToXY/.test(ws) && /function _wsPipXYToCorner/.test(ws),
        'corner <-> fraction conversion must exist in both directions');
    assert.ok(!/pip_source_msid|pip_defaults/.test(ws), 'the slot settings save no longer sends the single PIP (it would collapse the list)');
    assert.ok(/_wsPipLoad\(ms\.id\)/.test(ws) && /api\(`\/streams\/managed\/\$\{st\.msId\}\/pips`, \{ method: 'PUT'/.test(ws), 'the list loads with the slot and saves on its own');
    assert.ok(/_wsPipCornerToXY\(e\.target\.value, q\.defaults\.w\)/.test(ws), 'a row\'s corner is stored as fractions');

    // Exercise the conversion the way the UI does: every corner must land in its own
    // quadrant and stay fully inside the player box.
    const MARGIN = 0.02;
    const cornerToXY = (corner, w) => {
        const h = w * 9 / 16, right = 1 - w - MARGIN, bottom = 1 - h - MARGIN;
        return corner === 'bl' ? { x: MARGIN, y: bottom }
             : corner === 'tr' ? { x: right, y: MARGIN }
             : corner === 'tl' ? { x: MARGIN, y: MARGIN }
             : { x: right, y: bottom };
    };
    const xyToCorner = (x, y) => (y < 0.5 ? 't' : 'b') + (x < 0.5 ? 'l' : 'r');
    for (const w of [0.18, 0.25, 0.35]) {
        for (const corner of ['br', 'bl', 'tr', 'tl']) {
            const { x, y } = cornerToXY(corner, w);
            assert.strictEqual(xyToCorner(x, y), corner, `${corner} @ w=${w} must round-trip`);
            assert.ok(x >= 0 && y >= 0 && x + w <= 1 && y + (w * 9 / 16) <= 1,
                `${corner} @ w=${w} must sit fully inside the player`);
        }
    }
    console.log('OK K: every corner/size default round-trips and stays inside the player box');
}

// ── L: the migration carries the one PIP a slot had into stream_pips ─────────────────
{
    await db.run('DELETE FROM stream_pips');
    await db.run(`UPDATE managed_streams SET pip_source_msid = 11, pip_defaults = '{"x":0.1,"y":0.2,"w":0.9}' WHERE id = 10`);
    const sql = read('migrations/0021_stream_pips.sql');
    await db.run(sql.slice(sql.indexOf('INSERT INTO stream_pips')).trim().replace(/;$/, ''));
    const rows = await db.all('SELECT managed_stream_id, source_msid, x, y, w, muted FROM stream_pips');
    assert.deepStrictEqual(rows.map((r) => [Number(r.managed_stream_id), Number(r.source_msid), Number(r.x), Number(r.y), Number(r.w), Number(r.muted)]),
        [[10, 11, 0.1, 0.2, 0.6, 1]], 'the old PIP, its width kept to the most a PIP may be');
    console.log('OK L: migration 0021 carries the old single PIP over');
}

// ── M: a slot's PIPs: in order, anyone's slot, live state, the 18+ rule, a banned owner's dropped ──
{
    await db.run("INSERT INTO users (id, username, password_hash) OVERRIDING SYSTEM VALUE VALUES (3, 'gone', 'x')");
    await db.run('UPDATE users SET is_banned = 1 WHERE id = 3');
    await db.run(`INSERT INTO managed_streams (id, user_id, title, slug, stream_key, is_nsfw) OVERRIDING SYSTEM VALUE VALUES
        (13, 2, 'Late night', 'late', 'key-nsfw', 1), (14, 3, 'Banned slot', NULL, 'key-banned', 0)`);
    await db.run('INSERT INTO streams (id, user_id, managed_stream_id, is_live, protocol) OVERRIDING SYSTEM VALUE VALUES (501, 2, 12, 1, ?)', ['rtmp']);
    const saved = await db.setPipsForManagedStream(10, [
        { source_msid: 12, x: 0.02, y: 0.02, w: 0.18, muted: false }, { source_msid: 11, x: 2, y: -1, w: 9 }, { source_msid: 13 }, { source_msid: 14 }]);
    assert.strictEqual(saved.length, 3, `at most ${db.MAX_PIPS}`);
    const pips = await db.getPipsForManagedStream(10);
    assert.deepStrictEqual(pips.map((p) => [p.source_msid, p.username, p.live, p.stream_id, p.protocol, p.muted]),
        [[12, 'someone-else', true, 501, 'rtmp', false], [11, 'owner', true, 500, 'webrtc', true]],
        "in order: another streamer's live RTMP slot, the owner's live webcam; an 18+ slot never shows over one that is not");
    assert.deepStrictEqual(pips[1].defaults, { x: 1, y: 0, w: 0.6 }, 'places are kept inside the player');
    const mirror = await db.get('SELECT pip_source_msid, pip_defaults FROM managed_streams WHERE id = 10');
    assert.deepStrictEqual([Number(mirror.pip_source_msid), JSON.parse(mirror.pip_defaults)], [12, { x: 0.02, y: 0.02, w: 0.18 }], 'the first is mirrored for the N-1 release');
    await db.run('UPDATE managed_streams SET is_nsfw = 1 WHERE id = 10');
    assert.ok((await db.getPipsForManagedStream(10)).some((p) => p.source_msid === 13), 'over an 18+ slot, an 18+ PIP shows');
    await db.run('UPDATE managed_streams SET is_nsfw = 0 WHERE id = 10');
    await db.setPipsForManagedStream(10, [{ source_msid: 14 }]);
    assert.deepStrictEqual(await db.getPipsForManagedStream(10), [], "a banned streamer's slot shows nowhere");
    console.log("OK M: up to three PIPs in order, anyone's slots, live state and protocol, 18+ and bans respected, the first mirrored");
}

// ── N: the routes: only the slot's owner edits; the checks; anyone's slots to pick from; the channel page's PIPs ──
{
    const app = express();
    app.use(express.json());
    app.use('/api/streams', require('../server/streaming/routes'));
    const server = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/streams`;
    const call = async (method, p, body) => {
        const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    try {
        const owner = await db.getUserById(1), other = await db.getUserById(2);
        actAs = null;
        assert.strictEqual((await call('GET', '/managed/10/pips')).status, 401);
        actAs = other;
        assert.strictEqual((await call('PUT', '/managed/10/pips', { pips: [] })).status, 403, "another streamer cannot change this slot's PIPs");
        actAs = owner;
        assert.strictEqual((await call('PUT', '/managed/10/pips', { pips: [{ source_msid: 10 }] })).body.error, 'A slot cannot show itself as a picture-in-picture');
        assert.match((await call('PUT', '/managed/10/pips', { pips: [{ source_msid: 13 }] })).body.error, /18\+ stream can only be shown over another 18\+ stream/);
        assert.strictEqual((await call('PUT', '/managed/10/pips', { pips: [{ source_msid: 14 }] })).status, 404, "a banned streamer's slot is not offered");
        assert.match((await call('PUT', '/managed/10/pips', { pips: [{ source_msid: 11 }, { source_msid: 11 }] })).body.error, /already/);
        assert.match((await call('PUT', '/managed/10/pips', { pips: [1, 2, 3, 4].map(() => ({ source_msid: 11 })) })).body.error, /At most 3/);
        const ok = await call('PUT', '/managed/10/pips', { pips: [{ source_msid: 11, x: 0.7, y: 0.7, w: 0.25 }, { source_msid: 12, muted: false }] });
        assert.deepStrictEqual(ok.body.pips.map((p) => p.source_msid), [11, 12], "your own slot and someone else's, in order");
        assert.deepStrictEqual((await call('GET', '/managed/10/pips')).body.pips.map((p) => p.source_msid), [11, 12]);
        const theirs = await call('GET', '/pip-sources?username=@Someone-Else');
        assert.deepStrictEqual([theirs.body.username, theirs.body.slots.map((sl) => [sl.id, sl.live, sl.nsfw])], ['someone-else', [[12, true, false], [13, false, true]]]);
        assert.deepStrictEqual((await call('GET', '/pip-sources')).body.slots.map((sl) => sl.id), [10, 11], 'your own slots without a name');
        assert.strictEqual((await call('GET', '/pip-sources?username=gone')).status, 404, 'a banned streamer is not found');
        // The old single-PIP field (an N-1 tab) replaces the list with that one.
        await call('PUT', '/managed/10', { pip_source_msid: 11, pip_defaults: { x: 0.5, y: 0.5, w: 0.3 } });
        assert.deepStrictEqual((await db.getPipsForManagedStream(10)).map((p) => [p.source_msid, p.defaults.w]), [[11, 0.3]]);
        await call('PUT', '/managed/10/pips', { pips: [{ source_msid: 11 }, { source_msid: 12 }] });
        // A viewer: the live stream of slot 10 carries its PIPs, on the poll route too.
        await db.run('INSERT INTO streams (id, user_id, managed_stream_id, is_live, protocol) OVERRIDING SYSTEM VALUE VALUES (502, 1, 10, 1, ?)', ['webrtc']);
        actAs = null;
        const polled = await call('GET', '/502/pips');
        assert.deepStrictEqual(polled.body.pips.map((p) => [p.source_msid, p.live, p.stream_id]), [[11, true, 500], [12, true, 501]]);
        assert.deepStrictEqual((await call('GET', '/500/pips')).body.pips, [], 'a slot without PIPs has none');
        console.log("OK N: only the owner edits; self, 18+, banned, duplicates and a fourth refused; anyone's slots listed; the old field and the poll route work");
    } finally { server.close(); }
}

// ── O: the viewer draws every live PIP, picks up new ones and drops ended ones ──────────────
{
    const pip = read('public/js/stream-pip.js');
    assert.ok(/const pips = Array\.isArray\(stream\.pip_overlays\) \? stream\.pip_overlays/.test(pip), 'every PIP, the N-1 single one as a fallback');
    assert.ok(/fetch\(`\/api\/streams\/\$\{encodeURIComponent\(host\.streamId\)\}\/pips`/.test(pip) && /setInterval\(poll, POLL_MS\)/.test(pip), 'asks again every 30 s');
    assert.ok(/if \(!keep\.has\(key\)\) \{ close\(o\); host\.overlays\.delete\(key\); \}/.test(pip), 'an ended or removed PIP goes');
    assert.ok(/if \(o\.pip\.protocol === 'rtmp'\) await connectFlv\(o, videoEl\);/.test(pip), 'an RTMP source plays its FLV');
    assert.ok(!/token=/.test(pip), 'no token in a socket address');
    assert.ok(read('public/css/features/channel.css').includes('.ov-pip-restores .ov-pip-restore { position: static; }'), "hidden PIPs' pills sit in one row");
    console.log('OK O: the viewer draws every live PIP, polls, and plays WebRTC and RTMP sources');
}

// ── P: the live list: a streamer's camera that is the PIP of their own live stream shows inside it, not as a tile ──
{
    // Slot 10 (owner, live as 502) lists 11 (owner's webcam, live as 500) and 12 (someone else's, live as 501).
    const app = express();
    app.use('/api/streams', require('../server/streaming/routes'));
    const server = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    try {
        const ids = async () => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/streams`)).json()).streams.map((x) => Number(x.id)).sort();
        assert.deepStrictEqual(await ids(), [501, 502], "the owner's webcam (500) is inside the screen share; the co-host (501) keeps a tile");
        await db.run('UPDATE streams SET is_live = 0 WHERE id = 502');
        assert.deepStrictEqual(await ids(), [500, 501], 'once the screen share ends, the webcam is a stream like any other');
        console.log("OK P: the live list leaves out a streamer's own camera as long as it is the PIP of their live stream");
    } finally { server.close(); }
}

console.log('✅ PiP camera slot test passed');
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
