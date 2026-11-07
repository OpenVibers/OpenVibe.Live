'use strict';
/**
 * Who sees The Rundown (design 2026-11-06, plan-state-2026-10-22/RUNDOWN-CONTROLS-AND-BROWSE-DESIGN-2026-11-06.md):
 *   the four audiences and who may see each one
 *   the gathered pages and their counts show Everyone only
 *   a non-public take never reaches another streamer's page
 *   the recording decides first: unlisting the VOD unlists the episode, making it public again gives the episode back
 *   its own setting (never a wider one), Specific people on both sides keeps the people on both lists
 *   deleting: a take, an episode and all my Rundown remove exactly their rows; topics recount; an empty topic goes;
 *   the VOD stays; another person's items cannot be deleted
 */
const assert = require('assert');
const db = require('../server/db/database');

(async () => {
await db.initDb();
const read = require('../server/rundown/read');
const sharing = require('../server/rundown/sharing');
const visibility = require('../server/rundown/visibility');
const del = require('../server/rundown/delete');

const SUB_GOOSE = 'usr_01HQZX9K3M5N7P8R9T0V1W2XYZ';
const SUB_WATCH = 'usr_01HQZX9K3M5N7P8R9T0V1W2XZA';
const SUB_OTHER = 'usr_01HQZX9K3M5N7P8R9T0V1W2XZB';

const mk = async (username) => {
    await db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: username, stream_key: username.padEnd(32, '0') });
    const id = Number((await db.get('SELECT id FROM users WHERE username = ?', [username])).id);
    await db.ensureChannel(id);
    return id;
};
const goose = await mk('goosely');
const watcher = await mk('watcher');

const NOW = new Date().toISOString().slice(0, 19).replace('T', ' ');
const streamId = Number((await db.createStream({ user_id: goose, title: 'Fridges', category: 'Science & Technology', protocol: 'rtmp' })).lastInsertRowid);
await db.run("UPDATE streams SET is_live = 0, started_at = datetime('now', '-180 minutes'), ended_at = datetime('now', '-60 minutes'), duration_seconds = 7200 WHERE id = ?", [streamId]);
await db.run("INSERT INTO rundown_topics (slug, title, kind, first_seen_at, last_seen_at, takes, streamers) VALUES ('fridges', 'Fridges', 'tech', ?, ?, 1, 1)", [NOW, NOW]);
const topicId = Number((await db.get('SELECT id FROM rundown_topics WHERE slug = ?', ['fridges'])).id);
await db.run("INSERT INTO rundown_segments (stream_id, user_id, topic_id, start_sec, end_sec, title, what, score, quotes_json, mentions, vod_id, said_at) VALUES (?, ?, ?, 0, 30, 'French fridges', 'goosely talked about fridges', 5, '[]', ?, 4242, ?)", [streamId, goose, topicId, [watcher], NOW]);
await db.run("INSERT INTO rundown_episodes (stream_id, user_id, title, logline, vod_id, minutes, aired_at) VALUES (?, ?, 'The Fridge Files', 'Cold takes.', 4242, 120, ?)", [streamId, goose, NOW]);
const segId = Number((await db.get('SELECT id FROM rundown_segments WHERE stream_id = ?', [streamId])).id);

// The Share sheet changes the audience of an episode that is registered (the SDK row is what the pages read).
const setAudience = async (a) => { await db.run("UPDATE shares SET audience = ? WHERE service = 'live' AND kind = 'rundown-episode' AND resource_id = ?", [a, String(streamId)]); };

// ── Everyone: the gathered pages and their counts ──
{
    const home = await read.home({ viewer: null });
    assert.ok(home.counts.takes >= 1, 'the take is counted while it is Everyone');
    assert.ok(home.counts.episodes >= 1, 'the episode is counted while it is Everyone');
    const feed = await read.streamsFeed({ viewer: null });
    assert.ok(feed.streams.some((s) => s.stream_id === streamId), 'the stream is on the front page');
    const topics = await read.topics({});
    assert.ok(topics.topics.some((t) => t.slug === 'fridges' && t.takes >= 1), 'the topic is there with its count');
    assert.ok(await read.topic('fridges', { viewer: null }), 'the topic page opens');
    assert.ok(await read.episode(streamId, { viewer: null }), 'the episode page opens for anybody');
}

// ── Only me: the streamer still sees it, nobody else does ──
await sharing.register(streamId, SUB_GOOSE, 'private');
{
    const home = await read.home({ viewer: null });
    assert.strictEqual(home.counts.takes, 0, 'a take that is not Everyone is not counted');
    assert.strictEqual(home.counts.episodes, 0, 'an episode that is not Everyone is not counted');
    assert.ok(!home.streams.some((s) => s.stream_id === streamId), 'the stream is off the front page');
    const topics = await read.topics({});
    assert.ok(!topics.topics.some((t) => t.slug === 'fridges'), 'a topic whose takes are all non-public disappears');
    assert.strictEqual(await read.topic('fridges', { viewer: null }), null, 'the topic page is gone for everybody else');
    assert.strictEqual(await read.episode(streamId, { viewer: null }), null, 'the episode page is not there for anybody else');
    const mine = await read.home({ viewer: { key: `user:${goose}`, userId: goose, subject: SUB_GOOSE } });
    assert.strictEqual(mine.counts.takes, 1, 'the streamer sees their own take');
    const myFeed = await read.streamsFeed({ viewer: { key: `user:${goose}`, userId: goose, subject: SUB_GOOSE } });
    assert.ok(myFeed.streams.some((s) => s.stream_id === streamId), 'the streamer sees their own stream');
    const ep = await read.episode(streamId, { viewer: { key: `user:${goose}`, userId: goose, subject: SUB_GOOSE } });
    assert.ok(ep && ep.episode, 'the streamer opens their own episode');
    assert.strictEqual(ep.episode.audience, 'private', 'the episode knows its audience');
    assert.strictEqual(ep.episode.audience_chip, 'Only me', 'the chip says who may see it');
    const page = await read.streamer('goosely', { viewer: { key: `user:${goose}`, userId: goose, subject: SUB_GOOSE } });
    assert.ok(page.episodes.some((e) => e.stream_id === streamId), 'the streamer page shows their own episode');
    assert.strictEqual(page.episodes.find((e) => e.stream_id === streamId).audience_chip, 'Only me', 'with the chip');
}

// ── A take that names another streamer never reaches their page ──
{
    const theirs = await read.streamer('watcher', { viewer: { key: `user:${watcher}`, userId: watcher, subject: SUB_WATCH } });
    assert.ok(!theirs.crossovers.some((c) => c.id === segId), 'a non-public take never appears on the page of the streamer it names');
    const mine = await read.streamer('goosely', { viewer: { key: `user:${goose}`, userId: goose, subject: SUB_GOOSE } });
    assert.ok(mine.crossovers.some((c) => c.id === segId), 'the streamer sees their own take that names somebody');
}

// ── Specific people: the people on the list, and nobody else ──
await setAudience('people');
await db.run("INSERT INTO share_members (service, kind, resource_id, subject, role, added_by, added_at) VALUES ('live', 'rundown-episode', ?, ?::jsonb, 'viewer', ?::jsonb, NOW())",
    [String(streamId), JSON.stringify({ type: 'user', id: SUB_WATCH }), JSON.stringify({ type: 'user', id: SUB_GOOSE })]);
{
    const seen = await read.episode(streamId, { viewer: { key: `user:${watcher}`, userId: watcher, subject: SUB_WATCH } });
    assert.ok(seen && seen.episode, 'a person on the list opens the episode');
    const stranger = await read.episode(streamId, { viewer: { key: `anon:stranger`, userId: null, subject: SUB_OTHER } });
    assert.strictEqual(stranger, null, 'a person who is not on the list does not');
    const home = await read.home({ viewer: null });
    assert.strictEqual(home.counts.takes, 0, 'a take for specific people is not counted on the front page');
}

// ── The recording decides first ──
await setAudience('public');
await visibility.noteVodVisibility(streamId, 'unlisted');
{
    const eff = await visibility.effective(streamId);
    assert.strictEqual(eff.own, 'public', 'the episode keeps its own setting');
    assert.strictEqual(eff.vod, 'link', 'an unlisted recording is Anyone with the link');
    assert.strictEqual(eff.audience, 'link', 'the recording decides: the episode is not Everybody any more');
    const ep = await read.episode(streamId, { viewer: { key: `user:${goose}`, userId: goose, subject: SUB_GOOSE } });
    assert.strictEqual(ep.episode.following_vod, true, 'the episode says it follows the recording');
    assert.strictEqual(ep.episode.following_vod_label, 'unlisted', 'with the recording\'s own word');
    const home = await read.home({ viewer: null });
    assert.strictEqual(home.counts.takes, 0, 'an episode that is not Everyone is off the front page');
    assert.ok(await read.episode(streamId, { viewer: null }), 'but anybody with the link still opens it');
}
// Unlisting the recording makes the episode only-me for everybody: nobody but the streamer.
await visibility.noteVodVisibility(streamId, 'private');
{
    const eff = await visibility.effective(streamId);
    assert.strictEqual(eff.audience, 'private', 'a private recording makes the episode only me');
    assert.strictEqual(await read.episode(streamId, { viewer: null }), null, 'and nobody opens it');
}
// A recording that becomes public again gives the episode back its own setting, never a wider one.
await visibility.noteVodVisibility(streamId, 'public');
{
    const eff = await visibility.effective(streamId);
    assert.strictEqual(eff.own, 'public', 'the episode still has its own setting');
    assert.strictEqual(eff.audience, 'public', 'the episode goes back to its own setting');
}
// Never wider than the episode's own setting.
await setAudience('link');
{
    const eff = await visibility.effective(streamId);
    assert.strictEqual(eff.audience, 'link', 'a public recording never makes the episode wider than its own setting');
}

// ── Specific people on both sides: the people on both lists ──
await setAudience('people');
await db.run("DELETE FROM share_members WHERE service = 'live' AND kind = 'rundown-episode' AND resource_id = ?", [String(streamId)]);
for (const s of [SUB_WATCH, SUB_OTHER]) {
    await db.run("INSERT INTO share_members (service, kind, resource_id, subject, role, added_by, added_at) VALUES ('live', 'rundown-episode', ?, ?::jsonb, 'viewer', ?::jsonb, NOW())",
        [String(streamId), JSON.stringify({ type: 'user', id: s }), JSON.stringify({ type: 'user', id: SUB_GOOSE })]);
}
await db.run('UPDATE rundown_visibility SET vod_audience = ? WHERE stream_id = ?', ['people', streamId]);
await db.run('UPDATE rundown_visibility SET vod_members = ?::jsonb WHERE stream_id = ?', [JSON.stringify([{ id: SUB_WATCH }]), streamId]);
{
    const eff = await visibility.effective(streamId);
    assert.strictEqual(eff.audience, 'people', 'both sides say specific people');
    assert.deepStrictEqual(eff.members, [SUB_WATCH], 'the people on both lists');
    assert.ok(await read.episode(streamId, { viewer: { key: `user:${watcher}`, userId: watcher, subject: SUB_WATCH } }), 'the person on both lists opens it');
    assert.strictEqual(await read.episode(streamId, { viewer: { key: 'anon:x', userId: null, subject: SUB_OTHER } }), null, 'the person on only one list does not');
}

// ── A recording shared with Specific people (Media's new audience) ──
await setAudience('public');
await db.run("DELETE FROM share_members WHERE service = 'live' AND kind = 'rundown-episode' AND resource_id = ?", [String(streamId)]);
await visibility.noteVodVisibility(streamId, 'people', [SUB_WATCH]);
{
    const eff = await visibility.effective(streamId);
    assert.strictEqual(eff.vod, 'people', 'Media\'s people audience is recorded, not flattened to private');
    assert.strictEqual(eff.audience, 'people', 'the recording makes the episode Specific people');
    assert.deepStrictEqual(eff.members, [SUB_WATCH], 'with the recording\'s member list');
    assert.ok(await read.episode(streamId, { viewer: { key: `user:${watcher}`, userId: watcher, subject: SUB_WATCH } }), 'a person on the recording opens the episode');
    assert.strictEqual(await read.episode(streamId, { viewer: { key: 'anon:x', userId: null, subject: SUB_OTHER } }), null, 'somebody else does not');
    const home = await read.home({ viewer: null });
    assert.strictEqual(home.counts.takes, 0, 'it is not counted on the gathered front page');
    // The event path (Media reports the audience and the member list together) writes the same row.
    await visibility.noteVodChange(4242, streamId, 'people', [SUB_WATCH, SUB_OTHER]);
    const stored = await db.get('SELECT vod_audience, vod_members FROM rundown_visibility WHERE stream_id = ?', [streamId]);
    assert.strictEqual(stored.vod_audience, 'people');
    assert.deepStrictEqual(stored.vod_members.map((m) => m.id), [SUB_WATCH, SUB_OTHER]);
    // The episode's own link setting is not wider than the recording: people wins.
    await setAudience('link');
    assert.strictEqual((await visibility.effective(streamId)).audience, 'people', 'people is stricter than link');
    // Only me on the episode stays Only me whatever the recording says.
    await setAudience('private');
    assert.strictEqual((await visibility.effective(streamId)).audience, 'private', 'the episode can always narrow further');
}

// ── Deleting ──
await setAudience('public');
{
    // A topic with two takes recounts when one of them goes.
    await db.run("INSERT INTO rundown_topics (slug, title, kind, first_seen_at, last_seen_at, takes, streamers) VALUES ('ranked', 'Ranked', 'games', ?, ?, 2, 1)", [NOW, NOW]);
    const topic2 = Number((await db.get('SELECT id FROM rundown_topics WHERE slug = ?', ['ranked'])).id);
    await db.run("INSERT INTO rundown_segments (stream_id, user_id, topic_id, start_sec, end_sec, title, what, score, quotes_json, mentions, vod_id, said_at) VALUES (?, ?, ?, 60, 90, 'Ranked one', 'goosely talked about ranked', 3, '[]', '{}', 4242, ?)", [streamId, goose, topic2, NOW]);
    await db.run("INSERT INTO rundown_segments (stream_id, user_id, topic_id, start_sec, end_sec, title, what, score, quotes_json, mentions, vod_id, said_at) VALUES (?, ?, ?, 90, 120, 'Ranked two', 'goosely talked about ranked again', 3, '[]', '{}', 4242, ?)", [streamId, goose, topic2, NOW]);
    const segA = Number((await db.get('SELECT id FROM rundown_segments WHERE topic_id = ? ORDER BY start_sec ASC LIMIT 1', [topic2])).id);
    await del.deleteTake(segA, { id: goose });
    assert.strictEqual(Number((await db.get('SELECT takes FROM rundown_topics WHERE id = ?', [topic2])).takes), 1, 'the topic recounted the take that went');
    assert.ok(await db.get('SELECT id FROM rundown_topics WHERE id = ?', [topic2]), 'a topic with a take left stays');
    // A take.
    const before = Number((await db.get('SELECT takes FROM rundown_topics WHERE id = ?', [topicId])).takes);
    assert.strictEqual(before, 1, 'the topic counted the take');
    const r1 = await del.deleteTake(segId, { id: goose });
    assert.strictEqual(r1.takes, 1, 'one take deleted');
    assert.ok(!(await db.get('SELECT id FROM rundown_segments WHERE id = ?', [segId])), 'the take is gone');
    assert.ok(!(await db.get('SELECT id FROM rundown_topics WHERE id = ?', [topicId])), 'the topic recounted and, left with nothing, was removed');
    // Somebody else cannot delete it.
    let refused = false;
    try { await del.deleteEpisode(streamId, { id: watcher }); } catch (e) { refused = e.status === 403; }
    assert.ok(refused, 'another person\'s episode is not deleted');
    assert.ok(await db.get('SELECT stream_id FROM rundown_episodes WHERE stream_id = ?', [streamId]), 'the episode is still there');
    // The episode.
    const r2 = await del.deleteEpisode(streamId, { id: goose });
    assert.strictEqual(r2.episodes, 1, 'one episode deleted');
    assert.ok(!(await db.get('SELECT stream_id FROM rundown_episodes WHERE stream_id = ?', [streamId])), 'the episode is gone');
    assert.ok(!(await db.get("SELECT audience FROM shares WHERE service = 'live' AND kind = 'rundown-episode' AND resource_id = ?", [String(streamId)])), 'the sharing row went with it');
    assert.ok(await db.get('SELECT id FROM streams WHERE id = ?', [streamId]), 'the stream stays');
    assert.ok(await db.get('SELECT stream_id FROM rundown_deleted WHERE stream_id = ?', [streamId]), 'the desk will not write it up again');
    const r3 = await del.restore(streamId, { id: goose });
    assert.strictEqual(r3.restored, true, 'the streamer can ask for it to be written up again');
}

console.log('✅ rundown: audiences, the recording\'s rule, deleting');
})().catch((err) => { console.error(err); process.exit(1); });
