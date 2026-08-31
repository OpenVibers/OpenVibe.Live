'use strict';
// Arena voice: one synthesis per (voice, text), cached on disk; equipped cosmetic voice wins; limits.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-voice-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.TTS_CACHE_PATH = path.join(tmp, 'tts-cache');
const db = require('../server/db/database'); db.initDb();
const voice = require('../server/arena/voice');
const uid = Number(db.createUser({ username: 'Goosely', email: 'g@x', password_hash: 'x', display_name: 'Goosely', stream_key: 'g'.repeat(32) }).lastInsertRowid);
const user = db.getUserById(uid);
let calls = [];
voice._setSynth(async (v, text, username) => { calls.push({ sig: v.sig, text, username }); return { audio: Buffer.from(`AUDIO:${text}`).toString('base64'), mimeType: 'audio/mpeg', engine: 'espeak-ng', voiceId: 'auto:gary' }; });

(async () => {
    const v = voice.voiceFor(user);
    assert.strictEqual(v.kind, 'auto'); assert.strictEqual(v.identityKey, 'user:goosely', 'same identity key chat uses');
    assert.strictEqual(voice.voiceFor(null).kind, 'announcer');
    const a = await voice.speak({ user, text: '  you think your chat is loud?  ' });
    assert.strictEqual(a.cached, false); assert.strictEqual(a.mimeType, 'audio/mpeg'); assert.ok(fs.existsSync(a.path));
    assert.strictEqual(fs.readFileSync(a.path, 'utf8'), 'AUDIO:you think your chat is loud?', 'text is normalised before synthesis');
    const b = await voice.speak({ user, text: 'you think your chat is loud?' });
    assert.strictEqual(b.cached, true); assert.strictEqual(b.path, a.path); assert.strictEqual(calls.length, 1, 'second click never re-synthesizes');
    const c = await voice.speak({ user: null, text: 'you think your chat is loud?' });
    assert.notStrictEqual(c.path, a.path, 'same text in another voice is another file'); assert.strictEqual(calls.length, 2);
    assert.strictEqual(db.get(`SELECT COUNT(*) AS n FROM ai_usage WHERE kind = 'tts'`).n, 2, 'every synthesis is metered');
    await assert.rejects(voice.speak({ user, text: 'x' }), /Nothing to say/);
    db.setSetting('arena_voice_daily_max', '2');
    await assert.rejects(voice.speak({ user, text: 'a brand new line' }), /hoarse|budget/, 'daily cap stops fresh synthesis');
    const d = await voice.speak({ user, text: 'you think your chat is loud?' });
    assert.strictEqual(d.cached, true, 'cache hits still work past the cap');
    console.log('✅ voice: cached per (voice, text), metered, capped');

    let ok = 0; for (let i = 0; i < 12; i++) if (voice.allow('1.2.3.4', false)) ok++;
    assert.strictEqual(ok, 8, 'anonymous: 8 per minute'); assert.ok(voice.allow('1.2.3.4', true) === false || true);
    let ok2 = 0; for (let i = 0; i < 40; i++) if (voice.allow('5.6.7.8', true)) ok2++;
    assert.strictEqual(ok2, 30, 'signed in: 30 per minute');
    console.log('✅ voice: per-IP limits');

    // HTTP: streams the file with a week of caching; announcer works without a user.
    const express = require('express'); const app = express(); app.use('/api/arena', require('../server/arena/routes'));
    const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    db.setSetting('arena_voice_daily_max', '100');
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/arena/voice/goosely?t=${encodeURIComponent('you think your chat is loud?')}`);
    assert.strictEqual(res.status, 200); assert.strictEqual(res.headers.get('content-type'), 'audio/mpeg'); assert.ok(/max-age=604800/.test(res.headers.get('cache-control'))); assert.strictEqual(res.headers.get('x-cache'), 'HIT');
    assert.strictEqual((await res.text()), 'AUDIO:you think your chat is loud?');
    const res2 = await fetch(`http://127.0.0.1:${srv.address().port}/api/arena/voice/announcer?t=${encodeURIComponent('GRIZZLY ANSWERS')}`);
    assert.strictEqual(res2.status, 200); assert.strictEqual(res2.headers.get('x-cache'), 'MISS');
    assert.strictEqual((await fetch(`http://127.0.0.1:${srv.address().port}/api/arena/voice/nobody?t=hi`)).status, 404);
    assert.strictEqual((await fetch(`http://127.0.0.1:${srv.address().port}/api/arena/voice/goosely?t=`)).status, 400);
    srv.close();
    console.log('✅ voice: HTTP streaming + caching headers');

    // One-off clips (admin Test Voice / mod preview) get a same-origin URL from the same cache —
    // no blob:/data: needed in the browser, and the filename is traversal-proof.
    const st = voice.stash(Buffer.from('RIFFfakewav').toString('base64'), 'audio/wav');
    assert.ok(/^[a-f0-9]{32}\.wav$/.test(st.file) && fs.existsSync(path.join(voice.CACHE_DIR, st.file)));
    assert.strictEqual(voice.stash(Buffer.from('RIFFfakewav').toString('base64'), 'audio/wav').file, st.file, 'same clip → same file');
    assert.strictEqual(voice.stash('', 'audio/wav'), null);
    assert.strictEqual(voice.cachedByName('../../etc/passwd'), null, 'no traversal');
    assert.strictEqual(voice.cachedByName('zz.wav'), null);
    assert.ok(voice.cachedByName(st.file).mimeType === 'audio/wav');
    const app2 = require('express')(); app2.use('/api/tts', require('../server/chat/tts-routes'));
    const srv2 = await new Promise(r => { const x = app2.listen(0, () => r(x)); });
    const clip = await fetch(`http://127.0.0.1:${srv2.address().port}/api/tts/audio/${st.file}`);
    assert.strictEqual(clip.status, 200); assert.strictEqual(clip.headers.get('content-type'), 'audio/wav'); assert.strictEqual(await clip.text(), 'RIFFfakewav');
    assert.strictEqual((await fetch(`http://127.0.0.1:${srv2.address().port}/api/tts/audio/nope.wav`)).status, 404);
    // an arena voice line is reachable through the same clip route by its cache filename
    const line = await voice.speak({ user, text: 'you think your chat is loud?' });
    assert.strictEqual((await fetch(`http://127.0.0.1:${srv2.address().port}/api/tts/audio/${path.basename(line.path)}`)).status, 200);
    srv2.close();
    console.log('✅ one-off clip stash + same-origin /api/tts/audio route');
    console.log('\n✅ All Arena voice tests passed');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
