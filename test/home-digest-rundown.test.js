'use strict';
/**
 * The home digest ("Lately on OpenVibe") and the star pick read The Rundown, not the Arena's mic moments
 * (server/home/routes.js, server/home/star-job.js):
 *   the digest counts live takes and shows public, topic-linked takes from streams in the window
 *   the star     a candidate's takes over the last two weeks count toward the pick
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const db = require('../server/db/database');

(async () => {
await db.initDb();
require('../server/chat/chat-reads').windowStatsPeek = async () => ({ messages: 0 });
require('../server/chat/chat-reads').windowStats = async () => ({ messages: 0 });

const ago = (min) => new Date(Date.now() - min * 60000).toISOString().replace('T', ' ').slice(0, 19);
const mk = async (username, extra = {}) => {
    await db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: username, stream_key: username.padEnd(32, '0') });
    const id = (await db.get('SELECT id FROM users WHERE username = ?', [username])).id;
    if (extra.banned) await db.run('UPDATE users SET is_banned = 1 WHERE id = ?', [id]);
    return id;
};
const stream = async (uid) => (await db.run('INSERT INTO streams (user_id, title, is_live, started_at, ended_at, duration_seconds) VALUES (?, ?, 0, ?, ?, 3600) RETURNING id',
    [uid, 'Night', ago(180), ago(120)])).lastInsertRowid;
const topic = (await db.run("INSERT INTO rundown_topics (slug, title, kind, first_seen_at, last_seen_at) VALUES ('league-autofill', 'League autofill', 'games', ?, ?) RETURNING id", [ago(150), ago(150)])).lastInsertRowid;
const take = async (uid, sid, { title, score, quote = null, status = 'live', withTopic = true }) => db.run(
    'INSERT INTO rundown_segments (stream_id, user_id, topic_id, start_sec, end_sec, title, what, score, quotes_json, said_at, status) VALUES (?, ?, ?, 10, 60, ?, ?, ?, ?, ?, ?)',
    [sid, uid, withTopic ? topic : null, title, `${title}.`, score, JSON.stringify(quote ? [{ text: quote, sec: 12, en: null }] : []), ago(150), status]);

const ann = await mk('annstreams'), bob = await mk('bobstreams'), ban = await mk('bannedone', { banned: true });
const sa = await stream(ann), sb = await stream(bob), sx = await stream(ban);
await take(ann, sa, { title: 'Autofill is a scam on support mains', score: 5, quote: 'autofill put me on support again chat' });
await take(bob, sb, { title: 'Bob on his new keyboard', score: 4, withTopic: false });
await take(bob, sb, { title: 'A quiet stretch', score: 3 });
await take(ann, sa, { title: 'Taken down', score: 5, quote: 'never shown', status: 'hidden' });
await take(ban, sx, { title: 'Banned streamer take', score: 5, quote: 'never shown either' });

const app = express();
app.use('/api/home', require('../server/home/routes'));
const server = http.createServer(app);
await new Promise((res) => server.listen(0, '127.0.0.1', res));
try {
    const d = await (await fetch(`http://127.0.0.1:${server.address().port}/api/home/digest`)).json();
    assert.strictEqual(d.stats.takes, 3, 'only visible takes by non-banned streamers are counted');
    assert.ok(!('mic_moments' in d.stats), 'the Arena\'s mic moments are gone');
    assert.deepStrictEqual(d.topics.map((h) => [h.text, h.topic, h.username]), [
        ['autofill put me on support again chat', 'League autofill', 'annstreams'],
    ], 'the digest shows topic-linked takes, never a random ungrouped quote or hidden take');
    assert.ok(d.html.includes(`/rundown/e/${sa}#rd-take-${d.topics[0].id}`));
    assert.ok(d.html.includes('What they talked about'));
    assert.ok(d.html.includes('New here'));
    assert.ok(!d.html.includes('Bob on his new keyboard'));
    console.log('✅ the digest reads The Rundown');
} finally {
    server.close();
}

const cands = await require('../server/home/star-job').candidates();
const byName = Object.fromEntries(cands.map((c) => [c.username, c]));
assert.strictEqual(Number(byName.annstreams.takes), 1, 'a live take counts toward the star pick (a hidden one does not)');
assert.strictEqual(Number(byName.bobstreams.takes), 2);
assert.ok(!byName.bannedone, 'a banned streamer is no candidate');
console.log('✅ the star pick counts Rundown takes');

console.log('home digest + star: ok');
process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
