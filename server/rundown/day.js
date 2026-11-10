'use strict';

const db = require('../db/database');
const read = require('./read');
const explicit = require('../ai/explicit');

const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const validDate = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const splitSentences = (s) => String(s || '').split(/(?<=[.!?])\s+(?=[A-Z])|(?<=\])\s+(?=[A-Z])/).map((x) => x.trim()).filter(Boolean);

async function dayData(date, { offset = 0, limit = 50, viewer = null } = {}) {
    if (!validDate(date)) throw Object.assign(new Error('Date must be YYYY-MM-DD or today'), { status: 400 });
    const v = viewer || {};
    const query = await db.all(`SELECT s.id, s.stream_id, s.user_id, s.topic_id, s.start_sec, s.vod_id, s.said_at,
            s.title, s.what, s.take, s.status, s.quotes_json, s.mentions, u.username, u.display_name,
            st.channel_id, t.title AS topic_title, t.slug AS topic_slug,
            st.ended_at, e.stream_id AS episode_id
        FROM rundown_segments s JOIN streams st ON st.id = s.stream_id
        JOIN users u ON u.id = s.user_id LEFT JOIN channels c ON c.id = st.channel_id
        LEFT JOIN rundown_topics t ON t.id = s.topic_id
        LEFT JOIN rundown_episodes e ON e.stream_id = st.id AND e.status = 'live'
        LEFT JOIN shares sh ON sh.service='live' AND sh.kind='rundown-episode' AND sh.resource_id=CAST(st.id AS text)
        LEFT JOIN rundown_visibility vis ON vis.stream_id=st.id
        WHERE s.status='live' AND DATE(s.said_at) = ?
          AND (s.user_id = ? OR (COALESCE(sh.audience,'public')='public' AND COALESCE(vis.vod_audience,'public')='public'))
        ORDER BY s.said_at ASC, s.id ASC LIMIT ? OFFSET ?`, [date, v.userId || -1, Math.min(100, limit), Math.max(0, offset)]);
    const history = require('../streaming/stream-history');
    const offsets = await history.vodOffsets(query.map((r) => r.vod_id));
    const all = query.map((r) => { const sec = Math.max(0, Math.floor(history.vodTime(Number(r.start_sec) || 0, r.vod_id ? offsets.get(Number(r.vod_id)) : 0))); return { id: Number(r.id), stream_id: Number(r.stream_id), take: r.take || null, what: r.what,
        time: r.said_at, channel: { id: r.channel_id == null ? null : Number(r.channel_id), username: r.username },
        topic: r.topic_title ? { title: r.topic_title, slug: r.topic_slug } : null,
        vod: r.vod_id == null ? null : { id: Number(r.vod_id), sec, url: `/vod/${Number(r.vod_id)}?t=${sec}` } }; });
    const countRow = await db.get(`SELECT COUNT(*) AS n FROM rundown_segments s JOIN streams st ON st.id=s.stream_id
        LEFT JOIN shares sh ON sh.service='live' AND sh.kind='rundown-episode' AND sh.resource_id=CAST(st.id AS text)
        LEFT JOIN rundown_visibility vis ON vis.stream_id=st.id
        WHERE s.status='live' AND DATE(s.said_at)=? AND (s.user_id=? OR (COALESCE(sh.audience,'public')='public' AND COALESCE(vis.vod_audience,'public')='public'))`, [date, v.userId || -1]);
    return { all, total: Number(countRow.n || 0) };
}

async function summary(date, takes) {
    if (takes.length < 3) return { status: 'too_few_takes', minimum: 3, takes: takes.length, sentences: [] };
    const ended = Date.parse(`${date}T23:59:59Z`) < Date.now();
    const key = `rundown_day_summary:${date}`;
    let cached = null;
    try { cached = parseJson(await db.getSetting(key), null); } catch { /* cache is best effort */ }
    if (cached && (ended || Date.now() - Number(cached.generated_at) < 3600000)) return cached;
    const enabled = await db.getSetting('ai_rundown_day_summary_enabled');
    if (!['true', '1'].includes(String(enabled))) return { status: 'disabled', sentences: [] };
    const llm = require('../ai/llm');
    if (!await llm.isEnabled() || !await llm.withinBudget()) return { status: 'unavailable', sentences: [] };
    // Reuse the Rundown's existing structured writing task and AI client. Take ids are included in the source
    // labels; citations are accepted only when the model returns them verbatim as [takes: id,id].
    const input = { topic: `AI Today's UTC day ${date}`, takes: takes.slice(0, 30).map((t) => ({
        streamer: t.channel.username, when: t.time, what: `[take:${t.id}] ${t.what}`, take: t.take,
        quote: t.topic && t.topic.title ? `Topic: ${t.topic.title}` : null,
    })) };
    let out;
    try { out = await require('../ai/ai-service').structured('live.rundown.topic', input, { meter: { kind: 'rundown_day', role: 'chat', source: 'rundown' } }); }
    catch { return { status: 'unavailable', sentences: [] }; }
    const ids = new Set(takes.map((t) => t.id));
    const sentences = splitSentences(out && out.summary).map((text) => {
        const m = text.match(/\[takes?:\s*([\d, ]+)\]/i);
        if (!m) return null;
        const take_ids = m[1].split(',').map((x) => Number(x.trim()));
        if (!take_ids.length || take_ids.some((id) => !ids.has(id))) return null;
        const clean = text.replace(/\s*\[takes?:\s*[\d, ]+\]/i, '').trim();
        if (!clean || explicit.isExplicit(clean)) return null;
        return { text: clean, take_ids };
    }).filter(Boolean).slice(0, 5);
    const channelByTake = new Map(takes.map((t) => [t.id, t.channel.id]));
    for (const sentence of sentences) sentence.channel_ids = [...new Set(sentence.take_ids.map((id) => channelByTake.get(id)).filter((id) => id != null))];
    const result = { status: sentences.length ? 'ready' : 'unavailable', generated_at: Date.now(), sentences };
    if (sentences.length) await db.setSetting(key, JSON.stringify(result));
    return result;
}

async function getDay(date, opts = {}) {
    if (date === 'today') date = new Date().toISOString().slice(0, 10);
    const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
    const limit = Math.max(1, Math.min(100, parseInt(opts.limit, 10) || 50));
    const { all, total } = await dayData(date, { ...opts, offset, limit });
    const summaryRows = offset === 0 && limit >= 100 ? all : (await dayData(date, { viewer: opts.viewer, offset: 0, limit: 100 })).all;
    const summaryData = await summary(date, summaryRows);
    return { date, summary: summaryData, timeline: { items: all, total, offset, limit, next_offset: offset + all.length < total ? offset + all.length : null } };
}

module.exports = { getDay, dayData, summary, validDate, splitSentences };
