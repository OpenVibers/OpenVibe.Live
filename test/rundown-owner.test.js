'use strict';
/**
 * The owner's tools on The Rundown (RUNDOWN-CONTROLS design 2026-11-06): the episode and streamer reads say whether
 * the reader owns the page (`mine`), so the page draws Share and Delete for the streamer only, and an episode written
 * up before the sharing system existed is registered as Everyone the first time its owner opens it, so the Share sheet
 * has a row to change. Nobody else's visit registers anything.
 */
const assert = require('assert');
const db = require('../server/db/database');

(async () => {
    await db.initDb();
    const read = require('../server/rundown/read');
    const sharing = require('../server/rundown/sharing');

    const SUB_OWNER = 'usr_01HQZX9K3M5N7P8R9T0V1W2XQW';
    const SUB_OTHER = 'usr_01HQZX9K3M5N7P8R9T0V1W2XQT';
    const mk = async (username) => {
        await db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: username, stream_key: username.padEnd(32, '0') });
        const id = Number((await db.get('SELECT id FROM users WHERE username = ?', [username])).id);
        await db.ensureChannel(id);
        return id;
    };
    const owner = await mk('ownerly');
    const other = await mk('otherly');
    const NOW = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const streamId = Number((await db.createStream({ user_id: owner, title: 'Old one', category: 'Just Chatting', protocol: 'rtmp' })).lastInsertRowid);
    await db.run("UPDATE streams SET is_live = 0, started_at = datetime('now', '-120 minutes'), ended_at = datetime('now', '-30 minutes'), duration_seconds = 5400 WHERE id = ?", [streamId]);
    // Written up before the sharing system: an episode with no share row.
    await db.run("INSERT INTO rundown_episodes (stream_id, user_id, title, logline, vod_id, minutes, aired_at) VALUES (?, ?, 'Before sharing', 'An old one.', 5151, 90, ?)", [streamId, owner, NOW]);
    const shareRow = () => db.get("SELECT audience FROM shares WHERE service = 'live' AND kind = 'rundown-episode' AND resource_id = ?", [String(streamId)]);
    assert.strictEqual(await shareRow(), undefined, 'the old episode starts with no share row');

    const asOther = await read.episode(streamId, { viewer: { key: 'user:other', userId: other, subject: SUB_OTHER } });
    assert.ok(asOther, 'anybody opens an Everyone episode');
    assert.strictEqual(asOther.mine, false, 'another reader does not own it');
    assert.strictEqual(await shareRow(), undefined, 'another reader\'s visit registers nothing');
    const anon = await read.episode(streamId, { viewer: null });
    assert.strictEqual(anon.mine, false, 'nor does a signed-out reader');

    const asOwner = await read.episode(streamId, { viewer: { key: 'user:owner', userId: owner, subject: SUB_OWNER } });
    assert.strictEqual(asOwner.mine, true, 'the streamer owns their episode');
    assert.strictEqual(asOwner.episode.audience, 'public', 'it is Everyone');
    if (sharing.available()) {
        const row = await shareRow();
        assert.ok(row, 'the owner\'s first visit registers the episode');
        assert.strictEqual(row.audience, 'public', 'as Everyone, what it already was');
        // A second visit keeps whatever the owner chose since.
        await db.run("UPDATE shares SET audience = 'private' WHERE service = 'live' AND kind = 'rundown-episode' AND resource_id = ?", [String(streamId)]);
        await read.episode(streamId, { viewer: { key: 'user:owner', userId: owner, subject: SUB_OWNER } });
        assert.strictEqual((await shareRow()).audience, 'private', 'registering again never overrules the owner\'s choice');
        assert.strictEqual(await read.episode(streamId, { viewer: { key: 'user:other', userId: other, subject: SUB_OTHER } }), null, 'and Only me is closed to others');
    }

    const page = await read.streamer('ownerly', { viewer: { key: 'user:owner', userId: owner, subject: SUB_OWNER } });
    assert.strictEqual(page.mine, true, 'the streamer owns their Rundown page');
    const seen = await read.streamer('ownerly', { viewer: { key: 'user:other', userId: other, subject: SUB_OTHER } });
    assert.strictEqual(seen.mine, false, 'another reader does not');
    await db.run('INSERT INTO arena_opt_outs (user_id) VALUES (?) ON CONFLICT DO NOTHING', [owner]);
    const out = await read.streamer('ownerly', { viewer: { key: 'user:owner', userId: owner, subject: SUB_OWNER } });
    assert.strictEqual(out.opted_out, true, 'a streamer who keeps out of The Rundown');
    assert.strictEqual(out.mine, true, 'still gets their own page, to come back');

    console.log('rundown owner: mine on the episode and streamer pages; an old episode registers as Everyone on its owner\'s first visit');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
