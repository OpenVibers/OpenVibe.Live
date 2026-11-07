'use strict';
/**
 * Agent report citations on a Rundown topic page (Agent Streams S7, design 2026-11-06 §2).
 *
 * The Rundown's topic pages may cite a public session report when an agent worked on the topic. Only Everyone's
 * reports are read (Report's public list asks the sharing system), and the topic's whole name must appear as a whole
 * phrase — the same whole-name rule the streamers' write-ups keep. A Report outage is an empty list, never a broken
 * topic page.
 *
 * The read is cached for five minutes per topic: Report answers its public list for everyone, and a topic page is
 * refreshed by the same reader many times a day.
 */
const REPORT_URL = () => String(process.env.OV_REPORT_URL || 'https://openvibe.report').replace(/\/+$/, '');
const TTL_MS = 5 * 60_000;
const cache = new Map();   // topic phrase -> { at, list, expires }

function normalize(value) {
    return String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Whether this report speaks of the topic by its whole name (never a partial word). */
function speaksOf(report, topic) {
    const phrase = normalize(topic);
    if (!phrase) return false;
    const text = [report && report.task && report.task.title, report && report.summary, ...(report && Array.isArray(report.highlights) ? report.highlights : [])]
        .map(normalize).filter(Boolean).join(' ');
    return new RegExp(`(^| )${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(text);
}

function cite(report) {
    return {
        id: report.id,
        title: (report.task && report.task.title) || report.summary || 'An agent session',
        summary: report.summary || null,
        outcome: report.outcome || 'done',
        worked_seconds: Number(report.worked_seconds) || 0,
    };
}

function createCitations({ fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), url = REPORT_URL(), ttl = TTL_MS } = {}) {
    async function forTopic(topic, { limit = 6 } = {}) {
        const phrase = normalize(topic);
        if (!phrase) return [];
        const hit = cache.get(phrase);
        if (hit && hit.expires > now()) return hit.list.slice(0, limit);
        let list = [];
        try {
            const res = await fetchImpl(`${url}/api/v1/session-reports`, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(2500),
            });
            if (!res.ok) throw new Error(`report ${res.status}`);
            const body = await res.json().catch(() => null);
            const reports = body && Array.isArray(body.reports) ? body.reports : [];
            list = reports.filter((r) => speaksOf(r, phrase)).map(cite);
        } catch (err) {
            log.warn(`[Rundown] agent citations for "${phrase}" unavailable: ${(err && err.message) || err}`);
            list = [];
        }
        cache.set(phrase, { at: now(), expires: now() + ttl, list });
        if (cache.size > 1000) cache.clear();
        return list.slice(0, Math.max(1, Math.min(20, Number(limit) || 6)));
    }
    return { forTopic, clear: () => cache.clear() };
}

module.exports = { createCitations, speaksOf, normalize, TTL_MS };
