'use strict';
/**
 * Account export and deletion → Live (roadmap WS-B task 7, ADR-033; Contracts 0.71.0).
 *
 *   network.account.export_requested  Live pushes its part of the person's export to Network
 *                                     (POST /internal/account-exports/:id/parts, network.account.export.contribute):
 *                                     the Live profile and, per table, the rows about the person (secrets, stream keys
 *                                     and tokens never). A person with no Live account sends an empty part, so the
 *                                     export does not wait for Live.
 *   network.account.deleted           Live erases the person's rows in one transaction, then confirms with counts
 *                                     (POST /internal/account-deletions/:id/confirmations, network.account.deletion.confirm).
 *
 * The tables come from the schema itself: every foreign key to users says what the person owns (ON DELETE CASCADE:
 * the row goes, and with a stream or channel go the rows inside it) and what is shared (SET NULL: the row stays
 * without them, such as their chat lines, canvas tiles and themes). A user_id column without a foreign key is owned.
 * Kept, as ADR-012 and ADR-033 say:
 *   - money and ledgers (payment orders, subscriptions, transactions, coin and channel-point logs), with the donation
 *     message cleared while Live is the ledger;
 *   - moderation records (bans, moderation actions), and staff bookkeeping.
 * The user row stays as a tombstone (username released, email, password and profile cleared, deleted_at), so the
 * kept rows point at nobody.
 *
 * Never touched: the frozen tables (vods, clips, pastes, paste_likes, paste_comments, comments), which Media and
 * Community own and erase themselves. The six chat tables (channel_moderators, channel_moderation_settings, emotes,
 * user_tags, chat_ai_summaries, chat_timeline_events) are OpenVibe.Chat's (roadmap T3) and erased by its eraser
 * (Chat server/chat/account-data.js), never here.
 *
 * Applied once per export or deletion (account_data_events); a redelivery resends only what did not reach Network.
 */
const db = require('../db/database');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const EXPORT_RE = /^exp_[0-9A-HJKMNP-TV-Z]{26}$/;
const DELETION_RE = /^del_[0-9A-HJKMNP-TV-Z]{26}$/;
const FROZEN = new Set(['vods', 'clips', 'pastes', 'paste_likes', 'paste_comments', 'comments']);
const RETAIN = new Set(['payment_orders', 'subscriptions', 'transactions', 'coin_transactions', 'channel_points_log', 'moderation_actions', 'bans',
    'token_revocations', 'verification_keys', 'subject_merges', 'account_data_events']);
// Rows the schema keeps without the person (SET NULL) that are theirs to erase all the same: their own chat lines,
// sign-in IPs and VPN requests.
const OVERRIDE_DELETE = new Set(['chat_messages.user_id', 'ip_log.user_id', 'vpn_approvals.user_id']);
// Copies of the person's name kept beside a person column: cleared wherever the row stays.
const NAME_COLS = ['username', 'display_name', 'user_name', 'sender_name', 'sender_username', 'author_name', 'author_username', 'avatar_url', 'user_avatar'];
// Person columns the schema declares without a foreign key.
const EXTRA = [['channel_points', 'streamer_id'], ['arena_mic_moments', 'target_user_id'], ['arena_topics', 'created_by'], ['arena_topics', 'target_user_id']];
const SECRET_COL = /(^|_)(token|tokens|secret|hash|password|code|key|keys|p256dh|auth|cookie|cookies|credentials)($|_)/i;
const ROW_LIMIT = 2000;
const PART_BUDGET = 18 * 1024 * 1024;
// OpenVibe.Chat owns these and erases them itself (roadmap T3); Live must not touch them.
const CHAT_TABLES = new Set(['channel_moderators', 'channel_moderation_settings', 'emotes', 'user_tags', 'chat_ai_summaries', 'chat_timeline_events']);

function ensureSchema(d) {
    d.exec(`CREATE TABLE IF NOT EXISTS account_data_events (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        subject    TEXT NOT NULL,
        outcome    TEXT,
        sent_at    DATETIME,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    const cols = d.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    if (!cols.includes('deleted_at')) d.exec('ALTER TABLE users ADD COLUMN deleted_at DATETIME');
}

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** table → [{ col, action: 'delete'|'null' }], every person column Live has, frozen tables left out. */
function personColumns(d) {
    const out = new Map();
    const add = (t, col, action) => {
        if (!out.has(t)) out.set(t, []);
        if (!out.get(t).some((c) => c.col === col)) out.get(t).push({ col, action });
    };
    const tables = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    for (const t of tables) {
        if (t === 'users' || FROZEN.has(t)) continue;
        for (const fk of d.prepare(`PRAGMA foreign_key_list(${q(t)})`).all()) {
            if (fk.table === 'users') add(t, fk.from, fk.on_delete === 'SET NULL' && !OVERRIDE_DELETE.has(`${t}.${fk.from}`) ? 'null' : 'delete');
        }
        if (d.prepare(`PRAGMA table_info(${q(t)})`).all().some((c) => c.name === 'user_id')) add(t, 'user_id', 'delete');
    }
    for (const [t, col] of EXTRA) {
        if (tables.includes(t) && d.prepare(`PRAGMA table_info(${q(t)})`).all().some((c) => c.name === col)) add(t, col, 'delete');
    }
    return out;
}

const liveUserOf = (d, subject) => {
    const r = d.prepare("SELECT user_id FROM linked_accounts WHERE service = 'network' AND subject_id = ? ORDER BY id LIMIT 1").get(subject);
    return r ? r.user_id : null;
};

// ── Export ─────────────────────────────────────────────────────

/** Live's part for one person → network.account-export-part@1 (without the subject). */
function exportPart(d, userId) {
    if (!userId) return { files: [], note: 'No Live account.' };
    const files = [];
    const truncated = [];
    let bytes = 0;
    const user = d.prepare('SELECT * FROM users WHERE id = ?').get(userId) || {};
    const profile = {};
    for (const [k, v] of Object.entries(user)) if (!SECRET_COL.test(k)) profile[k] = v;
    files.push({ name: 'profile.json', content: profile });
    bytes += JSON.stringify(profile).length;
    const other = {};
    for (const [t, cols] of personColumns(d)) {
        const keep = d.prepare(`PRAGMA table_info(${q(t)})`).all().map((c) => c.name).filter((c) => !SECRET_COL.test(c));
        if (!keep.length) continue;
        const where = cols.map((c) => `${q(c.col)} = ?`).join(' OR ');
        const rows = d.prepare(`SELECT ${keep.map(q).join(', ')} FROM ${q(t)} WHERE ${where} ORDER BY rowid DESC LIMIT ${ROW_LIMIT + 1}`).all(...cols.map(() => userId));
        if (!rows.length) continue;
        const content = rows.slice(0, ROW_LIMIT);
        const size = JSON.stringify(content).length;
        if (bytes + size > PART_BUDGET) { truncated.push(`${t}.json`); continue; }
        bytes += size;
        if (rows.length > ROW_LIMIT) truncated.push(`${t}.json`);
        // At most 64 files per part: the first 60 tables get their own, the rest share other.json.
        if (files.length < 60) files.push({ name: `${t}.json`.replace(/[^a-z0-9_.-]/g, '_'), content });
        else other[t] = content;
    }
    if (Object.keys(other).length) files.push({ name: 'other.json', content: other });
    return { files, truncated, note: 'Recordings and clips are in the media part, pastes and comments in the community part, chat history in the chat part.' };
}

// ── Deletion ───────────────────────────────────────────────────

/** Erase Live's rows of these Live users in one transaction → { erased, retained }. */
function eraseUsers(d, userIds, { now = new Date().toISOString() } = {}) {
    const erased = {};
    const retained = {};
    const bump = (o, k, n) => { if (n) o[k] = (o[k] || 0) + n; };
    const cols = personColumns(d);
    const usersCols = d.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    const onBilling = (() => { try { return require('../monetization/money-authority').onBilling(); } catch { return false; } })();
    d.transaction(() => {
        for (const uid of userIds) {
            for (const [t, list] of cols) {
                const where = list.map((c) => `${q(c.col)} = ?`).join(' OR ');
                if (RETAIN.has(t)) { bump(retained, t, d.prepare(`SELECT COUNT(*) AS n FROM ${q(t)} WHERE ${where}`).get(...list.map(() => uid)).n); continue; }
                // OpenVibe.Chat's tables: its own eraser deletes them; Live reports the rows it left for it.
                if (CHAT_TABLES.has(t)) { bump(retained, 'left_for_chat', d.prepare(`SELECT COUNT(*) AS n FROM ${q(t)} WHERE ${where}`).get(...list.map(() => uid)).n); continue; }
                for (const c of list) {
                    if (c.action === 'null') {
                        const info = d.prepare(`PRAGMA table_info(${q(t)})`).all().filter((x) => NAME_COLS.includes(x.name));
                        if (info.length) d.prepare(`UPDATE ${q(t)} SET ${info.map((x) => `${q(x.name)} = ${x.notnull ? "'deleted'" : 'NULL'}`).join(', ')} WHERE ${q(c.col)} = ?`).run(uid);
                    }
                    const r = c.action === 'null'
                        ? d.prepare(`UPDATE ${q(t)} SET ${q(c.col)} = NULL WHERE ${q(c.col)} = ?`).run(uid)
                        : d.prepare(`DELETE FROM ${q(t)} WHERE ${q(c.col)} = ?`).run(uid);
                    bump(erased, t, r.changes);
                }
            }
            // A donation's message is the person's words: cleared while Live keeps the ledger (read-only under Billing).
            if (!onBilling && cols.has('transactions')) {
                d.prepare('UPDATE transactions SET message = NULL WHERE from_user_id = ? AND message IS NOT NULL').run(uid);
            }
            // The tombstone: the kept rows point at nobody; the username is free again.
            const set = { username: `deleted-${uid}`, email: null, password_hash: '!deleted', display_name: null, avatar_url: null, bio: null, stream_key: null,
                profile_color: null, theme_id: null, avatar_paste_id: null, ban_reason: null, deleted_at: now };
            const keys = Object.keys(set).filter((k) => usersCols.includes(k));
            d.prepare(`UPDATE users SET ${keys.map((k) => `${q(k)} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), uid);
            bump(erased, 'accounts', 1);
        }
    })();
    return { erased, retained };
}

// ── Events ─────────────────────────────────────────────────────

async function networkCall(path, body) {
    const principal = require('../net/network-principal');
    const base = (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    for (let attempt = 0; attempt < 2; attempt++) {
        const headers = await principal.serviceHeaders('openvibe.network');
        const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
        if (res.status === 401 && attempt === 0) { principal.invalidate('openvibe.network'); continue; }
        return res;
    }
    return null;
}

/**
 * Apply one envelope → 'exported' | 'erased' | 'confirmed' | 'closed' | 'ignored:<why>'. Throws when Network could not
 * be reached (the delivery is answered 500 and redelivered). send(path, body) → Response (tests inject it).
 */
async function apply(ev, { send = networkCall } = {}) {
    const p = ev && ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    const d = db.getDb();
    ensureSchema(d);
    if (ev.event_type === 'network.account.export_requested') {
        if (!EXPORT_RE.test(String(p.export_id || '')) || !SUBJECT_RE.test(String(p.subject || ''))) return 'ignored:payload';
        const seen = d.prepare('SELECT sent_at FROM account_data_events WHERE id = ?').get(p.export_id);
        if (seen && seen.sent_at) return 'unchanged';
        const part = exportPart(d, liveUserOf(d, p.subject));
        const res = await send(`/internal/account-exports/${p.export_id}/parts`, { subject: p.subject, ...part });
        if (!res) throw new Error('Network unreachable');
        const outcome = res.ok ? 'exported' : (res.status === 409 || res.status === 404 ? 'closed' : null);
        if (!outcome) throw new Error(`export part refused: ${res.status}`);
        d.prepare('INSERT OR REPLACE INTO account_data_events (id, kind, subject, outcome, sent_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)')
            .run(p.export_id, 'export', p.subject, JSON.stringify({ result: outcome, files: part.files.length }));
        console.log(`[AccountData] export ${p.export_id}: ${outcome} (${part.files.length} file(s))`);
        return outcome;
    }
    if (ev.event_type === 'network.account.deleted') {
        if (!DELETION_RE.test(String(p.deletion_id || '')) || !SUBJECT_RE.test(String(p.subject || ''))) return 'ignored:payload';
        const subjects = [p.subject, ...(Array.isArray(p.aliases) ? p.aliases.filter((s) => SUBJECT_RE.test(String(s))) : [])];
        let rec = d.prepare('SELECT * FROM account_data_events WHERE id = ?').get(p.deletion_id);
        let result = 'confirmed';
        if (!rec) {
            const ids = [...new Set(subjects.map((s) => liveUserOf(d, s)).filter(Boolean))];
            for (const id of [...ids]) for (const m of (hasColumn(d, 'users', 'merged_into') ? d.prepare('SELECT id FROM users WHERE merged_into = ?').all(id) : [])) if (!ids.includes(m.id)) ids.push(m.id);
            const counts = eraseUsers(d, ids);
            if (d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subject_projection'").get()) {
                d.prepare(`DELETE FROM subject_projection WHERE subject_id IN (${subjects.map(() => '?').join(',')})`).run(...subjects);
            }
            d.prepare('INSERT INTO account_data_events (id, kind, subject, outcome) VALUES (?, ?, ?, ?)').run(p.deletion_id, 'deletion', p.subject, JSON.stringify({ users: ids, ...counts }));
            rec = d.prepare('SELECT * FROM account_data_events WHERE id = ?').get(p.deletion_id);
            result = 'erased';
            console.log(`[AccountData] deletion ${p.deletion_id}: ${JSON.stringify({ users: ids, ...counts })}`);
        }
        if (rec.sent_at) return 'unchanged';
        const o = JSON.parse(rec.outcome || '{}');
        const res = await send(`/internal/account-deletions/${p.deletion_id}/confirmations`, { subject: p.subject, completed_at: new Date(`${String(rec.applied_at).replace(' ', 'T')}Z`).toISOString(), erased: o.erased || {}, retained: o.retained || {} });
        if (!res) throw new Error('Network unreachable');
        if (!res.ok && res.status !== 404) throw new Error(`confirmation refused: ${res.status}`);
        d.prepare('UPDATE account_data_events SET sent_at = CURRENT_TIMESTAMP WHERE id = ?').run(p.deletion_id);
        return result;
    }
    return 'ignored:type';
}

function hasColumn(d, table, col) { return d.prepare(`PRAGMA table_info(${q(table)})`).all().some((c) => c.name === col); }

module.exports = { apply, exportPart, eraseUsers, personColumns, ensureSchema, FROZEN, RETAIN };
