/**
 * Freshness + dedupe policy for automated clips (owner, 2026-10-29: "the AI clipping system
 * seems to clip old videos. Maybe only make clips of fresh stuff, unless the site's dead").
 *
 *   - footage from the last 48 hours is eligible;
 *   - the archive (≤ 90 days) opens only after 72h with no new footage AND no human pageviews,
 *     and then at most one archival clip per UTC day;
 *   - an upstream outage is never quietness;
 *   - a long/reconnected stream uses the VOD part's capture time, not the stream start.
 *
 *   node test/clip-freshness.test.js
 */
'use strict';
const assert = require('assert');
const db = require('../server/db/database');
(async () => {
await db.initDb();
const raw = db.getDb();
const policy = require('../server/ai/clip-policy');
const registry = require('../server/ai/moment-registry');
const media = require('../server/media-client');
const autoClip = require('../server/ai/auto-clip-job');
const moments = require('../server/ai/ai-moments-job');

const HOUR = 3600_000, DAY = 24 * HOUR;
const text = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const now = Math.floor(Date.now() / 1000) * 1000;

// ── Pure policy ────────────────────────────────────────────
assert.strictEqual(policy.parseTs('2026-10-28 01:02:03'), Date.UTC(2026, 9, 28, 1, 2, 3), 'DB UTC text parses');
assert.strictEqual(policy.parseTs('2026-10-28T01:02:03Z'), Date.UTC(2026, 9, 28, 1, 2, 3), 'ISO parses');
assert.strictEqual(policy.parseTs(1_700_000_000), 1_700_000_000_000, 'epoch seconds parse');

const stream = { started_at: text(now - 5 * DAY) };
assert.strictEqual(policy.footageStart({ vod: { captured_at: text(now - HOUR) }, stream }), now - HOUR, 'explicit capture time wins');
assert.strictEqual(policy.footageStart({ vod: { created_at: text(now - 9 * DAY) }, stream, part: { at: 4 * DAY / 1000 } }), now - DAY, 'part capture time wins over created_at');
assert.strictEqual(policy.footageStart({ vod: { created_at: text(now - 3 * DAY) }, stream }), now - 3 * DAY, 'created_at fallback for a one-part VOD');
assert.strictEqual(policy.footageStart({}), null, 'unknown source age');

const fresh = policy.classifySource({ vod: { captured_at: text(now - 47 * HOUR) }, now });
assert.ok(fresh.ok && !fresh.archival, '47h old is fresh');
const stale = policy.classifySource({ vod: { captured_at: text(now - 49 * HOUR) }, now, site: { quiet: false } });
assert.ok(!stale.ok, '49h old is stale while the site is active');
const archive = policy.classifySource({ vod: { captured_at: text(now - 5 * DAY) }, now, site: { quiet: true } });
assert.ok(archive.ok && archive.archival, '5 days old is archival on a quiet site');
const tooOld = policy.classifySource({ vod: { captured_at: text(now - 100 * DAY) }, now, site: { quiet: true } });
assert.ok(!tooOld.ok, 'older than the 90-day archive window is never eligible');

const quiet = policy.siteStatus({ now, lastFootageAt: now - 73 * HOUR, lastHumanActivityAt: now - 73 * HOUR, upstreamHealthy: true });
assert.strictEqual(quiet.quiet, true, '72h without footage or pageviews is quiet');
assert.strictEqual(policy.siteStatus({ now, lastFootageAt: now - 73 * HOUR, lastHumanActivityAt: now - 73 * HOUR, upstreamHealthy: false }).quiet, false, 'an outage is not quietness');
assert.strictEqual(policy.siteStatus({ now, lastFootageAt: now - 73 * HOUR, lastHumanActivityAt: null, upstreamHealthy: true }).quiet, false, 'unknown activity is not quietness');
assert.strictEqual(policy.siteStatus({ now, lastFootageAt: now - 73 * HOUR, lastHumanActivityAt: now - 1 * HOUR, upstreamHealthy: true }).quiet, false, 'a human pageview keeps the archive closed');

assert.strictEqual(policy.archiveAllowed([{ archival: true, ts: Date.now() }]), false, 'one archive clip per day');
assert.strictEqual(policy.archiveAllowed([{ archival: true, ts: Date.now() - DAY }]), true, "yesterday's archive clip does not block today");

// A stale VOD is also allowed when its own channel has been quiet for 48h (the brief's channel
// exception) — but only its newest VODs, and never outside the 90-day window.
assert.strictEqual(policy.channelStatus({ now, lastStreamAt: now - 49 * HOUR }).quiet, true, 'a channel with no new stream in 48h is quiet');
assert.strictEqual(policy.channelStatus({ now, lastStreamAt: now - HOUR }).quiet, false, 'a channel still streaming is active');
const quietChannel = policy.classifySource({ vod: { captured_at: text(now - 5 * DAY) }, now, site: { quiet: false }, channel: { quiet: true, newest: true } });
assert.ok(quietChannel.ok && quietChannel.archival, 'stale VOD on a quiet channel: archive allowed');
assert.ok(!policy.classifySource({ vod: { captured_at: text(now - 5 * DAY) }, now, site: { quiet: false }, channel: { quiet: true, newest: false } }).ok, 'quiet channel: only its newest VODs');
assert.ok(!policy.classifySource({ vod: { captured_at: text(now - 5 * DAY) }, now, site: { quiet: false }, channel: { quiet: false } }).ok, 'stale VOD on an active channel: refused');
console.log('✅ freshness policy: 48h, 72h quiet gate, channel quiet, outage, archive window and cap');

// ── Integration fixtures ───────────────────────────────────
const addUser = async (id, username) => await raw.prepare(
    `INSERT INTO users (id, username, display_name, email, password_hash, role, created_at) OVERRIDING SYSTEM VALUE
     VALUES (?, ?, ?, ?, 'x', 'streamer', '2025-01-01 00:00:00')`).run(id, username, username, `${username}@x`);
if (!await db.getUserById(3)) { await addUser(3, 'alice'); await db.ensureChannel(3); }
const ch = await db.getChannelByUserId(3);

const mkStream = async (startedMs, { live = false, endedMs = null } = {}) => {
    const id = Number((await db.createStream({ user_id: 3, channel_id: ch.id, title: 'stream', protocol: 'rtmp' })).lastInsertRowid);
    await db.run('UPDATE streams SET started_at = ?, is_live = ?, ended_at = ? WHERE id = ?', [text(startedMs), live ? 1 : 0, endedMs == null ? null : text(endedMs), id]);
    return id;
};
const vod = (id, streamId) => ({ id, stream_id: streamId, user_id: 3, title: `VOD ${id}`, visibility: 'public', is_public: true, view_count: 5, duration_seconds: 600, status: 'ready' });
let currentVods = [];
media.listVods = async () => ({ vods: currentVods });
const addMemory = async (streamId) => await db.addStreamMemory({ stream_id: streamId, user_id: 3, offset_seconds: 60, description: 'a scene' });

async function reset() {
    await raw.prepare('DELETE FROM stream_history').run();
    await raw.prepare('DELETE FROM stream_memories').run();
    await raw.prepare('DELETE FROM analytics_events').run();
    await raw.prepare('DELETE FROM streams').run();
    await db.setState('auto_clip_log', '[]');
    await db.setState('ai_used_moments', '[]');
    require('../server/ai/moment-registry')._reset();
    currentVods = [];
}

// Active site: only the VOD captured in the last 48h is eligible.
await reset();
const sFresh = await mkStream(now - HOUR, { endedMs: now - HOUR });
const sOld = await mkStream(now - 10 * DAY, { endedMs: now - 10 * DAY });
const sMid = await mkStream(now - 5 * DAY, { endedMs: now - 5 * DAY });
await addMemory(sFresh); await addMemory(sOld); await addMemory(sMid);
await db.run(`INSERT INTO analytics_events (service, event_type, is_bot, created_at) VALUES ('live', 'pageview', 0, ?)`, [text(now - HOUR)]);
currentVods = [vod(10, sFresh), vod(11, sOld), vod(12, sMid)];
let pool = await autoClip._internals.backfillPool(10);
assert.deepStrictEqual(pool.map(v => v.vod_id), [10], 'active site: only fresh footage is clipped');
assert.strictEqual(pool[0].archival, false);
console.log('✅ backfill pool: old popular VODs are not clipped while the site is active');

// Long/reconnected stream: capture time is streams.started_at + its part offset.
await reset();
const sLong = await mkStream(now - 5 * DAY, { live: true });
await db.run(`INSERT INTO stream_history (stream_id, kind, at_sec, end_sec, vod_id, detail) VALUES (?, 'part', ?, NULL, ?, '{}')`, [sLong, (5 * DAY - HOUR) / 1000, 13]);
await addMemory(sLong);
currentVods = [vod(13, sLong)];
pool = await autoClip._internals.backfillPool(10);
assert.deepStrictEqual(pool.map(v => v.vod_id), [13], 'a five-day stream still recording is fresh');
assert.ok(pool[0].age_hours < 2, 'its VOD part captured one hour ago, not five days ago');
console.log('✅ backfill pool: long/reconnected streams use the part capture time');

// Quiet site: the archive opens, up to the daily cap.
await reset();
const sArchiveA = await mkStream(now - 10 * DAY, { endedMs: now - 10 * DAY });
const sArchiveB = await mkStream(now - 5 * DAY, { endedMs: now - 5 * DAY });
await addMemory(sArchiveA); await addMemory(sArchiveB);
await db.run(`INSERT INTO analytics_events (service, event_type, is_bot, created_at) VALUES ('live', 'pageview', 0, ?)`, [text(now - 4 * DAY)]);
currentVods = [vod(20, sArchiveA), vod(21, sArchiveB)];
pool = await autoClip._internals.backfillPool(10);
assert.deepStrictEqual(pool.map(v => v.vod_id), [20, 21], 'quiet site: archive candidates inside 90 days');
assert.ok(pool.every(v => v.archival), 'they are labelled archival');

await db.setState('auto_clip_log', JSON.stringify([{ archival: true, ts: Date.now(), vod_id: 999 }]));
pool = await autoClip._internals.backfillPool(10);
assert.deepStrictEqual(pool, [], "today's archival clip closes the archive for the rest of the day");
console.log('✅ backfill pool: quiet site opens the archive, one archival clip per day');

// A Media outage is not quietness.
await db.setState('auto_clip_log', '[]');
media.listVods = async () => { throw new Error('Media down'); };
pool = await autoClip._internals.backfillPool(10);
assert.deepStrictEqual(pool, [], 'Media down: no candidates, and no archive opened');
media.listVods = async () => ({ vods: currentVods });

// The home-page moments pool follows the same policy.
const mpool = await moments._internals.momentPool(10);
assert.deepStrictEqual(mpool.map(v => v.vod_id), [20, 21], 'moments pool: same quiet-site archive');
assert.ok(mpool.every(v => v.archival));
await db.setState('auto_clip_log', JSON.stringify([{ archival: true, ts: Date.now(), vod_id: 999 }]));
assert.deepStrictEqual(await moments._internals.momentPool(10), [], 'moments pool: archive cap is shared with the clip job');
console.log('✅ moments pool: one freshness policy for every automated cutter');

registry._reset();
console.log('\n✅ All clip-freshness tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
