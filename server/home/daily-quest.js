'use strict';

/** Quest calls carry only a Network bearer token. The browser never sends Quest a Live cookie. */
async function readDailyQuest({ token = null, timeZone = 'UTC', fetchImpl = globalThis.fetch,
    baseUrl = process.env.OV_QUEST_INTERNAL_URL || 'https://openvibe.quest' } = {}) {
    const base = String(baseUrl).replace(/\/+$/, '');
    const headers = { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const get = async (path, options = {}) => {
        const res = await fetchImpl(base + path, { ...options, headers: { ...headers, ...(options.headers || {}) },
            signal: AbortSignal.timeout(4500) });
        if (!res.ok) return null;
        return res.json();
    };
    try {
        if (!token) {
            const quest = await get('/api/v1/daily');
            return quest && { signed_in: false, quest };
        }
        if (timeZone && /^[A-Za-z0-9_+\/-]{1,64}$/.test(timeZone)) {
            await get('/api/v1/me/daily/time-zone', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ time_zone: timeZone }) });
        }
        const quest = await get('/api/v1/me/daily');
        if (!quest) return null;
        return { signed_in: true, quest };
    } catch { return null; }
}
module.exports = { readDailyQuest };
