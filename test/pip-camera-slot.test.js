/**
 * Tranche 3 contract: the picture-in-picture camera is a SLOT, not a second track.
 *
 * Modelling the camera as an ordinary slot publishing an ordinary stream is what lets it
 * inherit everything the platform already does per stream — its own VOD, clips,
 * transcript and restreams — and what lets a viewer move and resize it independently of
 * the screen share underneath. It also means a streamer can point at someone else's slot
 * (a co-host, a moderator), which a camera welded into their own capture could not do.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const tmp = path.join(os.tmpdir(), `ov-pip-${Date.now()}.db`);
process.env.DB_PATH = tmp;
const db = require('../server/db/database');
db.initDb();

const Database = require('better-sqlite3');
{
    const w = new Database(tmp);
    w.pragma('foreign_keys = OFF');
    w.prepare('INSERT OR IGNORE INTO users (id, username) VALUES (1, ?)').run('owner');
    w.prepare('INSERT OR IGNORE INTO users (id, username) VALUES (2, ?)').run('someone-else');
    const ms = w.prepare('INSERT INTO managed_streams (id, user_id, title, stream_key) VALUES (?,?,?,?)');
    ms.run(10, 1, 'Screen', 'key-screen');
    ms.run(11, 1, 'Webcam', 'key-cam');
    ms.run(12, 2, 'Other user slot', 'key-other');
    w.close();
}

// ── A: schema carries the linkage ────────────────────────────────────────────────────
const cols = new Database(tmp, { readonly: true }).prepare('PRAGMA table_info(managed_streams)').all().map(c => c.name);
assert.ok(cols.includes('pip_source_msid'), 'managed_streams needs pip_source_msid');
assert.ok(cols.includes('pip_defaults'), 'managed_streams needs pip_defaults for the starting geometry');
console.log('OK A: slot linkage and default geometry columns exist');

// ── B: no overlay until one is configured ────────────────────────────────────────────
assert.strictEqual(db.getPipOverlayForManagedStream(10), null, 'unconfigured slot must report no overlay');
console.log('OK B: unconfigured slot reports no overlay');

// ── C: configured but the camera is offline -> resolves, marked not live ─────────────
db.updateManagedStream(10, 1, { pip_source_msid: 11, pip_defaults: { x: 0.7, y: 0.6, w: 0.3 } });
let ov = db.getPipOverlayForManagedStream(10);
assert.ok(ov, 'a configured overlay must resolve');
assert.strictEqual(ov.source_msid, 11);
assert.strictEqual(ov.live, false, 'no live session yet');
assert.strictEqual(ov.stream_id, null, 'nothing for the player to consume yet');
assert.deepStrictEqual(ov.defaults, { x: 0.7, y: 0.6, w: 0.3 }, 'broadcaster defaults must round-trip');
console.log('OK C: configured-but-offline resolves with live=false so the player renders nothing');

// ── D: camera goes live -> the player gets a stream id ───────────────────────────────
{
    const w = new Database(tmp);
    w.pragma('foreign_keys = OFF');
    w.prepare('INSERT INTO streams (id, user_id, managed_stream_id, is_live) VALUES (?,?,?,1)').run(500, 1, 11);
    w.close();
}
ov = db.getPipOverlayForManagedStream(10);
assert.strictEqual(ov.live, true, 'a live camera slot must report live');
assert.strictEqual(ov.stream_id, 500, 'the player needs the live stream id to consume');
console.log('OK D: a live camera slot hands the player a stream id to consume');

// ── E: self-reference is refused — it would ask the player to render itself ──────────
db.updateManagedStream(11, 1, { pip_source_msid: 11 });
assert.strictEqual(db.getPipOverlayForManagedStream(11), null, 'a slot pointing at itself must resolve to nothing');
console.log('OK E: self-reference resolves to no overlay');

// ── F: candidate list excludes the slot being configured ─────────────────────────────
const cands = db.getPipCandidateSlots(1, 10).map(c => c.id);
assert.ok(cands.includes(11), 'the owner\'s other slots are candidates');
assert.ok(!cands.includes(10), 'a slot must not offer itself as its own camera');
assert.ok(!cands.includes(12), 'another user\'s slot must not appear in this owner\'s list');
console.log('OK F: candidate list excludes self and other owners');

// ── G: the API validates ownership and self-reference ────────────────────────────────
const routes = read('server/streaming/routes.js');
const put = routes.slice(routes.indexOf("router.put('/managed/:id'"), routes.indexOf("router.put('/managed/:id'") + 6000);
assert.ok(/cannot be its own picture-in-picture camera/.test(put), 'self-reference must be rejected with a clear error');
assert.ok(/That slot belongs to someone else/.test(put), 'cross-owner references must be rejected');
assert.ok(/stream\.pip_overlay/.test(routes), 'the viewer endpoint must expose the resolved overlay');
console.log('OK G: API rejects self-reference and cross-owner slots, and exposes the overlay');

// ── H: the viewer overlay is an independent session, torn down with the player ───────
const pip = read('public/js/stream-pip.js');
const player = read('public/js/stream-player.js');
const html = read('public/index.html');
assert.ok(html.includes('/js/stream-pip.js'), 'index.html must load stream-pip.js');
assert.ok(html.indexOf('/js/stream-player.js') < html.indexOf('/js/stream-pip.js'),
    'stream-pip.js relies on loadMediasoupClient/sanitizeIceServers from stream-player.js');
assert.ok(/streamPip\?\.attach\(stream\)/.test(player), 'initPlayer must attach the overlay');
assert.ok(/streamPip\?\.detach\(\)/.test(player),
    'destroyPlayer must detach it — the overlay owns a websocket and a transport of its own');
for (const msg of ['sfu-viewer-create-transport', 'sfu-viewer-consume', 'sfu-viewer-connect-transport', 'sfu-viewer-resume']) {
    assert.ok(pip.includes(msg), `the overlay must speak ${msg} like any other viewer`);
}
console.log('OK H: overlay is a full independent viewer session, attached and detached with the player');

// ── I: viewer control — geometry persists, and hiding stays recoverable ──────────────
assert.ok(/localStorage\.setItem\(LS_KEY\(state\.streamId\)/.test(pip), 'geometry must persist per stream');
assert.ok(/ov-pip-restore/.test(pip) && read('public/css/style.css').includes('.ov-pip-restore'),
    'hiding the overlay must leave a way to bring it back');
assert.ok(/raw\.muted !== false/.test(pip),
    'the overlay must default to muted — the stream underneath already carries the audio');
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

    assert.ok(!streamPanel.includes('id="bc-control-config"'),
        'the control profile select must no longer render in the Stream tab');
    assert.ok(settingsPanel.includes('id="bc-control-config"'),
        'the control profile select must render in the Settings tab');
    assert.ok(settingsPanel.includes('id="bc-ws-pip-source"'),
        'the PiP camera picker must render in the Settings tab');

    // Both must be their own collapsible sections, matching the other Settings groups.
    for (const label of ['Control Profile', 'Picture-in-picture Camera']) {
        // Anchor on the SUMMARY text: an HTML comment carries the same label just above
        // the <details>, and matching that would look in the wrong place entirely.
        const idx = settingsPanel.indexOf(`${label}</summary>`);
        assert.ok(idx > 0, `Settings must have a "${label}" collapsible section`);
        const before = settingsPanel.slice(Math.max(0, idx - 400), idx);
        assert.ok(before.includes('<details class="bc-ws-slot-settings">'),
            `"${label}" must be a collapsible <details> section like the rest of Settings`);
    }
    console.log('OK J: control profile and PiP camera are collapsible sections under Settings');
}

// ── K: PiP starting geometry round-trips through corner/size ─────────────────────────
{
    const ws = read('public/js/broadcast-workspace.js');
    assert.ok(/function _wsPipCornerToXY/.test(ws) && /function _wsPipXYToCorner/.test(ws),
        'corner <-> fraction conversion must exist in both directions');
    assert.ok(/pip_defaults: \(\(\) => \{/.test(ws), 'the save payload must include pip_defaults');
    assert.ok(/_wsPipDefaultsRestore\(ms\)/.test(ws), 'stored fractions must be restored into the selects');

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

try { fs.unlinkSync(tmp); } catch { /* */ }
for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
console.log('✅ PiP camera slot test passed');
