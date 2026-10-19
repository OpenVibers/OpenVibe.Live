'use strict';
/**
 * The Rundown's chat commands (server/rundown/chat-commands.js): the Arena's three, which Chat still forwards.
 *   !hype, !beef      beefs are gone: a pointer to The Rundown
 *   !arena [user]     the streamer's latest episode and topics, a streamer who opted out, nobody by that name
 *   other commands    not ours (the Arena's !topic, !bounty and !board are gone)
 */
const assert = require('assert');
const db = require('../server/db/database');

(async () => {
await db.initDb();
const chat = require('../server/rundown/chat-commands');
const read = require('../server/rundown/read');

const mk = async (username) => {
    await db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: username[0].toUpperCase() + username.slice(1), stream_key: username.padEnd(32, '0') });
    const id = (await db.get('SELECT id FROM users WHERE username = ?', [username])).id;
    await db.ensureChannel(id);
    return id;
};
const nova = await mk('nova'), quiet = await mk('quietguy'), viewer = await mk('viewer');
const liveId = Number((await db.createStream({ user_id: nova, title: 'Night', category: 'irl', protocol: 'rtmp' })).lastInsertRowid);
const ended = Number((await db.createStream({ user_id: nova, title: 'Fridges', category: 'irl', protocol: 'rtmp' })).lastInsertRowid);
await db.run("UPDATE streams SET is_live = 0, ended_at = ov_now() WHERE id = ?", [ended]);
const topic = (await db.run("INSERT INTO rundown_topics (slug, title, kind, first_seen_at, last_seen_at) VALUES ('fridges', 'Fridges', 'tech', ov_now(), ov_now()) RETURNING id")).lastInsertRowid;
await db.run("INSERT INTO rundown_segments (stream_id, user_id, topic_id, start_sec, end_sec, title, what, score, said_at) VALUES (?, ?, ?, 1, 9, 'Fridge take', 'nova on fridges.', 4, ov_now())", [ended, nova, topic]);
await db.run("INSERT INTO rundown_episodes (stream_id, user_id, title, recap, chapters_json, aired_at) VALUES (?, ?, 'The Fridge Files', 'x', '[]', ov_now())", [ended, nova]);

const sent = [];
let pending = [];
// track() is how a caller that answers once waits for the command's replies (Chat's arena-command call).
const fakeChat = { sendTo: (ws, m) => sent.push(m.message), track: (p) => pending.push(p) };
const run = async (client, line) => { const parts = line.split(' '); const handled = await chat.handle(fakeChat, {}, client, parts[0], parts); await Promise.all(pending); pending = []; return handled; };

for (const [n, cmd] of [['b1', '!topic anything'], ['b2', '!bounty nova'], ['b3', '!board']]) assert.strictEqual(await run({ anonId: n, streamId: liveId }, cmd), false, `${cmd.split(' ')[0]} is not ours`);
assert.strictEqual(await run({ user: { id: viewer, username: 'viewer' }, streamId: liveId, ip: '1.1.1.1' }, '!hype'), true);
assert.match(sent.pop(), /Beefs are gone.*\/rundown$/);
await run({ anonId: 'zz', streamId: liveId }, '!beef');
assert.match(sent.pop(), /Beefs are gone/);
await run({ anonId: 'zy', streamId: liveId }, '!arena');
assert.match(sent.pop(), /^📰 Nova — latest episode: “The Fridge Files” · talks about Fridges → .*\/rundown\/nova$/, 'the streamer whose chat it is');
await run({ anonId: 'zx', streamId: liveId }, '!arena quietguy');
assert.match(sent.pop(), /Nothing on The Rundown about Quietguy yet/);
await run({ anonId: 'zw', streamId: liveId }, '!arena nobody_here');
assert.match(sent.pop(), /Nobody called nobody_here here/);
await read.setOptOut(nova, true);
await run({ anonId: 'zv', streamId: liveId }, '!arena');
assert.match(sent.pop(), /Nova keeps themselves out of The Rundown/);
await run({ anonId: 'zv', streamId: liveId }, '!arena');
assert.match(sent.pop(), /one command every few seconds/, 'one command every few seconds per chatter');
assert.ok(quiet);
console.log('✅ chat: !hype / !beef point to The Rundown; !arena answers with the streamer\'s Rundown');

console.log('rundown chat: ok');
process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
