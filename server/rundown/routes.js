'use strict';
/**
 * /api/rundown — The Rundown (docs/rundown.md): what streamers talked about, written up by the desk (desk.js).
 *
 *   GET  /                      on air now, the latest (episodes + the best segments), trending topics, who's been talking
 *   GET  /browse?q=&streamer=&topic=&when=&show=&sort=&video=&following=&mentions=
 *                                the bar: the results the filters ask for, with the counts (server/rundown/browse.js)
 *   GET  /options                the lists the filter pickers show: the streamers, the topics
 *   GET  /latest?before=        the next page of the latest
 *   GET  /topics?sort=&kind=    every topic (sort recent | most)
 *   GET  /t/:slug               one topic and every take on it
 *   GET  /e/:streamId           one stream as an episode, with its segments
 *   GET  /s/:username           a streamer's episodes, topics, lines and crossovers
 *   POST /react {type, id, reaction}     one per reader per item (fire, lol, dead, cap, facts); the same again takes it back
 *   POST /hide {type, id}       staff: take a segment, episode or topic down
 *   GET|PUT /opt-out {out}      signed in: keep yourself out of the Rundown (or come back)
 *   GET|PUT /settings           signed in: "My Rundown" — the default audience for new write-ups
 *   POST /delete/take           signed in: delete one take of yours
 *   POST /delete/episode        signed in: delete one episode of yours (with its takes)
 *   POST /delete/all            signed in: delete all my Rundown
 *   POST /restore               signed in: "Write this stream up again"
 *   GET  /voice/:user?t=        a line in that streamer's chat voice (server/rundown/voice.js)
 */
const crypto = require('crypto');
const express = require('express');
const { requireAuth, optionalAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');
const db = require('../db/database');
const read = require('./read');
const browse = require('./browse');
const settings = require('./settings');
const del = require('./delete');
const { createCitations } = require('./citations');
const day = require('./day');

const router = express.Router();
const fail = (res, err, msg) => {
    if (err && err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error('[Rundown]', msg, err && err.message);
    res.status(500).json({ error: msg });
};
async function voterKey(req) {
    if (req.user && req.user.id) return `user:${req.user.id}`;
    const ip = String(req.ip || req.socket?.remoteAddress || '');
    let salt = '';
    try { salt = String(await db.getSetting('arena_vote_salt') || ''); } catch { /* */ }
    return `anon:${crypto.createHash('sha256').update(`${ip}|${salt || process.env.JWT_SECRET || 'rundown'}`).digest('hex').slice(0, 24)}`;
}
/**
 * The reader: their voter key (what reactions are counted by) and their account (what the audience rule is counted
 * by). The account's canonical subject is what the sharing system knows them by.
 */
async function viewerOf(req) {
    const key = await voterKey(req);
    if (!req.user || !req.user.id) return { key, userId: null, subject: null };
    let subject = null;
    try { subject = await require('../auth/identity-sync').subjectOf(req.user.id); } catch { subject = null; }
    return { key, userId: req.user.id, subject: subject || null };
}
// Pages with reactions are per reader; the rest is the same for everyone for a minute.
const fresh = (res) => res.set('Cache-Control', 'no-store');

router.get('/', optionalAuth, async (req, res) => {
    try { fresh(res); res.json(await read.home({ viewer: await viewerOf(req) })); } catch (err) { fail(res, err, 'The Rundown is unavailable'); }
});
router.get('/browse', optionalAuth, async (req, res) => {
    try { fresh(res); res.json(await browse.browse(req.query || {}, { viewer: await viewerOf(req) })); }
    catch (err) { fail(res, err, 'The search could not be run'); }
});
router.get('/day/:date', optionalAuth, async (req, res) => {
    try {
        const viewer = await viewerOf(req);
        const payload = await day.getDay(String(req.params.date || ''), { viewer, offset: req.query.offset, limit: req.query.limit });
        // The AI Today card: the page's top card, written by the job (server/rundown/today.js) from today's takes.
        try { payload.today = await require('./today').get(payload.date); } catch { payload.today = null; }
        res.set('Cache-Control', viewer.userId ? 'private, no-store' : 'public, max-age=60, stale-while-revalidate=300');
        res.json(payload);
    } catch (err) { fail(res, err, 'Failed to load the day'); }
});
router.get('/options', optionalAuth, async (req, res) => {
    try { fresh(res); res.json(await browse.options()); }
    catch (err) { fail(res, err, 'The filters could not be loaded'); }
});
router.get('/streams', optionalAuth, async (req, res) => {
    try { fresh(res); res.json(await read.streamsFeed({ before: req.query.before ? String(req.query.before) : null, viewer: await viewerOf(req) })); } catch (err) { fail(res, err, 'Failed to load the streams'); }
});
router.get('/topics', optionalAuth, async (req, res) => {
    try {
        fresh(res);
        res.json(await read.topics({ sort: req.query.sort === 'most' ? 'most' : 'recent', kind: req.query.kind ? String(req.query.kind) : null, offset: parseInt(req.query.offset, 10) || 0 }));
    } catch (err) { fail(res, err, 'Failed to load the topics'); }
});
router.get('/t/:slug', optionalAuth, async (req, res) => {
    try {
        const t = await read.topic(req.params.slug, { viewer: await viewerOf(req) });
        if (!t) return res.status(404).json({ error: 'No such topic' });
        // S7: a public agent report may cite the topic when the agent worked on it. Report being down is no citations.
        t.citations = await createCitations().forTopic((t.topic && t.topic.title) || t.title);
        fresh(res);
        res.json(t);
    } catch (err) { fail(res, err, 'Failed to load the topic'); }
});
router.get('/e/:streamId', optionalAuth, async (req, res) => {
    try { const e = await read.episode(req.params.streamId, { viewer: await viewerOf(req) }); if (!e) return res.status(404).json({ error: 'No such episode' }); fresh(res); res.json(e); }
    catch (err) { fail(res, err, 'Failed to load the episode'); }
});
router.get('/s/:username', optionalAuth, async (req, res) => {
    try { const s = await read.streamer(req.params.username, { viewer: await viewerOf(req) }); if (!s) return res.status(404).json({ error: 'No such streamer' }); fresh(res); res.json(s); }
    catch (err) { fail(res, err, 'Failed to load the streamer'); }
});
router.post('/react', optionalAuth, async (req, res) => {
    try { const b = req.body || {}; res.json(await read.react(String(b.type || ''), b.id, await voterKey(req), String(b.reaction || ''))); }
    catch (err) { fail(res, err, 'Failed to react'); }
});
router.post('/hide', requireAuth, permissions.requireAdmin, async (req, res) => {
    try { const b = req.body || {}; res.json(await read.hide(String(b.type || ''), b.id)); } catch (err) { fail(res, err, 'Failed to hide'); }
});
router.get('/opt-out', requireAuth, async (req, res) => {
    try { res.json({ opted_out: await read.optedOut(req.user.id) }); } catch (err) { fail(res, err, 'Failed'); }
});
router.put('/opt-out', requireAuth, async (req, res) => {
    try { res.json(await read.setOptOut(req.user.id, !!(req.body && req.body.out))); } catch (err) { fail(res, err, 'Failed'); }
});

/** "My Rundown": the streamer's default audience and whether they keep themselves out. */
router.get('/settings', requireAuth, async (req, res) => {
    try { res.json(await settings.settingsFor(req.user.id)); } catch (err) { fail(res, err, 'Failed to load your settings'); }
});
router.put('/settings', requireAuth, async (req, res) => {
    try {
        const b = req.body || {};
        const audience = String(b.default_audience || '');
        await settings.setDefaultAudience(req.user.id, audience);
        // "Apply to all my existing episodes" (VISIBILITY-EVERYWHERE rule 2): the same request, so the
        // default and what it was applied to can never disagree.
        const applied = b.apply ? await settings.applyToEpisodes(req.user.id, req.user.subject, audience) : 0;
        res.json({ ...(await settings.settingsFor(req.user.id)), applied });
    } catch (err) { fail(res, err, 'Failed to save your settings'); }
});

/** Deleting: the streamer's own items only, each with a receipt. */
router.post('/delete/take', requireAuth, async (req, res) => {
    try { res.json(await del.deleteTake((req.body || {}).id, req.user)); } catch (err) { fail(res, err, 'Failed to delete that take'); }
});
router.post('/delete/episode', requireAuth, async (req, res) => {
    try { res.json(await del.deleteEpisode((req.body || {}).stream_id, req.user)); } catch (err) { fail(res, err, 'Failed to delete that episode'); }
});
router.post('/delete/all', requireAuth, async (req, res) => {
    try { res.json(await del.deleteAll(req.user, { keepOut: !!(req.body && req.body.keep_out) })); } catch (err) { fail(res, err, 'Failed to delete your Rundown'); }
});
/** "Write this stream up again": the desk may read that stream once more. */
router.post('/restore', requireAuth, async (req, res) => {
    try { res.json(await del.restore((req.body || {}).stream_id, req.user)); } catch (err) { fail(res, err, 'Failed to write that stream up again'); }
});

router.get('/voice/:user', optionalAuth, async (req, res) => {
    try {
        const voice = require('./voice');
        if (!voice.allow(req.ip, !!req.user)) return res.status(429).json({ error: 'Slow down — too many voice requests' });
        const text = voice.cleanText(req.query.t || '');
        if (text.length < 2) return res.status(400).json({ error: 'Nothing to say' });
        const user = await db.get('SELECT * FROM users WHERE lower(username) = lower(?)', [String(req.params.user || '').replace(/^@/, '')]);
        if (!user) return res.status(404).json({ error: 'No such user' });
        const out = await voice.speak({ user, text });
        res.set({ 'Content-Type': out.mimeType, 'Cache-Control': 'public, max-age=604800, immutable', 'X-Cache': out.cached ? 'HIT' : 'MISS' });
        require('stream').pipeline(require('fs').createReadStream(out.path), res, () => {});
    } catch (err) { res.status(err.message && /budget|hoarse/.test(err.message) ? 429 : 500).json({ error: err.message || 'Voice failed' }); }
});

/** Where an old Arena link goes: a fighter's /arena/<username> is the streamer's page, everything else the front page. */
function arenaRedirect(path) {
    const segs = String(path || '').split('/').filter(Boolean);
    let seg = '';
    try { seg = segs[1] ? decodeURIComponent(segs[1]) : ''; } catch { seg = ''; }
    const fighter = segs[0] === 'arena' && segs.length === 2 && /^[A-Za-z0-9_.-]{1,64}$/.test(segs[1]) && !/^(drama|beef|live|topic|chatter)$/i.test(segs[1]);
    return fighter ? `/rundown/${encodeURIComponent(segs[1])}` : '/rundown';
}

module.exports = router;
module.exports.arenaRedirect = arenaRedirect;
