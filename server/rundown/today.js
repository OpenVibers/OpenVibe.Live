'use strict';
/**
 * The Rundown's Today card (docs/rundown.md): what today was about, written by the desk from today's takes.
 *
 * The card is written by OpenVibe.AI (`live.rundown.today`): a headline, two to four sentences and up to three
 * highlights, each pointing at the take it came from. Its take ids are checked against today's public takes here,
 * so a highlight can never link to something that is not on the page, and the public-text rules apply: the stored
 * words go through the same text filter as the rest of the Rundown (`db.publicMemoryText`), and a card that says
 * anything sexual (server/ai/explicit.js) is never stored or served.
 *
 *   refresh(date)   ask the AI and store the card, when it is due
 *   get(date)       the stored card for that UTC day, or null
 *   tick()          the job: today's card, at most once every 30 minutes, only while there are new takes
 *   ssrHtml(card)   the server-rendered card (kit markup); the page's script draws the same card in the browser
 *
 * The job is due-based, not clock-based: the first three takes of the day make a card, then it is rewritten only
 * when at least REFRESH_MS has passed since the last one AND a take newer than the card's latest has arrived.
 * It starts nothing under LIVE_DRILL (a restore drill answers reads only).
 */
const db = require('../db/database');
const day = require('./day');
const drill = require('../drill');
const explicit = require('../ai/explicit');
const kit = require('openvibe-shared/kit');

const REFRESH_MS = 30 * 60 * 1000;   // at most one AI write per half hour
const CHECK_MS = 5 * 60 * 1000;      // how often the job looks for a due day
const MIN_TAKES = 1;                 // one take is a day: the card says what was said, and grows with the day
const MAX_TAKES = 30;                // the workflow takes at most 30 takes
const MAX_FETCH = 400;               // a very busy day is sampled, not read whole
const CARD_VERSION = 2;              // 2: the day's takes are listed for the model, and a card that denies them is dropped
const KEY = (date) => `rundown_today:${date}`;

const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const clamp = (t, n) => {
    const s = db.plainProse(db.publicMemoryText(String(t == null ? '' : t))).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return s.slice(0, n) || null;
};
const takeUrl = (streamId, takeId) => `/rundown/e/${Number(streamId)}#rd-take-${Number(takeId)}`;

/** Today's public takes, oldest first, up to MAX_FETCH (the day endpoint's own audience rule). */
async function takesFor(date) {
    const out = [];
    let offset = 0, total = 0, got = 0;
    do {
        const page = await day.dayData(date, { offset, limit: 100 });
        out.push(...page.all);
        total = page.total;
        got = page.all.length;
        offset += got;
    } while (got === 100 && out.length < Math.min(total, MAX_FETCH));
    return { takes: out, total };
}

/** Up to max takes, across the whole day (first and last kept), in time order. */
function sampleTakes(items, max = MAX_TAKES) {
    const list = Array.isArray(items) ? items : [];
    if (list.length <= max) return list.slice();
    const out = [];
    for (let i = 0; i < max; i++) out.push(list[Math.round(i * (list.length - 1) / (max - 1))]);
    return out;
}

/** The workflow input: only what the model may say, each take with the id its highlight must copy. */
function cardInput(date, items) {
    return {
        date,
        takes: items.map((t) => ({
            take_id: Number(t.id), streamer: t.channel && t.channel.username ? t.channel.username : 'someone',
            when: t.time || null, topic: t.topic && t.topic.title ? t.topic.title : null,
            what: t.what || null, take: t.take || null,
        })),
    };
}

/**
 * Is a card due? Never before MIN_TAKES; the first card is due at once; after that it waits out REFRESH_MS and
 * needs a take newer than the one the stored card last saw.
 */
function isDue(stored, { now = Date.now(), total = 0, latest_take_id = null } = {}) {
    if (Number(total) < MIN_TAKES) return false;
    if (!stored || stored.version !== CARD_VERSION || !Number(stored.generated_at)) return true;
    if (now - Number(stored.generated_at) < REFRESH_MS) return false;
    const seen = Number(stored.latest_take_id || 0);
    return latest_take_id != null && Number(latest_take_id) > seen;
}

/** The card's words are public: the text filter and the explicit guard, as every other public AI text. */
function cardText(out) {
    if (!out || typeof out !== 'object') return null;
    const headline = clamp(out.headline, 100);
    const summary = clamp(out.summary, 700);
    if (!headline || !summary) return null;
    const highlights = (Array.isArray(out.highlights) ? out.highlights : [])
        .map((h) => ({ take_id: Number(h && h.take_id), line: clamp(h && h.line, 240) }))
        .filter((h) => Number.isInteger(h.take_id) && h.take_id > 0 && h.line)
        .filter((h, i, all) => all.findIndex((x) => x.take_id === h.take_id) === i)
        .slice(0, 3);
    if (explicit.isExplicit(headline, summary, ...highlights.map((h) => h.line))) return null;
    return { headline, summary, highlights };
}

function enrich(out, items, total) {
    const byId = new Map(items.map((t) => [Number(t.id), t]));
    const seen = new Set();
    const highlights = [];
    for (const h of out.highlights) {
        const t = byId.get(h.take_id);
        if (!t || seen.has(h.take_id)) continue;
        seen.add(h.take_id);
        highlights.push({
            take_id: h.take_id,
            line: h.line,
            stream_id: Number(t.stream_id),
            username: t.channel && t.channel.username ? t.channel.username : null,
            topic: t.topic && t.topic.title ? t.topic.title : null,
            url: takeUrl(t.stream_id, h.take_id),
        });
        if (highlights.length >= 3) break;
    }
    return { ...out, highlights };
}

/** The stored card for that UTC day, or null. */
async function get(date) {
    if (!date) return null;
    try {
        const raw = await db.getSetting(KEY(date));
        const card = raw ? JSON.parse(raw) : null;
        return card && card.status === 'ready' && card.version === CARD_VERSION && card.date === date ? card : null;
    } catch { return null; }
}

async function siteOn() {
    try { const v = await db.getSetting('rundown_enabled'); return v === null || v === undefined || v === true || v === 'true' || v === 1 || v === '1'; } catch { return true; }
}
async function aiOn() {
    try { const llm = require('../ai/llm'); return await llm.isEnabled() && await llm.withinBudget(); } catch { return false; }
}

/**
 * Write today's card if it is due. ai is injectable for tests (a function like ai-service.structured).
 * Returns the stored card, the existing card when not due, or null when there was nothing to write.
 */
async function refresh(date, { now = Date.now(), force = false, ai = null } = {}) {
    if (drill.enabled) return null;
    if (date === 'today' || !date) date = utcDay(now);
    if (!await siteOn()) { console.log('[Rundown] today: the Rundown is switched off'); return null; }
    if (!ai && !await aiOn()) { console.log('[Rundown] today: AI is off or over its daily budget'); return null; }
    const { takes, total } = await takesFor(date);
    const latest = takes.reduce((n, t) => Math.max(n, Number(t.id) || 0), 0);
    const stored = await get(date);
    if (!force && !isDue(stored, { now, total, latest_take_id: latest })) return stored;
    const sample = sampleTakes(takes);
    const input = cardInput(date, sample);
    let out = null;
    try { out = await (ai || require('../ai/ai-service').structured)('live.rundown.today', input, { meter: { kind: 'rundown_today', role: 'chat', source: 'rundown' } }); }
    catch { out = null; }
    if (!out) { console.log(`[Rundown] today: no AI answer for ${date}`); return null; }
    const text = cardText(out);
    if (!text) { console.log(`[Rundown] today: the AI answer for ${date} was filtered`); return null; }
    const card = { status: 'ready', version: CARD_VERSION, date, ...enrich(text, sample, total), generated_at: now, latest_take_id: latest, take_count: total, take_sample: sample.length };
    try { await db.setSetting(KEY(date), JSON.stringify(card)); } catch { return null; }
    return card;
}

async function tick(now = Date.now()) {
    const date = utcDay(now);
    const card = await refresh(date, { now });
    // refresh() also returns the stored card when the day is not due; only a card written now is news.
    if (card && Number(card.generated_at) === Number(now)) console.log(`[Rundown] Today card for ${date}: ${card.take_count} take(s), ${card.highlights.length} highlight(s)`);
    return card;
}

let _job = null;
function start() {
    if (_job || drill.enabled) return;
    _job = require('../utils/jobs').every('rundown-today', CHECK_MS, () => tick().catch((e) => console.warn('[Rundown] today card:', e.message)), { initialDelayMs: 30 * 1000, jitterMs: 10 * 1000 });
    console.log(`[Rundown] Today card job started (checks every ${CHECK_MS / 60000} min, writes at most every ${REFRESH_MS / 60000} min while there are new takes)`);
}
function stop() { if (typeof _job === 'function') _job(); _job = null; }

/** The server-rendered card, kit markup: headline, the day in a few sentences, each highlight a link to its take. */
function ssrHtml(card) {
    if (!card || card.status !== 'ready' || !card.headline || !card.summary) return '';
    const rows = (card.highlights || []).map((h) => kit.row({
        href: h.url || takeUrl(h.stream_id, h.take_id),
        title: h.line,
        sub: [h.username, h.topic].filter(Boolean).join(' · '),
    }));
    return kit.section({
        title: "Today's rundown", icon: 'spark', note: 'Written by AI from today’s takes.',
        body: `<p class="rd-today-headline"><strong>${kit.esc(card.headline)}</strong></p><p class="rd-today-sum">${kit.esc(card.summary)}</p>`
            + (rows.length ? kit.list(rows, { title: 'Highlights' }) : ''),
    });
}

module.exports = {
    refresh, get, tick, start, stop, ssrHtml, isDue, sampleTakes, cardInput, cardText, takesFor, utcDay,
    REFRESH_MS, CHECK_MS, MIN_TAKES, MAX_TAKES, CARD_VERSION, KEY,
};
