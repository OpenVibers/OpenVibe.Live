'use strict';

// The canonical channel/owner resolver (roadmap D20, server/lineage): every input kind, the
// precedence between inputs and inside a record, conflicts, "a display name alone resolves
// nothing", legacy maps, a deleted stream with a surviving VOD, the clip -> VOD -> stream -> channel
// chain, the clips.js call site, and GET|POST /internal/lineage/resolve behind its service token.
// Media is a fake HTTP server; answers are checked against lineage.resolution@1 when the installed
// openvibe-contracts has it (0.32.0+).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const contracts = require('openvibe-contracts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-lineage-'));
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
fs.writeFileSync(path.join(tmp, 'network.pem'), keys.publicKey);
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.OV_NETWORK_PUBLIC_KEY = path.join(tmp, 'network.pem');
process.env.OV_NETWORK_URL = 'https://openvibe.network';
process.env.MEDIA_API_KEY = 'media-key';
process.env.MEDIA_APP_ID = 'live';
const log = console.log;
console.log = () => {};
console.warn = () => {};

const sub = (tag) => `usr_${`01J${tag}`.padEnd(26, '0')}`;
const ALICE = sub('AA'), BOB = sub('BB'), SHARED = sub('CC'), NOBODY = sub('DD');
const med = (tag) => `med_${`01J${tag}`.padEnd(26, '0')}`;

// ── Fake OpenVibe.Media ─────────────────────────────────────
const VODS = {
    42: { id: 42, stream_id: 9, managed_stream_id: 3, user_id: 17 },
    43: { id: 43, stream_id: 999999, managed_stream_id: 3, user_id: 17 },          // stream row never existed here
    44: { id: 44, stream_id: 999998, managed_stream_id: 999997, user_id: 17 },     // stream and slot gone
    45: { id: 45, stream_id: null, managed_stream_id: null, user_id: null },       // names nothing
    46: { id: 46, stream_id: 9, managed_stream_id: null, user_id: 18 },            // stream says alice, recorded owner bob
    47: { id: 47, stream_id: null, managed_stream_id: null, user_id: 999 },        // owner account deleted
    48: { id: 48, stream_id: 11, managed_stream_id: 3, user_id: 17 },              // stream 11 is deleted below
};
const CLIPS = {
    7: { id: 7, vod_id: 42, stream_id: null, user_id: 18, channel_user_id: 17 },   // bob clipped alice's VOD
    8: { id: 8, vod_id: null, stream_id: 9, user_id: 18, channel_user_id: null },
    9: { id: 9, vod_id: null, stream_id: null, user_id: 18, channel_user_id: 17 },
    10: { id: 10, vod_id: null, stream_id: null, user_id: 18, channel_user_id: null },
    12: { id: 12, vod_id: 404404, stream_id: null, user_id: 18, channel_user_id: null },
    13: { id: 13, vod_id: 42, stream_id: 10, user_id: 19, channel_user_id: null },  // bob's stream, alice's VOD
    14: { id: 14, vod_id: 44, stream_id: null, user_id: 18, channel_user_id: null },
    15: { id: 15, vod_id: 47, stream_id: null, user_id: 18, channel_user_id: null },
};
const OBJECTS = {
    [med('A1')]: { id: med('A1'), kind: 'vod', legacy_ref: 'legacy:live:vod:42', owner: { subject: null, app: 'live', user_id: 17 } },
    [med('B1')]: { id: med('B1'), kind: 'file', legacy_ref: null, owner: { subject: `user:${ALICE}`, app: 'live', user_id: 18 } },
    [med('C1')]: { id: med('C1'), kind: 'file', legacy_ref: null, owner: { subject: null, app: 'live', user_id: 17 } },
    'legacy:live:thumbnail:x.jpg': { id: med('D1'), kind: 'thumbnail', legacy_ref: 'legacy:live:thumbnail:x.jpg', owner: { subject: null, app: 'live', user_id: 17 } },
};
const mediaState = { down: false, calls: [] };
const mediaServer = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    mediaState.calls.push(url);
    assert.strictEqual(req.headers.authorization, 'Bearer media-key', 'Live reads Media as its app');
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (mediaState.down) return send(503, { error: 'down' });
    let m;
    if ((m = /^\/api\/v1\/live\/vods\/(\d+)$/.exec(url))) return VODS[m[1]] ? send(200, VODS[m[1]]) : send(404, { error: 'VOD not found' });
    if ((m = /^\/api\/v1\/live\/clips\/(\d+)$/.exec(url))) return CLIPS[m[1]] ? send(200, CLIPS[m[1]]) : send(404, { error: 'Clip not found' });
    if ((m = /^\/api\/v2\/live\/objects\/(.+)$/.exec(url))) return OBJECTS[m[1]] ? send(200, OBJECTS[m[1]]) : send(404, { code: 'media.object.not_found' });
    send(404, { error: 'no route' });
});

// Every contract answer is checked against lineage.resolution@1 when the installed contracts know it.
const RESOLUTION = 'lineage.resolution@1';
const contractKnown = (() => { try { contracts.resolve(RESOLUTION); return true; } catch { return false; } })();
let validated = 0;
function checkContract(out, label) {
    if (!contractKnown) return out;
    const r = contracts.validate(RESOLUTION, out);
    assert.ok(r.valid, `${label}: not a ${RESOLUTION}: ${JSON.stringify(r.errors)}`);
    validated++;
    return out;
}

(async () => {
    await new Promise((r) => mediaServer.listen(0, '127.0.0.1', r));
    process.env.MEDIA_URL = `http://127.0.0.1:${mediaServer.address().port}`;

    const db = require('../server/db/database');
    db.initDb();
    const d = db.getDb();
    const users = [[17, 'alice', 'Alice Wonder'], [18, 'bob', 'alice'], [19, 'carol', 'Carol'], [20, 'dave', 'streamqueen'], [21, 'mallory', 'Alice Wonder'], [22, 'erin', 'Erin']];
    for (const [id, name, display] of users) d.prepare("INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, 'x')").run(id, name, display);
    const channelOf = {};
    for (const id of [17, 18, 19, 21, 22]) channelOf[id] = Number(d.prepare('INSERT INTO channels (user_id) VALUES (?)').run(id).lastInsertRowid);
    const link = d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, 'network', ?, ?)");
    link.run(17, '57', ALICE); link.run(18, '58', BOB); link.run(19, '59', SHARED); link.run(20, '60', null); link.run(21, '61', SHARED);
    d.prepare("INSERT INTO managed_streams (id, user_id, slug, stream_key) VALUES (3, 17, 'garage-cam', 'k3'), (4, 18, 'desk', 'k4')").run();
    d.prepare("INSERT INTO streams (id, user_id, managed_stream_id, channel_id, title) VALUES (9, 17, 3, ?, 'a'), (10, 18, 4, ?, 'b'), (11, 17, 3, ?, 'c')").run(channelOf[17], channelOf[18], channelOf[17]);

    const lineage = require('../server/lineage/resolver');
    const resolve = async (input, label = JSON.stringify(input)) => checkContract(await lineage.resolve(input), label);
    const expectResolved = async (input, want) => {
        const r = await resolve(input);
        assert.strictEqual(r.status, 'resolved', `${JSON.stringify(input)} resolves: ${JSON.stringify(r)}`);
        for (const [k, v] of Object.entries(want)) assert.deepStrictEqual(r[k], v, `${JSON.stringify(input)}: ${k}`);
        return r;
    };
    const expectUnresolved = async (input, reason) => {
        const r = await resolve(input);
        assert.strictEqual(r.status, 'unresolved', `${JSON.stringify(input)} does not resolve: ${JSON.stringify(r)}`);
        assert.strictEqual(r.reason, reason, `${JSON.stringify(input)}: reason`);
        assert.ok(!('channel' in r) && !('resolved_by' in r), 'an unresolved answer names no channel');
        return r;
    };
    const aliceChannel = { id: String(channelOf[17]), slug: 'alice', owner_subject: ALICE, legacy_ids: { live_user_id: 17, network_user_id: 57 } };
    const slot3 = { id: null, slot_id: '3', slot_slug: 'garage-cam' };
    const stream9 = { id: '9', slot_id: '3', slot_slug: 'garage-cam' };

    // ── The request ──────────────────────────────────────────
    const N = (v, o) => lineage.normalizeRequest(v, o);
    assert.ok(N({ username: 'alice' }).error && N({ channel_name: 'Alice' }).error, 'no name-shaped inputs besides slug');
    assert.ok(N({ slug: 'Alice Wonder' }).error, 'a display name is not a slug');
    assert.ok(N({ slug: 'a/b/c' }).error && N({ parent_slug: 'a/b' }).error, 'one level of nesting');
    assert.ok(N({ owner_subject: '17' }).error && N({ legacy_ids: {} }).error && N({ legacy_ids: { live_user_id: 0 } }).error, 'bad subject and legacy ids');
    assert.ok(N({ media_object_id: 'vod:42' }).error, 'media ids are med_ or legacy: refs');
    assert.deepStrictEqual(N({ vod_id: 42 }).input, { vod_id: '42' }, "Live's own callers may pass integer ids");
    assert.deepStrictEqual(N({ live_user_id: '17', network_user_id: '57' }, { flat: true }).input, { legacy_ids: { live_user_id: 17, network_user_id: 57 } }, 'GET flattens legacy_ids');
    assert.ok(N({ live_user_id: '17' }).error, 'flat legacy ids only on GET');

    // ── Every input kind ─────────────────────────────────────
    await expectResolved({ slug: 'alice' }, { channel: aliceChannel, resolved_by: 'slug', rule: 'explicit_slug', confidence: 'exact', via: ['user:17'] });
    await expectResolved({ slug: '@ALICE' }, { channel: aliceChannel, rule: 'explicit_slug' });
    await expectResolved({ slug: 'alice/garage-cam' }, { channel: aliceChannel, resolved_by: 'slug', rule: 'nested_slug', confidence: 'exact', stream: slot3 });
    await expectResolved({ slug: 'alice/3' }, { rule: 'nested_slug', stream: slot3 });
    await expectUnresolved({ slug: 'alice/desk' }, 'not_found');                // bob's slot is not inside alice
    let r = await expectResolved({ parent_slug: 'alice', slug: 'garage-cam' }, { resolved_by: 'slug', rule: 'nested_slug', stream: slot3 });
    assert.deepStrictEqual(r.checked.map(c => [c.input, c.outcome]), [['slug', 'decided'], ['parent_slug', 'decided']]);
    await expectResolved({ parent_slug: 'alice' }, { resolved_by: 'parent_slug', rule: 'nested_slug', channel: aliceChannel });
    await expectResolved({ channel_id: String(channelOf[17]) }, { resolved_by: 'channel_id', rule: 'channel_id', confidence: 'exact' });
    await expectResolved({ stream_id: '9' }, { resolved_by: 'stream_id', rule: 'stream_lookup', confidence: 'exact', stream: stream9, via: ['stream:9', 'user:17'] });
    await expectResolved({ slot_id: '3' }, { resolved_by: 'slot_id', rule: 'stream_lookup', confidence: 'exact', stream: slot3 });
    await expectResolved({ vod_id: '42' }, { resolved_by: 'vod_id', rule: 'stream_lookup', confidence: 'derived', vod: { id: '42', stream_id: '9', slot_id: '3' }, stream: stream9, via: ['vod:42', 'stream:9', 'user:17'] });
    await expectResolved({ clip_id: '8' }, { resolved_by: 'clip_id', rule: 'stream_lookup', confidence: 'derived', via: ['clip:8', 'stream:9', 'user:17'] });
    await expectResolved({ media_object_id: med('A1') }, { resolved_by: 'media_object_id', rule: 'media_lineage', confidence: 'derived', channel: aliceChannel,
        media_object: { id: med('A1'), kind: 'vod', legacy_ref: 'legacy:live:vod:42' }, vod: { id: '42', stream_id: '9', slot_id: '3' } });
    // The object's owner subject outranks the owner user recorded next to it (18, bob).
    await expectResolved({ media_object_id: med('B1') }, { rule: 'owner_subject', confidence: 'derived', channel: aliceChannel });
    await expectResolved({ media_object_id: med('C1') }, { rule: 'legacy_metadata', confidence: 'derived', channel: aliceChannel });
    await expectResolved({ owner_subject: ALICE }, { resolved_by: 'owner_subject', rule: 'owner_subject', confidence: 'exact', channel: aliceChannel });
    await expectResolved({ legacy_ids: { live_user_id: 17 } }, { resolved_by: 'legacy_ids', rule: 'legacy_map', confidence: 'legacy_map', channel: aliceChannel });
    await expectResolved({ legacy_ids: { network_user_id: 57 } }, { resolved_by: 'legacy_ids', rule: 'legacy_map', confidence: 'legacy_map', via: ['network_user:57', 'user:17'] });

    // ── Precedence between inputs ────────────────────────────
    r = await expectResolved({ legacy_ids: { live_user_id: 17 }, owner_subject: ALICE, vod_id: '42', slug: 'alice' }, { resolved_by: 'slug', rule: 'explicit_slug', confidence: 'exact' });
    assert.deepStrictEqual(r.checked.map(c => [c.input, c.outcome]), [['slug', 'decided'], ['vod_id', 'agrees'], ['owner_subject', 'agrees'], ['legacy_ids', 'agrees']], 'checked follows precedence, not argument order');
    assert.deepStrictEqual(r.vod, { id: '42', stream_id: '9', slot_id: '3' }, 'records of agreeing inputs are kept');
    await expectResolved({ owner_subject: ALICE, stream_id: '9' }, { resolved_by: 'stream_id' });
    await expectResolved({ vod_id: '42', clip_id: '7' }, { resolved_by: 'clip_id' });
    await expectResolved({ owner_subject: ALICE, media_object_id: med('A1') }, { resolved_by: 'media_object_id' });
    await expectResolved({ channel_id: String(channelOf[17]), slug: 'alice/garage-cam' }, { resolved_by: 'slug', rule: 'nested_slug' });
    r = await expectResolved({ vod_id: '404404', owner_subject: ALICE }, { resolved_by: 'owner_subject' });
    assert.deepStrictEqual(r.checked.map(c => [c.input, c.outcome]), [['vod_id', 'not_found'], ['owner_subject', 'decided']], 'a missing record does not block');
    assert.ok(!('vod' in r), 'a record that was not found is not attached');
    r = await expectResolved({ slug: 'renamed-away', stream_id: '9' }, { resolved_by: 'stream_id', channel: aliceChannel });
    assert.strictEqual(r.checked[0].outcome, 'not_found');
    // Inside a record the first link that answers wins.
    await expectResolved({ vod_id: '46' }, { rule: 'stream_lookup', channel: aliceChannel });           // not the recorded owner, bob
    r = await expectResolved({ clip_id: '13' }, { rule: 'stream_lookup', via: ['clip:13', 'stream:10', 'user:18'] });   // the clip's stream, not its VOD
    assert.strictEqual(r.channel.slug, 'bob');
    assert.deepStrictEqual(lineage.RULES, contractKnown ? contracts.schema('lineage.resolution').properties.rule.enum : lineage.RULES, 'the rule set is the contract\'s');

    // ── Conflicts ────────────────────────────────────────────
    r = await expectUnresolved({ slug: 'mallory', vod_id: '42' }, 'conflict');
    assert.deepStrictEqual(r.checked, [{ input: 'slug', outcome: 'decided', channel_slug: 'mallory' }, { input: 'vod_id', outcome: 'conflict', channel_slug: 'alice' }]);
    await expectUnresolved({ legacy_ids: { live_user_id: 17, network_user_id: 58 } }, 'conflict');
    await expectUnresolved({ owner_subject: BOB, clip_id: '7' }, 'conflict');

    // ── A display name alone resolves nothing ────────────────
    r = await expectUnresolved({ display_name: 'Alice Wonder' }, 'display_name_only');
    assert.deepStrictEqual(r.checked, [{ input: 'display_name', outcome: 'ignored' }]);
    await expectUnresolved({ display_name: 'alice' }, 'display_name_only');       // even when it is someone's username
    await expectUnresolved({ slug: 'streamqueen' }, 'not_found');                  // dave's display name is not a slug
    await expectUnresolved({ slug: 'ghost', display_name: 'Alice Wonder' }, 'not_found');   // and never rescues a miss
    r = await expectResolved({ slug: 'alice', display_name: 'Mallory' }, { resolved_by: 'slug', channel: aliceChannel });
    assert.deepStrictEqual(r.checked.at(-1), { input: 'display_name', outcome: 'ignored' });
    assert.strictEqual((await expectResolved({ slug: 'bob' }, {})).channel.slug, 'bob');   // bob's display name is "alice"; alice stays alice
    assert.strictEqual((await resolve({ slug: 'alice' })).channel.legacy_ids.live_user_id, 17);

    // ── Legacy maps ──────────────────────────────────────────
    await expectResolved({ legacy_ids: { live_user_id: 17, network_user_id: 57 } }, { confidence: 'legacy_map', channel: aliceChannel });
    await expectResolved({ media_object_id: 'legacy:live:vod:42' }, { rule: 'legacy_map', confidence: 'legacy_map', channel: aliceChannel,
        via: ['media:legacy:live:vod:42', 'vod:42', 'stream:9', 'user:17'], media_object: { id: 'legacy:live:vod:42', kind: 'vod', legacy_ref: 'legacy:live:vod:42' } });
    await expectResolved({ media_object_id: 'legacy:live:clip:7' }, { rule: 'legacy_map', confidence: 'legacy_map', via: ['media:legacy:live:clip:7', 'clip:7', 'vod:42', 'stream:9', 'user:17'] });
    await expectResolved({ media_object_id: 'legacy:live:thumbnail:x.jpg' }, { rule: 'legacy_map', confidence: 'legacy_map', media_object: { id: med('D1'), kind: 'thumbnail', legacy_ref: 'legacy:live:thumbnail:x.jpg' } });
    await expectUnresolved({ media_object_id: 'legacy:games:vod:42' }, 'not_found');   // another app's object
    await expectUnresolved({ legacy_ids: { network_user_id: 999 } }, 'not_found');
    await expectUnresolved({ legacy_ids: { live_user_id: 999 } }, 'not_found');

    // ── A deleted stream with a surviving VOD ────────────────
    d.prepare('DELETE FROM streams WHERE id = 11').run();
    await expectResolved({ vod_id: '48' }, { channel: aliceChannel, rule: 'stream_lookup', confidence: 'derived', via: ['vod:48', 'slot:3', 'user:17'],
        stream: { id: '11', slot_id: '3', slot_slug: 'garage-cam', missing: true }, vod: { id: '48', stream_id: '11', slot_id: '3' } });
    await expectResolved({ vod_id: '43' }, { rule: 'stream_lookup', stream: { id: '999999', slot_id: '3', slot_slug: 'garage-cam', missing: true } });
    await expectResolved({ vod_id: '44' }, { rule: 'legacy_metadata', confidence: 'derived', via: ['vod:44', 'user:17'], stream: { id: '999998', slot_id: '999997', slot_slug: null, missing: true } });
    await expectUnresolved({ vod_id: '45' }, 'not_found');
    r = await expectUnresolved({ vod_id: '47' }, 'not_found');                    // the recorded owner's account is gone
    assert.match(r.detail, /no longer has a Live account/);

    // ── clip -> VOD -> stream -> channel ─────────────────────
    r = await expectResolved({ clip_id: '7' }, { channel: aliceChannel, resolved_by: 'clip_id', rule: 'vod_parent', confidence: 'derived',
        via: ['clip:7', 'vod:42', 'stream:9', 'user:17'], clip: { id: '7', vod_id: '42', stream_id: null }, vod: { id: '42', stream_id: '9', slot_id: '3' }, stream: stream9 });
    assert.ok(!r.via.includes('user:18'), 'the clipper (bob) is never the channel');
    await expectResolved({ clip_id: '9' }, { rule: 'legacy_metadata', channel: aliceChannel });                   // only the recorded channel is left
    await expectUnresolved({ clip_id: '10' }, 'not_found');                                                        // only the clipper: nothing
    await expectResolved({ clip_id: '14' }, { rule: 'vod_parent', via: ['clip:14', 'vod:44', 'user:17'] });

    // ── Ambiguous subjects, owners without a channel, no input ─
    r = await expectUnresolved({ owner_subject: SHARED }, 'ambiguous');
    assert.deepStrictEqual(r.checked, [{ input: 'owner_subject', outcome: 'ambiguous' }]);
    r = await expectResolved({ slug: 'carol', owner_subject: SHARED }, { resolved_by: 'slug' });
    assert.deepStrictEqual(r.checked[1], { input: 'owner_subject', outcome: 'agrees', channel_slug: 'carol' });
    await expectUnresolved({ slug: 'erin', owner_subject: SHARED }, 'conflict');
    await expectUnresolved({ owner_subject: NOBODY }, 'not_found');
    r = await expectUnresolved({ slug: 'dave' }, 'not_found');
    assert.match(r.detail, /has no channel yet/);
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM channels WHERE user_id = 20').get().n, 0, 'resolving never creates a channel');
    assert.deepStrictEqual((({ status, userId, rule }) => ({ status, userId, rule }))(await lineage.resolveOwner({ slug: 'dave' })), { status: 'resolved', userId: 20, rule: 'explicit_slug' });
    assert.strictEqual((await lineage.resolveOwner({ vod_id: '47' })).userId, 999, 'resolveOwner reports the owner a record names');
    await expectUnresolved({}, 'no_input');
    await assert.rejects(lineage.resolveOwner({ slug: 'Not A Slug' }), /slug/);

    // ── Media down: nothing that needs it resolves ───────────
    mediaState.down = true;
    await expectUnresolved({ vod_id: '42' }, 'source_unavailable');
    await expectUnresolved({ slug: 'alice', vod_id: '42' }, 'source_unavailable');        // it might have disagreed
    await expectUnresolved({ media_object_id: med('A1') }, 'source_unavailable');
    await expectResolved({ slug: 'alice', stream_id: '9' }, { resolved_by: 'slug' });     // no Media needed
    mediaState.down = false;

    // ── The clips.js call site: stream, else the VOD's lineage, as before ─
    const { clipChannelOwnerId } = require('../server/media-proxy/clips')._internals;
    mediaState.calls = [];
    assert.strictEqual(await clipChannelOwnerId(CLIPS[8]), 17, 'clip stream');
    assert.deepStrictEqual(mediaState.calls, [], 'no Media read when the clip names a live stream row, and the clip is not re-read');
    assert.strictEqual(await clipChannelOwnerId(CLIPS[7]), 17, 'clip -> VOD -> stream');
    assert.deepStrictEqual(mediaState.calls, ['/api/v1/live/vods/42'], 'one VOD read, as before');
    assert.strictEqual(await clipChannelOwnerId(CLIPS[14]), 17, "a VOD whose stream and slot are gone still answers with its recorded owner");
    assert.strictEqual(await clipChannelOwnerId(CLIPS[15]), 999, 'the recorded owner is returned even when the account is gone, as before');
    assert.strictEqual(await clipChannelOwnerId(CLIPS[13]), 18, "the clip's own stream wins over its VOD");
    assert.strictEqual(await clipChannelOwnerId(CLIPS[9]), null, "the channel recorded on the clip does not decide here (it did not before)");
    assert.strictEqual(await clipChannelOwnerId(CLIPS[10]), null, 'the clipper never owns the channel');
    assert.strictEqual(await clipChannelOwnerId(CLIPS[12]), null, 'a VOD Media does not have');
    assert.strictEqual(await clipChannelOwnerId(null), null);
    mediaState.down = true;
    assert.strictEqual(await clipChannelOwnerId(CLIPS[7]), null, 'Media down: no owner, as before');
    mediaState.down = false;

    // ── GET|POST /internal/lineage/resolve ───────────────────
    const { serviceAuth } = contracts;
    const now = () => Math.floor(Date.now() / 1000);
    let jti = 0;
    const token = (cap) => serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:community', actor_type: 'service', aud: ['openvibe.live'], cap, iat: now(), exp: now() + 300, jti: `tok_lin_${++jti}` }, keys.privateKey);
    const app = express();
    app.use('/internal/lineage', require('../server/lineage/routes'));
    const server = await new Promise((ok) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => ok(s)); });
    const base = `http://127.0.0.1:${server.address().port}/internal/lineage/resolve`;
    const call = async (method, q, body, { cap = ['live.lineage.resolve'], headers = {} } = {}) => {
        const res = await fetch(`${base}${q ? `?${q}` : ''}`, {
            method, headers: { Authorization: `Bearer ${token(cap)}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, json: await res.json().catch(() => null), cache: res.headers.get('cache-control') };
    };
    assert.strictEqual((await fetch(`${base}?slug=alice`)).status, 401, 'no token');
    assert.strictEqual((await call('GET', 'slug=alice', null, { cap: ['live.follower.read'] })).status, 403, 'needs live.lineage.resolve');
    assert.strictEqual((await call('GET', 'slug=alice', null, { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 403, 'loopback only');
    let res = await call('GET', 'slug=alice&vod_id=42&live_user_id=17');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.cache, 'no-store');
    checkContract(res.json, 'GET');
    assert.deepStrictEqual([res.json.status, res.json.channel.slug, res.json.resolved_by, res.json.checked.length], ['resolved', 'alice', 'slug', 3]);
    res = await call('POST', '', { clip_id: '7', legacy_ids: { network_user_id: 57 } });
    checkContract(res.json, 'POST');
    assert.deepStrictEqual([res.status, res.json.rule, res.json.clip.id], [200, 'vod_parent', '7']);
    res = await call('GET', `display_name=${encodeURIComponent('Alice Wonder')}`);
    assert.deepStrictEqual([res.status, res.json.status, res.json.reason], [200, 'unresolved', 'display_name_only']);
    res = await call('POST', '', { slug: 'mallory', vod_id: '42' });
    assert.deepStrictEqual([res.status, res.json.reason], [200, 'conflict']);
    for (const [q, body] of [['username=alice', null], ['slug=Alice%20Wonder', null], ['', { owner_subject: '17' }], ['', { vod_id: '42', extra: 1 }], ['slug=a&slug=b', null]]) {
        res = await call(body ? 'POST' : 'GET', q, body);
        assert.deepStrictEqual([res.status, res.json.code], [400, 'lineage.invalid_request'], `${q || JSON.stringify(body)} is refused`);
    }
    server.close();
    mediaServer.close();

    // The request forms this route accepts are the contract's (when the installed contracts know it).
    if (contractKnown) {
        for (const req of [{ slug: '@alice' }, { slug: 'alice/cam' }, { display_name: 'x' }, { media_object_id: 'legacy:live:vod:1' }, { slug: 'Alice Wonder' }, { owner_subject: '17' }, { vod_id: 42 }, { legacy_ids: {} }, { username: 'a' }]) {
            const strict = contracts.validate('lineage.resolve-request@1', req).valid;
            const ours = !lineage.normalizeRequest(req).error;
            // Live also takes integer ids from its own callers; everything else matches the contract.
            if (!(typeof req.vod_id === 'number')) assert.strictEqual(ours, strict, `${JSON.stringify(req)}: Live ${ours}, contract ${strict}`);
        }
    }

    console.log = log;
    console.log(`lineage resolver: all checks passed (${contractKnown ? `${validated} answers validated against ${RESOLUTION}` : `installed openvibe-contracts ${require('openvibe-contracts/package.json').version} predates ${RESOLUTION}; contract validation skipped`})`);
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
