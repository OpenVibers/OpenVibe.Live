/**
 * Regression tests for credential redaction on client-facing stream payloads.
 *
 * Two separate endpoints have shipped a live ingest key to anonymous callers, because the shared
 * query selects `managed_stream_key` for the publish paths and each response had to remember to
 * remove it. These tests pin the helper's behaviour and assert that the known-leaking call sites
 * route through it.
 *
 *   node test/security-redaction.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const ok = (name) => { pass++; console.log('  ok -', name); };

// ── publicStream() strips both credentials and keeps everything else ──────────
{
    const src = fs.readFileSync(path.join(ROOT, 'server/db/database.js'), 'utf8');
    const m = src.match(/function publicStream\(row\) \{[\s\S]*?\n\}/);
    assert(m, 'publicStream() should exist in server/db/database.js');
    // eslint-disable-next-line no-new-func
    const publicStream = new Function(`${m[0]}; return publicStream;`)();

    const row = {
        id: 7, title: 'a stream', viewer_count: 12, username: 'someone',
        stream_key: 'SECRET-USER-KEY', managed_stream_key: 'SECRET-SLOT-KEY',
    };
    const out = publicStream(row);
    assert.strictEqual(out.stream_key, undefined, 'stream_key must be removed');
    assert.strictEqual(out.managed_stream_key, undefined, 'managed_stream_key must be removed');
    assert.strictEqual(out.id, 7);
    assert.strictEqual(out.title, 'a stream');
    assert.strictEqual(out.viewer_count, 12);
    assert.strictEqual(out.username, 'someone');
    ok('publicStream removes both keys and preserves every other field');

    assert.strictEqual(publicStream(null), null, 'null passes through');
    assert.strictEqual(publicStream(undefined), undefined, 'undefined passes through');
    ok('publicStream tolerates null/undefined');

    // The original must not be mutated — callers may still need the key for the publish path.
    assert.strictEqual(row.stream_key, 'SECRET-USER-KEY', 'input row must not be mutated');
    ok('publicStream does not mutate its input');
}

// ── The two endpoints that leaked must go through a redaction step ────────────
{
    const media = fs.readFileSync(path.join(ROOT, 'server/media/routes.js'), 'utf8');
    assert(/live_stream:\s*db\.publicStream\(/.test(media),
        'GET /api/media/channel/:username must redact live_stream');
    ok('media channel endpoint redacts live_stream');

    const streaming = fs.readFileSync(path.join(ROOT, 'server/streaming/routes.js'), 'utf8');
    assert(/delete out\.managed_stream_key/.test(streaming),
        'GET /api/streams must delete managed_stream_key');
    assert(/delete out\.stream_key/.test(streaming),
        'GET /api/streams must delete stream_key');
    ok('public stream list redacts both keys');
}

// ── Escaping helpers used in HTML attribute context must escape quotes ────────
{
    const emotes = fs.readFileSync(path.join(ROOT, 'public/js/emotes.js'), 'utf8');
    const m = emotes.match(/function _escEmote\(str\) \{[\s\S]*?\n\}/);
    assert(m, '_escEmote should exist');
    // eslint-disable-next-line no-new-func
    const escEmote = new Function(`${m[0]}; return _escEmote;`)();
    assert.strictEqual(escEmote('x"y'), 'x&quot;y', 'double quote must be escaped');
    assert.strictEqual(escEmote("x'y"), 'x&#39;y', 'single quote must be escaped');
    assert.strictEqual(escEmote('<b>'), '&lt;b&gt;', 'angle brackets must be escaped');
    assert.strictEqual(escEmote('a&b'), 'a&amp;b', 'ampersand must be escaped');
    ok('_escEmote escapes quotes as well as angle brackets');

    // The emote token grammar must not admit a quote in the first place.
    const re = emotes.match(/const _KICK_EMOTE_RE = (\/.*\/g);/);
    assert(re, 'kick emote regex should exist');
    // eslint-disable-next-line no-eval
    const rx = eval(re[1]);
    rx.lastIndex = 0;
    assert.strictEqual(rx.test('[emote:1:x" onerror=alert(1) y="]'), false,
        'a token containing a quote must not match');
    rx.lastIndex = 0;
    assert.strictEqual(rx.test('[emote:5747992:collectiblespepega]'), true,
        'a legitimate token must still match');
    ok('kick emote token grammar rejects quotes and keeps valid names');
}

// ── app.js esc() is used inside double-quoted attributes ──────────────────────
{
    const app = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    const m = app.match(/function esc\(str\) \{[\s\S]*?\n\}/);
    assert(m, 'esc should exist in app.js');
    // eslint-disable-next-line no-new-func
    const esc = new Function(`${m[0]}; return esc;`)();
    assert.strictEqual(esc('x"y'), 'x&quot;y', 'esc must escape double quotes');
    assert.strictEqual(esc(0), '0', 'esc(0) must be "0", not empty');
    ok('app.js esc escapes double quotes and preserves 0');

    // There must be exactly one definition of esc across the loaded bundle, or load order
    // silently decides which escaping rules apply.
    const chat = fs.readFileSync(path.join(ROOT, 'public/js/chat.js'), 'utf8');
    assert(!/^function esc\(/m.test(chat), 'chat.js must not redefine esc');
    ok('esc is defined once, not resolved by script load order');
}

// ── OAuth callback pages must not reflect provider text into HTML or script ───
{
    for (const f of ['server/streaming/restream-routes.js', 'server/integrations/powerchat-routes.js']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        assert(/function escHtml\(/.test(src), `${f} should define escHtml`);
        assert(/function jsonForScript\(/.test(src), `${f} should define jsonForScript`);
        assert(/jsonForScript\(payload\)/.test(src), `${f} must serialise the payload safely`);
        assert(!/\$\{payload\.error \|\| 'Something went wrong\.'\}/.test(src),
            `${f} must not interpolate payload.error unescaped`);
    }
    ok('both OAuth callback pages escape provider-supplied text');
}

// ── WHIP: a valid session token is not proof the slot is yours ───────────────
{
    const src = fs.readFileSync(path.join(ROOT, 'server/streaming/whip-handler.js'), 'utf8');
    // The JWT fall-through happens when the supplied key does not match the slot. Before the
    // ownership check, any signed-in account could open a publish session against any slot id.
    // Anchor on the call, not the name: the surrounding comment mentions it too.
    const fall = src.match(/if \(managedStream\.stream_key !== streamKey\) \{[\s\S]*?stream = autoCreateWhipSession\(/);
    assert(fall, 'the JWT fall-through path should still exist');
    assert(/managedStream\.user_id !== user\.id/.test(fall[0]),
        'the JWT fall-through must reject a slot the caller does not own');
    assert(/not_slot_owner/.test(fall[0]), 'the rejection should be explicit, not a generic 401');
    assert(fall[0].indexOf('managedStream.user_id !== user.id') < fall[0].indexOf('stream = autoCreateWhipSession('),
        'ownership must be checked before a session is created');
    ok('WHIP slot auth rejects a JWT holder who does not own the slot');
}

// ── Cross-channel chat logs are moderator data ───────────────────────────────
{
    const src = fs.readFileSync(path.join(ROOT, 'server/admin/mod-routes.js'), 'utf8');
    for (const route of ["'/chat/search'", "'/chat/user/:userId'"]) {
        const m = src.match(new RegExp(`router\\.get\\(${route.replace(/[/:]/g, m2 => '\\' + m2)},([^,]*),`));
        assert(m, `${route} should still be registered`);
        assert(/requireGlobalMod/.test(m[1]),
            `${route} searches every channel and must require a global mod, not just a signed-in user`);
    }
    ok('unscoped chat-log endpoints require a global moderator');
}

// ── A channel moderator must not be handed the streamer's ingest key ─────────
{
    const db = fs.readFileSync(path.join(ROOT, 'server/db/database.js'), 'utf8');
    const q = db.match(/function getChannelByUsername\(username\) \{[\s\S]*?\n\}/);
    assert(q, 'getChannelByUsername should exist');
    // If the query ever stops selecting the key this test can relax; while it does, every
    // mod-reachable response built from it has to redact.
    if (/u\.stream_key/.test(q[0])) {
        const routes = fs.readFileSync(path.join(ROOT, 'server/streaming/routes.js'), 'utf8');
        const about = routes.match(/const updated = db\.getChannelByUsername\(req\.params\.username\);[\s\S]{0,600}?res\.json\(\{ channel: updated/);
        assert(about, 'the About-update response should still exist');
        assert(/delete updated\.stream_key/.test(about[0]),
            'the About-update response is reachable by channel mods and must not include stream_key');
        ok('the mod-reachable channel response redacts the ingest key');
    } else {
        ok('getChannelByUsername no longer selects stream_key');
    }
}

// ── A signed OAuth state proves we issued it, not that the slot is yours ─────
{
    const src = fs.readFileSync(path.join(ROOT, 'server/streaming/restream-routes.js'), 'utf8');
    const cb = src.match(/const userId = stateData\.userId;[\s\S]*?destProvisioned = true;/);
    assert(cb, 'the OAuth callback should still provision a destination');
    assert(/slot\.user_id !== userId/.test(cb[0]),
        'the callback must confirm the state\'s managed_stream_id belongs to the authenticating user');
    assert(cb[0].indexOf('slot.user_id !== userId') < cb[0].indexOf('createRestreamDestination'),
        'ownership must be checked before a destination is created');
    ok('restream OAuth callback will not provision onto another account\'s slot');
}

// ── server_url becomes ffmpeg's output argument, so it must be a streaming URL ─
{
    const src = fs.readFileSync(path.join(ROOT, 'server/streaming/restream-routes.js'), 'utf8');
    const m = src.match(/function validateIngestUrl\(raw\) \{[\s\S]*?\n\}/);
    assert(m, 'validateIngestUrl should exist');
    const protoLine = src.match(/const ALLOWED_INGEST_PROTOCOLS = new Set\(\[[^\]]*\]\)/);
    assert(protoLine, 'the protocol allowlist should exist');
    // eslint-disable-next-line no-new-func
    const validate = new Function(`${protoLine[0]}; ${m[0]}; return validateIngestUrl;`)();
    for (const good of ['rtmp://a.rtmp.youtube.com/live2', 'rtmps://live.twitch.tv/app', 'srt://ingest.example:9000']) {
        assert.strictEqual(validate(good).ok, true, `${good} should be accepted`);
    }
    for (const bad of [
        '/opt/openvibe.live/public/js/app.js',   // ffmpeg would write an FLV over served script
        'file:///etc/passwd',
        'http://169.254.169.254/latest/meta-data/',
        'pipe:1',
        'rtmp://',                                // no host
        'rtmp://host/path\nmore',                // control character
        '',
    ]) {
        assert.strictEqual(validate(bad).ok, false, `${bad} must be rejected`);
    }
    ok('restream ingest URLs accept only rtmp/rtmps/srt with a host');

    // And the manager refuses anything that slipped in before the API validated it.
    const mgr = fs.readFileSync(path.join(ROOT, 'server/streaming/restream-manager.js'), 'utf8');
    const build = mgr.match(/_buildDestUrl\(dest\) \{[\s\S]*?\n    \}/);
    assert(build, '_buildDestUrl should exist');
    assert(/rtmps\?\|srt/.test(build[0]), '_buildDestUrl must re-check the protocol for rows already stored');
    ok('the restream manager re-checks the protocol before handing it to ffmpeg');
}

// ── /api/media/quote is unauthenticated, so it must not probe internal hosts ──
{
    const src = fs.readFileSync(path.join(ROOT, 'server/media/media-queue.js'), 'utf8');
    const fn = src.match(/function isInternalAddress\(ip\) \{[\s\S]*?\n\}/);
    assert(fn, 'isInternalAddress should exist');
    // eslint-disable-next-line no-new-func
    const isInternal = new Function('net', `${fn[0]}; return isInternalAddress;`)(require('net'));
    for (const blocked of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '172.16.5.5', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
        assert.strictEqual(isInternal(blocked), true, `${blocked} must count as internal`);
    }
    for (const allowed of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) {
        assert.strictEqual(isInternal(allowed), false, `${allowed} should be reachable`);
    }
    assert(/await assertFetchableUrl\(url\)/.test(src), 'the generic yt-dlp branch must check the URL first');
    assert(/url\.protocol !== 'http:' && url\.protocol !== 'https:'/.test(src), 'non-http schemes must be rejected on entry');
    ok('media quote refuses internal addresses and non-http schemes');
}

// ── A ban has to stop commands too, not just plain messages ──────────────────
{
    const src = fs.readFileSync(path.join(ROOT, 'server/chat/chat-server.js'), 'utf8');
    const fnStart = src.indexOf('handleChatMessage(ws, client, msg) {');
    assert(fnStart > 0, 'handleChatMessage should exist');
    const body = src.slice(fnStart, fnStart + 3000);
    const banAt = body.indexOf('db.isUserBanned(client.user.id, client.streamId)');
    const bangAt = body.indexOf("text.startsWith('!')");
    const slashAt = body.indexOf("text.startsWith('/')");
    assert(banAt > 0 && bangAt > 0 && slashAt > 0, 'all three branches should be present');
    assert(banAt < bangAt && banAt < slashAt,
        'the ban check must run before the "!" and "/" command dispatch, which both return early');
    ok('banned users cannot run ! or / chat commands');
}

// ── A private VOD's context must be authorised before the cache is consulted ──
{
    const src = fs.readFileSync(path.join(ROOT, 'server/media-proxy/vods.js'), 'utf8');
    const h = src.match(/router\.get\('\/:id\/context'[\s\S]*?res\.json\(data\);/);
    assert(h, 'the VOD context route should exist');
    const checkAt = h[0].indexOf("vod.visibility === 'private'");
    const cacheAt = h[0].indexOf('_ctxCache.get(id)');
    assert(checkAt > 0 && cacheAt > 0, 'both the visibility check and the cache read should be present');
    assert(checkAt < cacheAt, 'the visibility check must run before the cache is read');
    assert(/private, no-store/.test(h[0]), 'a private VOD context must not be sent with a shareable Cache-Control');
    ok('private VOD context is authorised before the cache, and never shareable');
}

console.log(`\n${pass} checks passed`);
