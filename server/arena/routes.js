/**
 * OpenVibe.Live — Arena API (mounted at /api/arena)
 *
 *   GET  /status · /fighters · /fighters/:user · /fighters/:user/stat/:stat · /live
 *   POST /fighters/:user/refresh                      admin: regenerate persona (+ portrait)
 *   GET  /console/:user                               what the listener hears for a live fighter
 *   GET  /board                                       pulse + open events (topics/debates/phrases/bounties) + leaderboards
 *   POST /board/topics {text}                         signed in, 1 per person + per IP per 24 h; AI rewrites it
 *   GET  /board/topics/:id · POST …/hype {user_id}       (no joining — the ears auto-detect who talks on what)
 *   POST /board/bounty {username}                     put a bounty on a fighter
 *   GET  /beefs · /beefs/:id · POST /beefs/:id/hype {side}
 *   GET  /levels · /yappers                           Trash Level ladder · viewers who keep subjects alive from chat
 *   GET  /voice/:user?t=<text>                        the line read in that user's chat TTS voice (cached on disk + a week in the browser)
 */
'use strict';

const express = require('express');
const { requireAuth, optionalAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');
const db = require('../db/database');
const arena = require('./arena-service');
const board = require('./board');
const beef = require('./beef');
const listener = require('./listener');

const router = express.Router();

router.use((req, res, next) => { if (!arena.arenaEnabled()) return res.status(404).json({ error: 'Arena is disabled' }); next(); });
const fail = (res, err, msg) => { console.error('[Arena]', msg, err.message); res.status(500).json({ error: msg }); };
const userFrom = (param) => (/^\d+$/.test(String(param)) ? db.getUserById(Number(param)) : db.getUserByUsername(String(param).replace(/^@/, '')));

router.get('/status', (req, res) => { try { res.json(arena.status()); } catch (err) { fail(res, err, 'Arena unavailable'); } });

router.get('/fighters', (req, res) => {
    try { res.set('Cache-Control', 'public, max-age=30'); res.json({ fighters: arena.listFighters(), ai: arena.aiOn(), image_generation: arena.imageGenAvailable() }); }
    catch (err) { fail(res, err, 'Failed to load the roster'); }
});
router.get('/live', (req, res) => { try { res.set('Cache-Control', 'no-store'); res.json({ live: arena.liveFighters() }); } catch (err) { fail(res, err, 'Failed to load live fighters'); } });

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
        if (!card.not_on_roster) { try { card.rivalries = beef.rivalriesFor(card.user.id); } catch { card.rivalries = []; } }
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

// ── Live console: what the ears hear for one fighter ──
router.get('/console/:user', (req, res) => {
    try {
        const user = userFrom(req.params.user);
        if (!user) return res.status(404).json({ error: 'No such user' });
        const roster = arena.loadRoster();
        const brief = board.fighterBrief(user.id, roster);
        const liveStream = db.get('SELECT id, title, started_at, viewer_count FROM streams WHERE user_id = ? AND is_live = 1 ORDER BY started_at DESC LIMIT 1', [user.id]);
        const active = board.activeTopicFor(user.id);
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
            level: board.levelView(user.id),
            active_topic: active ? board.topicDetail(active.id) : null,
            open_beefs: beef.openBeefsFor(user.id).map(b => beef.beefView(b, roster)),
            hot_mic: lines,
            bounty_on_me: board.openBountyOn(user.id) ? board.topicDetail(board.openBountyOn(user.id).id) : null,
        });
    } catch (err) { fail(res, err, 'Failed to load console'); }
});

// ── Board ──
router.get('/board', (req, res) => {
    try {
        const v = board.boardView();
        res.set('Cache-Control', 'no-store');
        const ch = require('./chatters'); res.json({ ...v, levels: board.levelsLeaderboard(8), yappers: ch.leaderboard(8), yappers_week: ch.leaderboard(5, { days: 7 }), yappers_total: ch.count(), ai: arena.aiOn() });
    } catch (err) { fail(res, err, 'Failed to load the board'); }
});
router.post('/board/topics', requireAuth, async (req, res) => {
    try {
        const onRoster = !!arena.loadRoster().byId[req.user.id];
        const t = await board.submitTopic({ text: req.body?.text, userId: req.user.id, ip: req.ip, creatorName: req.user.display_name || req.user.username, onRoster });
        board.buildLore(t.id, { force: true }).catch(() => {});
        res.json({ ok: true, topic: board.topicDetail(t.id) });
    } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/board/bounty', requireAuth, (req, res) => {
    try {
        const target = userFrom(String(req.body?.username || ''));
        if (!target || !arena.loadRoster().byId[target.id]) return res.status(404).json({ error: 'No such fighter on the roster' });
        if (target.id === req.user.id) return res.status(400).json({ error: "You can't put a bounty on yourself" });
        const name = board.fighterBrief(target.id, arena.loadRoster()).fighter_name;
        board.assertCanSubmit(req.user.id, req.ip);
        const t = board.createTopic({ text: `Bounty: ${name}`, hint: `Put up by ${req.user.display_name || req.user.username}. Say the name, collect the bag.`, createdBy: 'viewer', creatorUserId: req.user.id, creatorName: req.user.display_name || req.user.username, creatorIp: req.ip, kind: 'bounty', targetUserId: target.id, headline: `WANTED: ${name} — chat wants smoke`, tagline: `Double XP for anyone who talks shit about ${name} on stream` });
        res.json({ ok: true, topic: board.topicDetail(t.id) });
    } catch (err) { res.status(400).json({ error: err.message }); }
});
router.get('/board/topics/:id', (req, res) => {
    try {
        const t = board.topicDetail(Number(req.params.id));
        if (!t) return res.status(404).json({ error: 'No such topic' });
        res.set('Cache-Control', 'no-store');
        res.json(t);
    } catch (err) { fail(res, err, 'Failed to load topic'); }
});
router.post('/board/topics/:id/hype', optionalAuth, (req, res) => {
    try { res.json(board.hypeTopic(Number(req.params.id), Number(req.body?.user_id), arena.voterKeyFor(req))); }
    catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/pulse/refresh', requireAuth, permissions.requireAdmin, async (req, res) => {
    try { const d = await board.discoverTopics({ force: true }); const lore = await board.loreSweep(5); res.json({ ...d, lore_rewritten: lore }); } catch (err) { fail(res, err, 'Pulse refresh failed'); }
});
router.post('/board/topics/:id/lore', requireAuth, permissions.requireAdmin, async (req, res) => {
    try { res.json(await board.buildLore(Number(req.params.id), { force: true })); } catch (err) { fail(res, err, 'Lore rebuild failed'); }
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
// GET /voice/:user?t=<text>  (:user = username, or "announcer"). Synthesized once per (voice, text),
// cached on disk and by the browser (a week); the file streams back as audio.
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

router.get('/levels', (req, res) => { try { res.json({ levels: board.levelsLeaderboard(20) }); } catch (err) { fail(res, err, 'Failed'); } });
router.get('/yappers', (req, res) => { try { const ch = require('./chatters'); res.json({ yappers: ch.leaderboard(20), week: ch.leaderboard(10, { days: 7 }), total: ch.count() }); } catch (err) { fail(res, err, 'Failed'); } });
// Chatter (yapper) profile by key: user:<id> · anon:<n> · relay:<platform>:<name> — anyone who chats has one.
router.get('/chatter/:key', (req, res) => {
    try { const p = require('./chatters').profile(String(req.params.key || '')); if (!p) return res.status(404).json({ error: 'No such chatter yet — say something about a subject first' }); res.set('Cache-Control', 'no-store'); res.json(p); }
    catch (err) { fail(res, err, 'Failed to load chatter'); }
});
router.get('/chatter/by-user/:username', (req, res) => {
    try { const u = userFrom(req.params.username); if (!u) return res.status(404).json({ error: 'No such user' }); const p = require('./chatters').profile(`user:${u.id}`); if (!p) return res.status(404).json({ error: 'No yap profile yet' }); res.json(p); }
    catch (err) { fail(res, err, 'Failed'); }
});
router.post('/chatter/:key/card', requireAuth, permissions.requireAdmin, async (req, res) => { try { res.json(await require('./chatters').buildCard(String(req.params.key), { force: true })); } catch (err) { fail(res, err, 'Card failed'); } });

module.exports = router;
