'use strict';
/**
 * /api/rundown — The Rundown (docs/rundown.md): what streamers talked about, written up by the desk (desk.js).
 *
 *   GET  /                      on air now, the latest (episodes + the best segments), trending topics, who's been talking
 *   GET  /latest?before=        the next page of the latest
 *   GET  /topics?sort=&kind=    every topic (sort recent | most)
 *   GET  /t/:slug               one topic and every take on it
 *   GET  /e/:streamId           one stream as an episode, with its segments
 *   GET  /s/:username           a streamer's episodes, topics, lines and crossovers
 *   POST /react {type, id, reaction}     one per reader per item (fire, lol, dead, cap, facts); the same again takes it back
 *   POST /hide {type, id}       staff: take a segment, episode or topic down
 *   GET|PUT /opt-out {out}      signed in: keep yourself out of the Rundown (or come back)
 *   GET  /voice/:user?t=        a line in that streamer's chat voice (server/arena/voice.js)
 */
const crypto = require('crypto');
const express = require('express');
const { requireAuth, optionalAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');
const db = require('../db/database');
const read = require('./read');

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
// Pages with reactions are per reader; the rest is the same for everyone for a minute.
const fresh = (res) => res.set('Cache-Control', 'no-store');

router.get('/', optionalAuth, async (req, res) => {
    try { fresh(res); res.json(await read.home({ viewer: await voterKey(req) })); } catch (err) { fail(res, err, 'The Rundown is unavailable'); }
});
router.get('/streams', optionalAuth, async (req, res) => {
    try { fresh(res); res.json(await read.streamsFeed({ before: req.query.before ? String(req.query.before) : null, viewer: await voterKey(req) })); } catch (err) { fail(res, err, 'Failed to load the streams'); }
});
router.get('/latest', optionalAuth, async (req, res) => {
    try { fresh(res); res.json(await read.latest({ before: req.query.before ? String(req.query.before) : null, viewer: await voterKey(req) })); } catch (err) { fail(res, err, 'Failed to load the latest'); }
});
router.get('/topics', async (req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=60');
        res.json(await read.topics({ sort: req.query.sort === 'most' ? 'most' : 'recent', kind: req.query.kind ? String(req.query.kind) : null, offset: parseInt(req.query.offset, 10) || 0 }));
    } catch (err) { fail(res, err, 'Failed to load the topics'); }
});
router.get('/t/:slug', optionalAuth, async (req, res) => {
    try { const t = await read.topic(req.params.slug, { viewer: await voterKey(req) }); if (!t) return res.status(404).json({ error: 'No such topic' }); fresh(res); res.json(t); }
    catch (err) { fail(res, err, 'Failed to load the topic'); }
});
router.get('/e/:streamId', optionalAuth, async (req, res) => {
    try { const e = await read.episode(req.params.streamId, { viewer: await voterKey(req) }); if (!e) return res.status(404).json({ error: 'No such episode' }); fresh(res); res.json(e); }
    catch (err) { fail(res, err, 'Failed to load the episode'); }
});
router.get('/s/:username', optionalAuth, async (req, res) => {
    try { const s = await read.streamer(req.params.username, { viewer: await voterKey(req) }); if (!s) return res.status(404).json({ error: 'No such streamer' }); fresh(res); res.json(s); }
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
router.get('/voice/:user', optionalAuth, async (req, res) => {
    try {
        const voice = require('../arena/voice');
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
    const fighter = segs[0] === 'arena' && segs.length === 2 && /^[A-Za-z0-9_.-]{1,64}$/.test(seg) && !/^(drama|beef|live|topic|chatter)$/i.test(seg);
    return fighter ? `/rundown/${encodeURIComponent(seg)}` : '/rundown';
}

module.exports = router;
module.exports.arenaRedirect = arenaRedirect;
