/**
 * OpenVibe.Live — Arena API (mounted at /api/arena) — Battle Cam mode
 *
 *   GET  /status · /fighters · /fighters/:user · /fighters/:user/stat/:stat · /live
 *   GET  /feed?limit&since                            the shit-talk feed: newest judged mic lines across every cam
 *   POST /fighters/:user/refresh                      admin: regenerate persona (+ portrait)
 *   GET  /console/:user                               what the ears hear for a live fighter (focus lock, judgements)
 *   GET  /beefs · /beefs/:id · POST /beefs/:id/hype {side}
 *   GET  /levels                                      Trash Level ladder (XP from mic only)
 *   GET  /me                                          the signed-in fighter's own state (beefs on them, level, moments)
 *   GET  /voice/:user?t=<text>                        the line read in that user's chat TTS voice
 */
'use strict';

const express = require('express');
const { requireAuth, optionalAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');
const db = require('../db/database');
const arena = require('./arena-service');
const mic = require('./mic');
const beef = require('./beef');
const listener = require('./listener');

const router = express.Router();

router.use((req, res, next) => { if (!arena.arenaEnabled()) return res.status(404).json({ error: 'Arena is disabled' }); next(); });
const fail = (res, err, msg) => { console.error('[Arena]', msg, err.message); res.status(500).json({ error: msg }); };
const userFrom = (param) => (/^\d+$/.test(String(param)) ? db.getUserById(Number(param)) : db.getUserByUsername(String(param).replace(/^@/, '')));

router.get('/status', (req, res) => { try { res.json(arena.status()); } catch (err) { fail(res, err, 'Arena unavailable'); } });

router.get('/fighters', (req, res) => {
    try { res.set('Cache-Control', 'public, max-age=30'); res.json({ fighters: arena.listFighters(), ai: arena.aiOn(), image_generation: arena.imageGenAvailable(), stats: arena.STAT_KEYS, stat_meta: arena.STAT_META }); }
    catch (err) { fail(res, err, 'Failed to load the roster'); }
});
router.get('/live', (req, res) => { try { res.set('Cache-Control', 'no-store'); res.json({ live: arena.liveFighters() }); } catch (err) { fail(res, err, 'Failed to load live fighters'); } });
router.get('/feed', (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));
        const since = req.query.since ? Number(req.query.since) : null;
        res.json({ feed: mic.feed({ limit, since }), ai: arena.aiOn() });
    } catch (err) { fail(res, err, 'Failed to load the feed'); }
});

router.get('/fighters/:user/stat/:stat', (req, res) => {
    try {
        const user = userFrom(req.params.user);
        if (!user || !arena.loadRoster().byId[user.id]) return res.status(404).json({ error: 'No such fighter on the roster' });
        const detail = arena.getStatDetail(user.id, String(req.params.stat));
        if (!detail) return res.status(404).json({ error: 'Unknown stat' });
        res.set('Cache-Control', 'public, max-age=120');
        res.json(detail);
    } catch (err) { fail(res, err, 'Failed to load stat detail'); }
});
router.get('/fighters/:user', async (req, res) => {
    try {
        const card = await arena.getFighter(req.params.user, { generate: req.query.generate !== '0' });
        if (!card) return res.status(404).json({ error: 'No such fighter' });
        if (!card.not_on_roster) {
            try { card.rivalries = beef.rivalriesFor(card.user.id); } catch { card.rivalries = []; }
            try { card.moments = mic.momentsFor(card.user.id, 14); } catch { card.moments = []; }
            try { card.best_lines = mic.bestLines(card.user.id, 5); } catch { card.best_lines = []; }
        }
        res.set('Cache-Control', 'no-store');
        res.json(card);
    } catch (err) { fail(res, err, 'Failed to load fighter'); }
});
router.post('/fighters/:user/refresh', requireAuth, permissions.requireAdmin, async (req, res) => {
    try {
        const card = await arena.getFighter(req.params.user, { generate: false });
        if (!card || card.not_on_roster) return res.status(404).json({ error: 'No such fighter on the roster' });
        const persona = await arena.generatePersona(card.user.id, { force: true });
        const image = req.body?.image !== false && arena.imageGenAvailable() ? await arena.generateImage(card.user.id, { force: true }) : null;
        res.json({ ok: true, persona, image_url: image });
    } catch (err) { fail(res, err, 'Refresh failed'); }
});

// Admin: judge past speech now (bounded per call; the job also does this every 20 min).
router.post('/backfill', requireAuth, permissions.requireAdmin, async (req, res) => {
    try { res.json(await require('./backfill').run({ force: true })); } catch (err) { fail(res, err, 'Backfill failed'); }
});

// ── Live console: what the ears hear for one fighter ──
router.get('/console/:user', (req, res) => {
    try {
        const user = userFrom(req.params.user);
        if (!user) return res.status(404).json({ error: 'No such user' });
        const roster = arena.loadRoster();
        const brief = mic.fighterBrief(user.id, roster);
        const liveStream = db.get('SELECT id, title, started_at, viewer_count FROM streams WHERE user_id = ? AND is_live = 1 ORDER BY started_at DESC LIMIT 1', [user.id]);
        let lines = [];
        if (liveStream) {
            lines = db.all(`SELECT text, start_sec, vod_id FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' ORDER BY start_sec DESC LIMIT 14`, [liveStream.id]).reverse()
                .filter(l => !arena._isBannedText(l.text)).map(l => ({ text: l.text, sec: Math.floor(l.start_sec), vod_id: l.vod_id }));
        }
        res.set('Cache-Control', 'no-store');
        res.json({
            fighter: brief, on_roster: !!roster.byId[user.id], live: !!liveStream, stream: liveStream || null,
            transcribed: liveStream ? !!db.get(`SELECT 1 FROM stream_timeline_events WHERE stream_id = ? AND kind = 'speech' AND created_at >= datetime('now', '-30 minutes') LIMIT 1`, [liveStream.id]) : false,
            listener: listener.consoleState(user.id),
            level: mic.levelView(user.id),
            mic: mic.micStats(user.id),
            open_beefs: beef.openBeefsFor(user.id).map(b => beef.beefView(b, roster)),
            hot_mic: lines,
            recent_moments: mic.momentsFor(user.id, 8),
        });
    } catch (err) { fail(res, err, 'Failed to load console'); }
});

// ── Beefs ──
router.get('/beefs', (req, res) => { try { res.set('Cache-Control', 'no-store'); res.json(beef.list()); } catch (err) { fail(res, err, 'Failed to load beefs'); } });
router.get('/beefs/:id', (req, res) => {
    try { const b = beef.get(Number(req.params.id)); if (!b) return res.status(404).json({ error: 'No such beef' }); res.set('Cache-Control', 'no-store'); res.json(b); }
    catch (err) { fail(res, err, 'Failed to load beef'); }
});
router.post('/beefs/:id/hype', optionalAuth, (req, res) => {
    try { res.json(beef.hype(Number(req.params.id), String(req.body?.side || ''), arena.voterKeyFor(req))); } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Hear it in their voice ──
router.get('/voice/:user', optionalAuth, async (req, res) => {
    try {
        const voice = require('./voice');
        if (!voice.allow(req.ip, !!req.user)) return res.status(429).json({ error: 'Slow down — too many voice requests' });
        const text = voice.cleanText(req.query.t || req.query.text || '');
        if (text.length < 2) return res.status(400).json({ error: 'Nothing to say' });
        const who = String(req.params.user || '').toLowerCase();
        const user = who === 'announcer' ? null : userFrom(who);
        if (who !== 'announcer' && !user) return res.status(404).json({ error: 'No such user' });
        const out = await voice.speak({ user, text });
        res.set({ 'Content-Type': out.mimeType, 'Cache-Control': 'public, max-age=604800, immutable', 'X-Arena-Voice': out.voice, 'X-Cache': out.cached ? 'HIT' : 'MISS' });
        require('fs').createReadStream(out.path).pipe(res);
    } catch (err) { res.status(err.message && /budget|hoarse/.test(err.message) ? 429 : 500).json({ error: err.message || 'Voice failed' }); }
});

// ── Your Arena: the signed-in fighter's own state ──
router.get('/me', requireAuth, (req, res) => {
    try {
        const roster = arena.loadRoster();
        const onRoster = !!roster.byId[req.user.id];
        const fighter = onRoster ? { ...mic.fighterBrief(req.user.id, roster), level: mic.levelView(req.user.id), record: beef.recordFor(req.user.id), power: roster.byId[req.user.id].ratings.power, mic: mic.micStats(req.user.id) } : null;
        const beefs = onRoster ? beef.openBeefsFor(req.user.id).map(b => beef.beefView(b, roster)) : [];
        const onClock = beefs.filter(b => (b.on_clock === 'a' ? b.a.user.id : b.b.user.id) === req.user.id);
        res.set('Cache-Control', 'no-store');
        res.json({ on_roster: onRoster, fighter, beefs, on_clock: onClock, moments: onRoster ? mic.momentsFor(req.user.id, 6) : [], live: onRoster ? !!db.get('SELECT 1 FROM streams WHERE user_id = ? AND is_live = 1 LIMIT 1', [req.user.id]) : false });
    } catch (err) { fail(res, err, 'Failed to load your arena'); }
});

router.get('/levels', (req, res) => { try { res.json({ levels: mic.levelsLeaderboard(20) }); } catch (err) { fail(res, err, 'Failed'); } });

module.exports = router;
