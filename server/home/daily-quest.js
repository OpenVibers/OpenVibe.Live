'use strict';

// What OpenVibe.Quest holds beyond today's quest, for the card's door to it: the catalog's size (public, the same for
// everyone, kept ten minutes) and, for a signed-in person, their badges and the quests they have started.
const CATALOG_TTL_MS = 10 * 60 * 1000;
let _catalog = null;   // { at, base, value: { quests, sites } }

/** Quest calls carry only a Network bearer token. The browser never sends Quest a Live cookie. */
async function readDailyQuest({ token = null, timeZone = 'UTC', more = false, fetchImpl = globalThis.fetch,
    baseUrl = process.env.OV_QUEST_INTERNAL_URL || 'https://openvibe.quest', now = Date.now } = {}) {
    const base = String(baseUrl).replace(/\/+$/, '');
    const headers = { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const get = async (path, options = {}) => {
        const res = await fetchImpl(base + path, { ...options, headers: { ...headers, ...(options.headers || {}) },
            signal: AbortSignal.timeout(4500) });
        if (!res.ok) return null;
        return res.json();
    };
    const soft = (p) => p.catch(() => null);   // the door's figures never cost the card itself
    const catalog = async () => {
        if (_catalog && _catalog.base === base && now() - _catalog.at < CATALOG_TTL_MS) return _catalog.value;
        const all = await soft(get('/api/v1/quests'));
        if (!all || !Array.isArray(all.quests)) return null;
        const value = { quests: all.quests.length, sites: Array.isArray(all.sites) ? all.sites.length : 0 };
        _catalog = { at: now(), base, value };
        return value;
    };
    const mine = async () => {
        const me = token ? await soft(get('/api/v1/me/quests')) : null;
        if (!me || !Array.isArray(me.quests)) return null;
        return {
            badges: Array.isArray(me.badges) ? me.badges.length : 0,
            in_progress: me.quests.filter((q) => q && q.state === 'in_progress').length,
            completed: me.quests.filter((q) => q && q.state === 'completed').length,
        };
    };
    const withMore = async (result) => {
        if (!more) return result;
        const [cat, me] = await Promise.all([catalog(), mine()]);
        return { ...result, more: { ...(cat || {}), ...(me ? { mine: me } : {}) } };
    };
    try {
        if (!token) {
            const [quest, extra] = await Promise.all([get('/api/v1/daily'), withMore({})]);
            return quest && { signed_in: false, quest, ...extra };
        }
        if (timeZone && /^[A-Za-z0-9_+\/-]{1,64}$/.test(timeZone)) {
            await get('/api/v1/me/daily/time-zone', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ time_zone: timeZone }) });
        }
        const [quest, extra] = await Promise.all([get('/api/v1/me/daily'), withMore({})]);
        if (!quest) return null;
        return { signed_in: true, quest, ...extra };
    } catch { return null; }
}
module.exports = { readDailyQuest, _resetForTests: () => { _catalog = null; } };
