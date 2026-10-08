'use strict';
/**
 * network.subject.merged → Live (roadmap WS-B task 5, ADR-029; Contracts 0.69.0). Two Network accounts became one:
 * `from` is now an alias of `into`. Live has at most one user linked to each (linked_accounts, service 'network'):
 *
 *   neither, or only the survivor's   nothing of Live's to move
 *   only the folded-in account's      that Live user becomes the survivor's: its network link names `into` (and the
 *                                     survivor's Network user id, resolved from Network)
 *   both                              in one transaction, the folded-in user's follows (as follower and as the followed
 *                                     channel), channel points (as viewer and as the channel; balances of the same pair
 *                                     are summed, each move logged in channel_points_log once) and streams move to the
 *                                     survivor's user. A follow the survivor already has, or following oneself, is
 *                                     dropped and counted. The folded-in Live user stays, marked merged_into.
 *
 * Live's follows are a projection of Network's graph (ADR-030), which Network already merged; this keeps the
 * projection in step without waiting for a rebuild. VODs and clips are Media's (it follows the same event), chat is
 * Chat's. Applied once per merge_id (subject_merges).
 */
const db = require('../db/database');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const MERGE_RE = /^mrg_[0-9A-HJKMNP-TV-Z]{26}$/;

function ensureSchema(d) {
    d.exec(`CREATE TABLE IF NOT EXISTS subject_merges (
        merge_id     TEXT PRIMARY KEY,
        from_subject TEXT NOT NULL,
        into_subject TEXT NOT NULL,
        from_user_id INTEGER,
        into_user_id INTEGER,
        outcome      TEXT NOT NULL,
        applied_at   DATETIME DEFAULT ov_now()
    )`);
    const cols = d.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    if (!cols.includes('merged_into')) d.exec('ALTER TABLE users ADD COLUMN merged_into INTEGER');
}

const liveUserOf = (d, subject) => {
    const r = d.prepare("SELECT user_id FROM linked_accounts WHERE service = 'network' AND subject_id = ? ORDER BY id LIMIT 1").get(subject);
    return r ? r.user_id : null;
};

/** Move everything of Live user `a` to Live user `b` (one transaction). → counts. */
function moveUser(d, a, b, mergeId) {
    const out = { follows: 0, followers: 0, follows_dropped: 0, points: 0, points_summed: 0, streams: 0 };
    // Follows: as the follower, then as the followed channel.
    for (const [col, other, key] of [['follower_id', 'streamer_id', 'follows'], ['streamer_id', 'follower_id', 'followers']]) {
        for (const f of d.prepare(`SELECT id, ${other} AS o FROM follows WHERE ${col} = ?`).all(a)) {
            const clash = f.o === b || d.prepare(`SELECT 1 FROM follows WHERE ${col} = ? AND ${other} = ?`).get(b, f.o);
            if (clash) { d.prepare('DELETE FROM follows WHERE id = ?').run(f.id); out.follows_dropped++; }
            else { d.prepare(`UPDATE follows SET ${col} = ? WHERE id = ?`).run(b, f.id); out[key]++; }
        }
    }
    // Channel points (loyalty, ADR-012): first as the viewer, then as the channel; the same pair twice is summed.
    const logMove = d.prepare('INSERT INTO channel_points_log (idempotency_key, user_id, streamer_id, delta, reason) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');
    const add = (u, s, bal) => {
        const have = d.prepare('SELECT 1 FROM channel_points WHERE user_id = ? AND streamer_id = ?').get(u, s);
        if (have) { d.prepare('UPDATE channel_points SET balance = balance + ?, updated_at = ov_now() WHERE user_id = ? AND streamer_id = ?').run(bal, u, s); out.points_summed++; }
        else d.prepare('INSERT INTO channel_points (user_id, streamer_id, balance) VALUES (?, ?, ?)').run(u, s, bal);
    };
    const move = (fromU, fromS, toU, toS, bal, key) => {
        d.prepare('DELETE FROM channel_points WHERE user_id = ? AND streamer_id = ?').run(fromU, fromS);
        add(toU, toS, bal);
        if (bal) {
            logMove.run(`live:cp:merge:${mergeId}:${key}:out`, fromU, fromS, -bal, 'account_merge');
            logMove.run(`live:cp:merge:${mergeId}:${key}:in`, toU, toS, bal, 'account_merge');
        }
        out.points++;
    };
    for (const p of d.prepare('SELECT streamer_id AS s, balance FROM channel_points WHERE user_id = ?').all(a)) move(a, p.s, b, p.s === a ? b : p.s, p.balance, `v:${p.s}`);
    for (const p of d.prepare('SELECT user_id AS u, balance FROM channel_points WHERE streamer_id = ?').all(a)) move(p.u, a, p.u, b, p.balance, `c:${p.u}`);
    out.streams = d.prepare('UPDATE streams SET user_id = ? WHERE user_id = ?').run(b, a).changes;
    d.prepare('UPDATE users SET merged_into = ? WHERE id = ?').run(b, a);
    return out;
}

/**
 * Apply one network.subject.merged envelope → 'merged' | 'relinked' | 'nothing' | 'unchanged' | 'ignored:<why>'.
 * resolveNetworkId(subject) → the survivor's Network user id (injected by tests; defaults to Network's resolve-batch).
 */
async function apply(ev, { resolveNetworkId = defaultResolve } = {}) {
    const p = ev && ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    if (!MERGE_RE.test(String(p.merge_id || '')) || !SUBJECT_RE.test(String(p.from || '')) || !SUBJECT_RE.test(String(p.into || '')) || p.from === p.into) return 'ignored:payload';
    const d = db.getDb();
    ensureSchema(d);
    if (d.prepare('SELECT 1 FROM subject_merges WHERE merge_id = ?').get(p.merge_id)) return 'unchanged';
    const a = liveUserOf(d, p.from);
    const b = liveUserOf(d, p.into);
    let result; let outcome;
    if (!a) { result = 'nothing'; outcome = { reason: 'no Live user for the folded-in account' }; }
    else if (!b) {
        const networkId = await resolveNetworkId(p.into);
        try {
            d.prepare("UPDATE linked_accounts SET subject_id = ?, service_user_id = COALESCE(?, service_user_id) WHERE service = 'network' AND user_id = ?")
                .run(p.into, networkId == null ? null : String(networkId), a);
            result = 'relinked'; outcome = { user: a, network_user_id: networkId == null ? null : Number(networkId) };
        } catch (e) {
            // Another Live user already carries the survivor's Network id without its subject: left for staff, logged.
            result = 'conflict'; outcome = { user: a, error: String(e.message).slice(0, 200) };
        }
    } else if (a === b) { result = 'nothing'; outcome = { reason: 'one Live user for both' }; }
    else {
        outcome = d.tx(() => moveUser(d, a, b, p.merge_id));
        result = 'merged';
    }
    d.prepare('INSERT INTO subject_merges (merge_id, from_subject, into_subject, from_user_id, into_user_id, outcome) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .run(p.merge_id, p.from, p.into, a, b, JSON.stringify({ result, ...outcome }));
    console.log(`[Merge] ${p.merge_id}: ${result} ${JSON.stringify(outcome)}`);
    return result;
}

async function defaultResolve(subject) {
    try {
        const { networkPost } = require('./identity-sync');
        const r = await networkPost('/internal/identity/resolve-batch', { subject_ids: [subject] });
        const hit = r && r.results && r.results[subject];
        return hit && hit.network_user_id != null ? hit.network_user_id : null;
    } catch { return null; }
}

module.exports = { apply, ensureSchema, moveUser };
