'use strict';
const identity = require('../auth/identity-sync');
const hits = new Map();
const TTL = 30000;
/** The same public 100-subject read every site uses; missing/down is omitted, never a guessed level. */
async function batchForUsers(ids, { fetchImpl = globalThis.fetch, subjectOf = identity.subjectOf, now = Date.now } = {}) {
    const unique = [...new Set(ids.map(Number).filter(Number.isSafeInteger))];
    const pairs = await Promise.all(unique.map(async id => [id, await subjectOf(id).catch(() => null)]));
    const missing = [...new Set(pairs.map(([, s]) => s).filter(s => s && (!hits.has(s) || now() - hits.get(s).at >= TTL)))];
    for (let i = 0; i < missing.length; i += 100) {
        const subjects = missing.slice(i, i + 100);
        try {
            const base = process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000';
            const res = await fetchImpl(`${base}/api/v1/levels/batch?subjects=${encodeURIComponent(subjects.join(','))}`, { signal: AbortSignal.timeout(1500) });
            if (!res.ok) continue;
            const data = await res.json();
            for (const s of subjects) { const level = data.levels?.[s]; if (Number.isInteger(level) && level > 0) hits.set(s, { level, at: now() }); else hits.delete(s); }
        } catch { /* chat cards still work during a Network outage */ }
    }
    if (hits.size > 10000) for (const [s, h] of hits) if (now() - h.at >= TTL) hits.delete(s);
    return Object.fromEntries(pairs.filter(([, s]) => hits.has(s) && now() - hits.get(s).at < TTL).map(([id, s]) => [id, hits.get(s).level]));
}
module.exports = { batchForUsers };
