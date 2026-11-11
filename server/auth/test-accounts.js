'use strict';
/**
 * Test accounts on Live (OpenVibe.Network users.is_test).
 *
 * The probes sign in as real accounts, and Live's public people surfaces must never show them: Recently Online
 * (the directory), the home digest's new-members faces and counts, and the hero's people counts. The identity
 * authority lists its test accounts at GET /internal/identity/test-subjects (identity.subject.resolve); this module
 * writes them into subject_projection with is_test = 1 and follows linked_accounts to the local users row, so the
 * public queries filter `users.is_test` in SQL and never call Network while a page is read.
 *
 * A refresh replaces the whole flag set in one transaction: a subject the Network unmarks becomes ordinary again,
 * and a failed refresh (Network down, no client secret) changes nothing, so the last good list keeps test accounts
 * hidden. The account's own signed-in views are untouched: they read their own rows, not the public lists.
 */
const db = require('../db/database');
const principal = require('../net/network-principal');
const { OV_NETWORK_INTERNAL_URL } = require('../utils/notify');

const REFRESH_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
let timer = null;
let last = { at: null, count: 0, error: null };

/** One full sync. Throws with a short, safe reason; never logs a token. */
async function refresh({ fetchImpl = globalThis.fetch } = {}) {
    const headers = await principal.headersFor('/internal/identity/test-subjects');
    const res = await fetchImpl(`${OV_NETWORK_INTERNAL_URL}/internal/identity/test-subjects`, {
        headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) principal.tokenRejected('401');
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !Array.isArray(body.subjects)) {
        throw new Error(`Network ${res.status}${body && (body.code || body.error) ? `: ${body.code || body.error}` : ''}`);
    }
    const rows = body.subjects.filter((p) => p && p.subject && SUBJECT_RE.test(String(p.subject.id)))
        .map((p) => ({ subject: p.subject.id, network_user_id: Number.isInteger(p.network_user_id) ? p.network_user_id : null,
            username: typeof p.username === 'string' ? p.username.slice(0, 64) : null }));
    const d = db.getDb();
    await d.tx(async () => {
        await d.prepare('UPDATE users SET is_test = 0 WHERE is_test <> 0').run();
        await d.prepare('UPDATE subject_projection SET is_test = 0 WHERE is_test <> 0').run();
        for (const r of rows) {
            // A projection the events may not have sent yet: the row is enough for the link, revision 0 never beats an event.
            await d.prepare(`INSERT INTO subject_projection (subject_id, network_user_id, revision, username, role, is_test)
                VALUES (?, ?, 0, ?, 'user', 1)
                ON CONFLICT (subject_id) DO UPDATE SET is_test = 1,
                    network_user_id = COALESCE(excluded.network_user_id, subject_projection.network_user_id)`)
                .run(r.subject, r.network_user_id, r.username);
            if (r.username) await d.prepare('UPDATE users SET is_test = 1 WHERE lower(username) = lower(?)').run(r.username);
        }
        // The subject link is the authority when a local name and the Network's current name differ (a rename).
        await d.prepare(`UPDATE users SET is_test = 1 WHERE id IN (
            SELECT la.user_id FROM linked_accounts la JOIN subject_projection sp ON sp.subject_id = la.subject_id
            WHERE sp.is_test = 1)`).run();
    });
    last = { at: new Date().toISOString(), count: rows.length, error: null };
    if (rows.length) console.log(`[Test accounts] ${rows.length} marked (users.is_test)`);
    return rows.length;
}

/** Refresh now (unless the caller already awaited one), then hourly; a failure leaves the last good flags. */
function start({ refreshNow = true } = {}) {
    if (timer) return timer;
    if (refreshNow) refresh().catch((err) => { last.error = err.message; console.warn('[Test accounts] refresh failed:', err.message); });
    timer = setInterval(() => {
        refresh().catch((err) => { last.error = err.message; console.warn('[Test accounts] refresh failed:', err.message); });
    }, REFRESH_MS);
    if (timer.unref) timer.unref();
    return timer;
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { refresh, start, stop, status: () => ({ ...last }), REFRESH_MS };
