'use strict';
// AI text may describe people (owner, 2026-10-31: "there should be no reason it can't describe people… remove all that
// crap", and "dick is art… titties is art… stop being against art on my platform"). Frame notes, overviews, tags and
// titles are stored as the model wrote them, the old looks repair is gone, and no server file filters looks again.
// What stays is elsewhere: sex acts and porn are not promoted by the AI (test/ai-explicit.test.js).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
console.warn = () => {};

const db = require('../server/db/database');
(async () => {
    await db.initDb();
    await db.createUser({ username: 'describe', email: 'describe@x', password_hash: 'x', display_name: 'describe', stream_key: 'describe'.padEnd(32, '0') });
    const uid = (await db.get("SELECT id FROM users WHERE username = 'describe'")).id;
    const sid = Number((await db.createStream({ user_id: uid, title: 't', category: 'irl', protocol: 'rtmp' })).lastInsertRowid);

    const said = 'A shirtless man with a long beard sits in a room with framed pictures on the wall.';
    await db.addStreamMemory({ stream_id: sid, user_id: uid, offset_seconds: 5, description: said });
    const mem = await db.get('SELECT description FROM stream_memories WHERE stream_id = ?', [sid]);
    assert.strictEqual(mem.description, said, 'a frame note is stored as written');

    const overview = 'She has a hat and glasses on and paints a nude figure study while chatting.';
    await db.updateStreamAiOverview(sid, overview);
    const row = await db.get('SELECT ai_overview, ai_overview_short FROM streams WHERE id = ?', [sid]);
    assert.strictEqual(row.ai_overview, overview, 'an overview is stored as written');
    assert.strictEqual(row.ai_overview_short, overview, 'and so is its card line');

    await db.setStreamAiTitle(sid, 'Woman In Red Dress Paints');
    assert.strictEqual((await db.get('SELECT ai_title FROM streams WHERE id = ?', [sid])).ai_title, 'Woman In Red Dress Paints');

    // The cleanup pass still mends JSON-wrapped text, and no longer rewrites how anyone is described.
    await db.run('UPDATE streams SET ai_overview = ? WHERE id = ?', ['{"description":"A man in a hoodie waves."}', sid]);
    await db.cleanupMalformedAiText();
    assert.strictEqual((await db.get('SELECT ai_overview FROM streams WHERE id = ?', [sid])).ai_overview, 'A man in a hoodie waves.');

    // No server file filters looks again (the SDK's no-looks is deprecated and returns what it is given).
    const offenders = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js') && /\b(noLooks|noLooksTags|hasLooks)\s*\(|openvibe-sdk\/no-looks/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(path.join(__dirname, '..'), p));
        }
    };
    walk(path.join(__dirname, '..', 'server'));
    assert.deepStrictEqual(offenders, [], 'no looks filter in server/');

    // Vibe's voice prompt has no looks ban.
    assert.ok(!/looks, body, clothing/.test(fs.readFileSync(path.join(__dirname, '..', 'server/ai/vibe-voice.js'), 'utf8')));

    console.log('AI text: describing people is stored as written; no looks filter or repair remains');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
