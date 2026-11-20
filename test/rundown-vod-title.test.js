'use strict';
// A recording named by Live's default takes its Rundown episode's title (server/rundown/vod-title.js; the owner's
// register #908, 2026-11-20). On the real schema, with OpenVibe.Media stood in for:
//   - "iZoR_One's Stream", "Untitled Stream", "<name>'s Channel" are defaults; "Bob's stream" on someone else's
//     channel and any typed title are not;
//   - a default-named recording with a public episode gets the episode's title in Media, once;
//   - a recording someone named, a hidden episode, an episode shared with nobody, and an episode title the
//     explicit rule refuses are left alone; Media away is tried again on the next run.
//   node test/rundown-vod-title.test.js
const assert = require('assert');
const db = require('../server/db/database');
const media = require('../server/media-client');
const vt = require('../server/rundown/vod-title');

(async () => {
    let failures = 0;
    const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.log(`  ✗ ${name}\n    ${err.stack}`); } };
    await db.initDb();
    const d = db.getDb();
    await d.prepare('INSERT INTO users (id, username, display_name, password_hash) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?)').run(80, 'iZoR_One', 'iZoR_One', '$sso$');
    const aired = new Date(Date.now() - 3600_000).toISOString().replace('T', ' ').slice(0, 19);
    const episode = async (sid, vod, title, status = 'live') => {
        await d.prepare('INSERT INTO streams (id, user_id, title, is_live) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, 0)').run(sid, 80, "iZoR_One's Stream");
        await d.prepare('INSERT INTO rundown_episodes (stream_id, user_id, title, vod_id, aired_at, status) VALUES (?, ?, ?, ?, ?, ?)').run(sid, 80, title, vod, aired, status);
    };
    await episode(801, 9801, 'Loud Mic, Bait Boxes & Helcoin Rants');
    await episode(802, 9802, 'Ten Percent Earring Whoops');
    await episode(803, 9803, 'Stone Diplomacy', 'hidden');
    await episode(804, 9804, 'A Quiet One');
    await episode(805, 9805, 'Having sex on stream');
    await episode(806, 9806, 'Media Was Away');
    await d.prepare("INSERT INTO shares (service, kind, resource_id, owner_subject, audience) VALUES ('live', 'rundown-episode', '804', ?::jsonb, 'private')").run(JSON.stringify({ type: 'user', id: 'usr_test' }));
    const titles = { 9801: "iZoR_One's Stream", 9802: 'My big boss fight', 9803: "iZoR_One's Stream", 9804: 'Untitled Stream', 9805: "iZoR_One's Stream", 9806: "iZoR_One's Stream" };
    const updates = [];
    let away = true;
    media.getVod = async (id) => { if (Number(id) === 9806 && away) throw new Error('timeout'); return { id: Number(id), title: titles[id] }; };
    media.updateVod = async (id, fields) => { updates.push([Number(id), fields.title]); titles[id] = fields.title; return {}; };
    const said = console.log; console.log = (...a) => { if (!/^\[Rundown\]/.test(String(a[0]))) said(...a); };

    await check('Live\'s defaults are defaults; a typed title is not', async () => {
        const u = { username: 'iZoR_One', display_name: 'iZoR_One' };
        for (const t of ["iZoR_One's Stream", "izor_one's stream", 'Untitled Stream', "iZoR_One's Channel", "iZoR_One’s stream", '', 'Stream recording']) assert.ok(vt.isDefaultTitle(t, u), t);
        for (const t of ["Bob's stream", 'Boss fight night', "iZoR_One's Stream of Consciousness"]) assert.ok(!vt.isDefaultTitle(t, u), t);
    });
    await check('a default-named recording gets its public episode\'s title; the others are left alone', async () => {
        const out = await vt.titleRecordings();
        assert.deepStrictEqual(updates, [[9801, 'Loud Mic, Bait Boxes & Helcoin Rants']], JSON.stringify(updates));
        assert.strictEqual(titles[9802], 'My big boss fight', 'a typed title stays');
        assert.strictEqual(titles[9803], "iZoR_One's Stream", 'a hidden episode lends nothing');
        assert.strictEqual(titles[9804], 'Untitled Stream', 'an episode shared with nobody lends nothing');
        assert.strictEqual(titles[9805], "iZoR_One's Stream", 'a title the explicit rule refuses is not used');
        assert.deepStrictEqual([out.named, out.kept], [1, 4]);
    });
    await check('each stream is decided once; Media away is tried again', async () => {
        away = false;
        const out = await vt.titleRecordings();
        assert.deepStrictEqual(updates.slice(1), [[9806, 'Media Was Away']]);
        assert.strictEqual(out.named, 1);
        const again = await vt.titleRecordings();
        assert.deepStrictEqual([again.named, updates.length], [0, 2], 'nothing twice');
    });
    await check('given streams only', async () => {
        vt._reset();
        titles[9802] = "iZoR_One's Stream";
        const out = await vt.titleRecordings({ streamIds: [802] });
        assert.deepStrictEqual([out.named, updates[updates.length - 1]], [1, [9802, 'Ten Percent Earring Whoops']]);
    });
    console.log = said;
    if (failures) { console.log(`recording titles: ${failures} failed`); process.exit(1); }
    console.log('recording titles: default-named recordings take their public episode\'s title, once');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
