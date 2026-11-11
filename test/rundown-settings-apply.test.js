'use strict';
/**
 * "Apply to all my existing episodes" (VISIBILITY-EVERYWHERE rule 2, My Rundown): the default moves the
 * streamer's live episodes, and only theirs; Specific people stays a per-episode choice.
 */
const assert = require('assert');
const db = require('../server/db/database');

(async () => {
    await db.initDb();
    const settings = require('../server/rundown/settings');
    const sharing = require('../server/rundown/sharing');

    const SUB_GOOSE = 'usr_01HQZX9K3M5N7P8R9T0V1W2XYZ';
    const mk = async (username) => {
        await db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: username, stream_key: username.padEnd(32, '0') });
        const id = Number((await db.get('SELECT id FROM users WHERE username = ?', [username])).id);
        await db.ensureChannel(id);
        return id;
    };
    const goose = await mk('goosely');
    const other = await mk('watcher');
    const NOW = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const stream = async (user, title) => {
        const id = Number((await db.createStream({ user_id: user, title, category: 'Science & Technology', protocol: 'rtmp' })).lastInsertRowid);
        await db.run('UPDATE streams SET is_live = 0, started_at = ?, ended_at = ? WHERE id = ?', [NOW, NOW, id]);
        await db.run("INSERT INTO rundown_episodes (stream_id, user_id, title, aired_at, status) VALUES (?, ?, ?, ?, 'live')", [id, user, title, NOW]);
        return id;
    };
    const a = await stream(goose, 'Episode A');
    const b = await stream(goose, 'Episode B');
    const theirs = await stream(other, 'Not mine');
    assert.strictEqual(await sharing.register(a, SUB_GOOSE, 'public'), true);
    assert.strictEqual(await sharing.register(b, SUB_GOOSE, 'public'), true);
    assert.strictEqual(await sharing.register(theirs, 'usr_01HQZX9K3M5N7P8R9T0V1W2XZC', 'public'), true);
    const aud = async (id) => (await db.get("SELECT audience FROM shares WHERE service = 'live' AND kind = 'rundown-episode' AND resource_id = ?", [String(id)])).audience;

    const applied = await settings.applyToEpisodes(goose, SUB_GOOSE, 'private');
    assert.strictEqual(applied, 2, 'both of Goose’s live episodes');
    assert.strictEqual(await aud(a), 'private');
    assert.strictEqual(await aud(b), 'private');
    assert.strictEqual(await aud(theirs), 'public', 'somebody else’s episode is untouched');

    const back = await settings.applyToEpisodes(goose, SUB_GOOSE, 'link');
    assert.strictEqual(back, 2);
    assert.strictEqual(await aud(a), 'link');
    assert.strictEqual(await aud(b), 'link');
    assert.strictEqual(await aud(theirs), 'public');

    await assert.rejects(() => settings.applyToEpisodes(goose, SUB_GOOSE, 'people'), (err) => err.status === 400);
    assert.strictEqual(await aud(a), 'link', 'a refused apply changes nothing');
    console.log('\nall passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
