'use strict';
/**
 * ✨ Suggest, on the go-live card (golive-setup redesign, 2026-11-02): three titles for a slot's next stream, written
 * from the titles and categories of its last streams and the streamer's own day and hour (the browser sends them; the
 * server does not know the streamer's time zone). One short AI call, attributed to the streamer (Live's per-streamer
 * AI budget), and a few a minute at most. The streamer picks one or ignores them; nothing is stored.
 *
 *   POST /api/streams/managed/:managedStreamId/title-ideas  { weekday?, hour? }  → { titles: [..3] }
 */

const MAX_TITLES = 3;
const TITLE_MAX = 80;
const WINDOW_MS = 10 * 60 * 1000;
const PER_WINDOW = 12;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const SYSTEM = [
    'You name live streams. Write titles a streamer would choose for their next stream on this slot.',
    'Keep their own way of naming streams: their words, their length, their language.',
    'Each title is plain words, under 60 characters: no hashtags, no emoji, no quotation marks, no "LIVE", no clickbait',
    'and no made-up facts (no guests, numbers or events the past titles do not show).',
    'The three titles differ from each other and from the current title.',
].join(' ');

const _uses = new Map(); // userId → timestamps in the window

/** True when this person may ask again now (and counts the ask). */
function allow(userId, now = Date.now()) {
    const list = (_uses.get(userId) || []).filter((t) => now - t < WINDOW_MS);
    if (list.length >= PER_WINDOW) { _uses.set(userId, list); return false; }
    list.push(now);
    _uses.set(userId, list);
    return true;
}

function partOfDay(hour) {
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    if (hour < 5) return 'late at night';
    if (hour < 12) return 'in the morning';
    if (hour < 17) return 'in the afternoon';
    if (hour < 21) return 'in the evening';
    return 'at night';
}

/** A title as a streamer would type it: one line, no wrapping quotes or hashtags, not too long. */
function clean(t) {
    let s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
    s = s.replace(/^\d+[.)]\s*/, '').replace(/\s#\w+/g, '').trim().replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').trim();
    if (s.length > TITLE_MAX) s = s.slice(0, TITLE_MAX).replace(/\s+\S*$/, '').trim();
    return s;
}

function promptFor({ slot, sessions, weekday, hour }) {
    const recent = sessions.slice(0, 8).map((s) => {
        const when = s.started_at ? new Date(s.started_at) : null;
        const day = when && !Number.isNaN(when.getTime()) ? DAYS[(when.getUTCDay() + 6) % 7] : '';
        return `- ${clean(s.title) || '(untitled)'}${s.category ? ` (${String(s.category).slice(0, 40)})` : ''}${day ? `, a ${day}` : ''}`;
    });
    const when = [DAYS.includes(weekday) ? `It is ${weekday}` : '', partOfDay(hour) || ''].filter(Boolean).join(' ');
    return [
        `Slot: ${clean(slot.title) || '(untitled)'}${slot.description ? ` — ${String(slot.description).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`,
        recent.length ? `Their last streams on this slot, newest first:\n${recent.join('\n')}` : 'No past streams on this slot yet.',
        when ? `${when} for the streamer.` : '',
        `Current title: ${clean(slot.title) || '(none)'}`,
        `Write ${MAX_TITLES} titles for the next stream.`,
    ].filter(Boolean).join('\n');
}

/**
 * The titles, or [] when the AI has nothing usable. deps: { db, llm, wordFilter } for tests.
 */
async function ideas({ slot, userId, weekday, hour }, deps = {}) {
    const db = deps.db || require('../db/database');
    const llm = deps.llm || require('../ai/llm');
    let sessions = [];
    try { sessions = await db.getStreamHistoryByManagedStream(slot.id, userId, 8); } catch { sessions = []; }
    const r = await llm.complete({
        role: 'chat', system: SYSTEM, user: promptFor({ slot, sessions, weekday, hour }),
        json: { name: 'titles', strict: true, schema: { type: 'object', additionalProperties: false, required: ['titles'], properties: { titles: { type: 'array', items: { type: 'string' } } } } },
        maxTokens: 180, temperature: 0.8, kind: 'golive_title_ideas', source: 'golive-suggest', ownerUserId: userId, timeoutMs: 20000,
    }).catch(() => null);
    if (!r) return [];
    let raw = r.json && Array.isArray(r.json.titles) ? r.json.titles : null;
    if (!raw) {
        try { const j = JSON.parse(r.text); raw = Array.isArray(j.titles) ? j.titles : null; } catch { raw = String(r.text || '').split('\n'); }
    }
    let filter = deps.wordFilter;
    if (!filter) { try { filter = require('../chat/word-filter'); } catch { filter = null; } }
    const seen = new Set([clean(slot.title).toLowerCase()]);
    const out = [];
    for (const t of raw || []) {
        const c = clean(t);
        if (c.length < 3 || seen.has(c.toLowerCase())) continue;
        if (filter && filter.check && !filter.check(c).safe) continue;
        seen.add(c.toLowerCase());
        out.push(c);
        if (out.length === MAX_TITLES) break;
    }
    return out;
}

function mount(router, { requireAuth, db }) {
    router.post('/managed/:managedStreamId/title-ideas', requireAuth, async (req, res) => {
        const id = parseInt(req.params.managedStreamId, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid ID' });
        try {
            const slot = await db.getManagedStreamById(id);
            if (!slot) return res.status(404).json({ error: 'Managed stream not found' });
            if (slot.user_id !== req.user.id) return res.status(403).json({ error: 'Not your managed stream' });
            if (!allow(req.user.id)) return res.status(429).json({ error: 'That is a lot of ideas: try again in a few minutes.' });
            const body = req.body || {};
            const hour = Number.isInteger(body.hour) ? body.hour : null;
            const weekday = typeof body.weekday === 'string' ? body.weekday : null;
            // The title being typed counts as the current one, so the ideas differ from it.
            const typed = typeof body.title === 'string' ? body.title.slice(0, 200) : null;
            const titles = await ideas({ slot: { ...slot, title: typed != null ? typed : slot.title }, userId: req.user.id, weekday, hour });
            res.set('Cache-Control', 'no-store');
            if (!titles.length) return res.status(503).json({ error: 'No ideas right now. Try again in a minute.' });
            res.json({ titles });
        } catch (err) {
            console.error('[TitleIdeas]', err.message);
            res.status(500).json({ error: 'No ideas right now. Try again in a minute.' });
        }
    });
}

module.exports = { ideas, mount, clean, promptFor, partOfDay, allow, _uses, MAX_TITLES };
