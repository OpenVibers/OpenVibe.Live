'use strict';
/**
 * Who sees The Rundown (design 2026-11-06, plan-state-2026-10-22/RUNDOWN-CONTROLS-AND-BROWSE-DESIGN-2026-11-06.md).
 *
 * There is one setting, not four: Everyone, Anyone with the link, Specific people or Only me. Those are the sharing
 * system's own audiences (openvibe-sdk/share, share.v1), so an episode's own setting lives in the share row of kind
 * 'rundown-episode' (server/rundown/sharing.js) and the Share sheet is the only place it is set.
 *
 * The recording decides first. An episode's audience is the stricter of its own setting and its VOD's visibility:
 * Only me, then Specific people, then Anyone with the link, then Everyone. The rule is applied where the pages read it,
 * so a VOD that turns stricter is followed at once (the episode, its segments and the after-show report) and a VOD that
 * becomes public again gives the episode back its own setting, never a wider one.
 *
 * Media's own vocabulary is mapped onto the four audiences. Since Media gained "Specific people" (step 5), a VOD can
 * itself be `people`: Live records that audience and the VOD's member list from Media's API/event (the audience and the
 * subject ids, never a title). When both the episode and the VOD name people, the people on both lists keep access.
 */
const db = require('../db/database');

/** The four audiences, in the sharing system's own words. */
const AUDIENCES = ['public', 'link', 'people', 'private'];
/** How strict each one is: the lower the number, the stricter. The stricter of two wins. */
const STRICTNESS = { private: 0, people: 1, link: 2, public: 3 };
/** Nobody chose anything yet: Everyone. */
const DEFAULT_AUDIENCE = 'public';
/** Media's visibility vocabulary, mapped onto the four audiences. */
const MEDIA_AUDIENCE = { public: 'public', unlisted: 'link', people: 'people', private: 'private' };
/** And back again: what the episode page says when it follows the recording ("Following the VOD: unlisted"). */
const MEDIA_WORD = { public: 'public', link: 'unlisted', people: 'people', private: 'private' };
/** The chip a streamer sees on their own non-public items. */
const LABELS = { public: 'Everyone', link: 'Link', private: 'Only me' };

/** The stricter of two audiences. An unknown one is treated as Everyone (the old default). */
function stricter(a, b) {
    const x = STRICTNESS[a], y = STRICTNESS[b];
    if (x === undefined && y === undefined) return DEFAULT_AUDIENCE;
    if (x === undefined) return b;
    if (y === undefined) return a;
    return x <= y ? a : b;
}

/** Media's visibility as one of the four audiences. */
function mediaAudience(visibility) {
    return MEDIA_AUDIENCE[String(visibility || '').trim().toLowerCase()] || DEFAULT_AUDIENCE;
}

/** What the recording is called where the pages speak about it. */
function mediaWord(audience) {
    return MEDIA_WORD[audience] || 'public';
}

/** The chip: "Everyone", "Link", "3 people", "Only me". */
function label(audience, memberCount = 0) {
    if (audience === 'people') return memberCount > 1 ? `${memberCount} people` : 'Specific people';
    return LABELS[audience] || LABELS[DEFAULT_AUDIENCE];
}

/** The episode's own setting: the share row's audience. No row yet means Everyone. */
async function ownAudience(streamId) {
    try {
        const row = await db.get("SELECT audience FROM shares WHERE service = 'live' AND kind = 'rundown-episode' AND resource_id = ?", [String(streamId)]);
        return row && AUDIENCES.includes(row.audience) ? row.audience : DEFAULT_AUDIENCE;
    } catch { return DEFAULT_AUDIENCE; }
}

/** What the recording decides, as the last thing Live heard about it. */
async function vodAudience(streamId) {
    try {
        const row = await db.get('SELECT vod_audience FROM rundown_visibility WHERE stream_id = ?', [Number(streamId)]);
        return row && AUDIENCES.includes(row.vod_audience) ? row.vod_audience : DEFAULT_AUDIENCE;
    } catch { return DEFAULT_AUDIENCE; }
}

/** The people the recording is shared with (the other side of "the people on both lists"). */
async function vodMembers(streamId) {
    try {
        const row = await db.get('SELECT vod_members FROM rundown_visibility WHERE stream_id = ?', [Number(streamId)]);
        const list = row && row.vod_members ? (typeof row.vod_members === 'string' ? JSON.parse(row.vod_members) : row.vod_members) : [];
        return (Array.isArray(list) ? list : []).map((m) => String(m && m.id ? m.id : m)).filter(Boolean);
    } catch { return []; }
}

/** The people an episode is shared with (the share row's members), as subject ids. */
async function memberSubjects(streamId) {
    try {
        const rows = await db.all(`SELECT subject->>'id' AS id FROM share_members
            WHERE service = 'live' AND kind = 'rundown-episode' AND resource_id = ? AND (expires_at IS NULL OR expires_at > NOW())`, [String(streamId)]);
        return rows.map((r) => r.id).filter(Boolean);
    } catch { return []; }
}

/** What the episode page says: the effective audience and where it came from. */
async function effective(streamId) {
    const own = await ownAudience(streamId);
    const vod = await vodAudience(streamId);
    const audience = stricter(own, vod);
    let members = [];
    if (audience === 'people') {
        const ownList = own === 'people' ? await memberSubjects(streamId) : null;
        const vodList = vod === 'people' ? await vodMembers(streamId) : null;
        // Specific people on the recording alone: its people. On the episode alone: its people. On both:
        // the people on both lists. The effective audience is never wider than either list.
        members = ownList && vodList ? ownList.filter((id) => vodList.includes(id)) : (vodList || ownList || []);
    }
    return { own, vod, audience, members, following_vod: audience !== own, member_count: members.length };
}

/**
 * Record what the recording decides. Called in the same request as a visibility change made through Live's own pages
 * (server/media-proxy/vods.js) and when Media's own event arrives (server/media-proxy/outcomes.js).
 */
async function noteVodVisibility(streamId, mediaVisibility, members = null) {
    const id = Number(streamId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const audience = mediaAudience(mediaVisibility);
    const list = audience === 'people'
        ? (Array.isArray(members) ? members : []).map((m) => ({ id: String(m && m.id ? m.id : m) })).filter((m) => m.id)
        : [];
    await db.run(`INSERT INTO rundown_visibility (stream_id, vod_audience, vod_members, updated_at) VALUES (?, ?, ?::jsonb, ov_now())
        ON CONFLICT (stream_id) DO UPDATE SET vod_audience = excluded.vod_audience, vod_members = excluded.vod_members,
            updated_at = excluded.updated_at`, [id, audience, JSON.stringify(list)]);
    return audience;
}

/**
 * A recording changed its visibility: the write-up of that stream follows at once. Called from Live's own pages
 * (server/media-proxy/vods.js) and from Media's event (server/media-proxy/outcomes.js).
 */
async function noteVodChange(vodId, streamId, mediaVisibility, members = null) {
    let sid = Number(streamId);
    if (!Number.isSafeInteger(sid) || sid <= 0) {
        const row = await db.get('SELECT stream_id FROM rundown_episodes WHERE vod_id = ?', [Number(vodId)]);
        sid = row ? Number(row.stream_id) : null;
    }
    if (!Number.isSafeInteger(sid) || sid <= 0) return null;
    forget(sid);
    return await noteVodVisibility(sid, mediaVisibility, members);
}

/** The recording of a stream, when there is one. */
async function vodIdFor(streamId) {
    const row = await db.get('SELECT vod_id FROM rundown_episodes WHERE stream_id = ? AND vod_id IS NOT NULL', [Number(streamId)])
        || await db.get('SELECT vod_id FROM rundown_segments WHERE stream_id = ? AND vod_id IS NOT NULL LIMIT 1', [Number(streamId)]);
    return row && row.vod_id ? Number(row.vod_id) : null;
}

const RECHECK_MS = 60 * 1000;
const _rechecked = new Map();      // stream id → { at, audience }

/**
 * Ask Media what the recording is now, until its event says the same thing (design: "until the event lands, the episode
 * page re-checks the VOD's visibility through media-client when it is opened, cached 60 s").
 */
async function recheck(streamId) {
    const id = Number(streamId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const hit = _rechecked.get(id);
    if (hit && Date.now() - hit.at < RECHECK_MS) return hit.audience;
    const vodId = await vodIdFor(id);
    if (!vodId) return null;
    let audience = null, members = null;
    try {
        const vod = await require('../media-client').getVod(vodId);
        // Media's `audience` is the share.v1 answer (people included); `visibility` keeps old servers working.
        if (vod && (vod.audience || vod.visibility)) audience = mediaAudience(vod.audience || vod.visibility);
        if (vod && Array.isArray(vod.members)) members = vod.members;
        else if (vod && Array.isArray(vod.share_members)) members = vod.share_members;
    } catch { /* Media unreachable: the last thing we heard stays */ }
    if (!audience) return null;
    _rechecked.set(id, { at: Date.now(), audience });
    await noteVodVisibility(id, audience, members);
    return audience;
}

/** Forget the cached re-check (a visibility change Live applied itself). */
function forget(streamId) { _rechecked.delete(Number(streamId)); }

module.exports = {
    AUDIENCES, DEFAULT_AUDIENCE, LABELS,
    stricter, mediaAudience, mediaWord, label,
    ownAudience, vodAudience, vodMembers, memberSubjects, effective,
    noteVodVisibility, noteVodChange, vodIdFor, recheck, forget,
};
