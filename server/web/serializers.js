'use strict';
/**
 * Outward-facing shapes for rows that carry secrets.
 *
 * Most getters in server/db/database.js are `SELECT *`, and route handlers used to strip secret
 * columns by hand with `delete row.stream_key`. That works until one handler forgets: the public
 * channel endpoint returned every slot's ingest key (managed_streams[].stream_key) because the
 * handler deleted the key from `streams` and `channel` but not from `managed_streams`, which let
 * anyone publish to any streamer's slot.
 *
 * These functions copy a row and drop anything secret, so a new column is private until someone
 * decides otherwise. They never mutate their input — the same row object is often reused for the
 * owner's view of the same response.
 */

// Columns that must never leave a privileged boundary, wherever they appear.
const ALWAYS_SECRET = [
    'stream_key', 'managed_stream_key', 'password_hash', 'token', 'access_token', 'refresh_token',
    'api_token', 'byo_key', 'token_valid_after', 'key_hash', 'secret', 'webhook_secret',
];

function omit(row, keys) {
    if (!row || typeof row !== 'object') return row;
    const out = { ...row };
    for (const k of keys) delete out[k];
    return out;
}

/** A streaming slot as anyone may see it on a channel page. */
function publicManagedStream(ms) {
    return omit(ms, [
        ...ALWAYS_SECRET,
        // The streamer's home ZIP (weather widget) and the desk/PiP configuration are the owner's.
        'weather_zip', 'broadcast_settings', 'pip_defaults', 'pip_source_msid',
    ]);
}

/** A channel row as anyone may see it. `weather_enabled` replaces the ZIP it is derived from. */
function publicChannel(ch) {
    if (!ch || typeof ch !== 'object') return ch;
    const out = omit(ch, [...ALWAYS_SECRET, 'weather_zip', 'vod_recording_enabled', 'force_vod_recording_disabled']);
    if (!('weather_enabled' in out)) out.weather_enabled = !!(ch.weather_zip && ch.weather_detail && ch.weather_detail !== 'off');
    return out;
}

/** A stream/session row (streams.* joined with its slot) as anyone may see it. */
function publicStream(s) {
    if (!s || typeof s !== 'object') return s;
    const out = omit(s, ALWAYS_SECRET);
    if (out.channel) out.channel = publicChannel(out.channel);
    return out;
}

/** Profile fields for anyone other than the user themselves: no balances, email or presence. */
function publicUserProfile(u) {
    return omit(u, [...ALWAYS_SECRET, 'email', 'openvibe_bucks_balance', 'openvibe_bucks_cashout_balance',
        'openvibe_coins_balance', 'last_seen', 'is_owner']);
}

// ── Feed items (server/content/feed.js) ───────────────────────────────────────────────────────
// Built from Media, Community and Live rows that carry far more than a card needs (file paths,
// storage keys, owner subjects, AI state). Copied through an allow-list, so a field a source adds
// later never reaches the public feed by accident.
const FEED_ITEM_FIELDS = {
    kind: 'string', id: 'id', href: 'string', title: 'string', created_at: 'string',
    views: 'number', likes: 'number', duration_seconds: 'number',
    thumbnail_url: 'string', preview_url: 'string', image_url: 'string',
    excerpt: 'string', paste_type: 'string', language: 'string', nsfw: 'boolean',
    ai: 'boolean', ai_label: 'string', moment_href: 'string', grade: 'string', stream_title: 'string',
};
const FEED_PERSON_FIELDS = ['username', 'display_name', 'avatar_url', 'profile_color', 'href'];

function _feedPerson(p) {
    if (!p || typeof p !== 'object' || !p.username) return null;
    const out = {};
    for (const k of FEED_PERSON_FIELDS) out[k] = p[k] == null ? null : String(p[k]);
    return out;
}

/** One card of the Content or Moments feed as anyone may see it. */
function publicFeedItem(item) {
    if (!item || typeof item !== 'object') return null;
    const out = { key: `${item.kind}:${item.id}` };
    for (const [k, type] of Object.entries(FEED_ITEM_FIELDS)) {
        const v = item[k];
        if (v === undefined) continue;
        if (v === null) { out[k] = null; continue; }
        if (type === 'id') out[k] = typeof v === 'number' ? v : String(v);
        else if (type === 'number') out[k] = Number.isFinite(Number(v)) ? Number(v) : 0;
        else if (type === 'boolean') out[k] = !!v;
        else out[k] = String(v);
    }
    out.channel = _feedPerson(item.channel);
    if (item.by !== undefined) out.by = _feedPerson(item.by);
    return out;
}

/**
 * Defence in depth for JSON that is about to be sent to an unprivileged caller: walks the value and
 * reports any ALWAYS_SECRET key with a non-empty value. Used by tests over real route responses.
 */
function findSecrets(value, path = '$', out = []) {
    if (Array.isArray(value)) value.forEach((v, i) => findSecrets(v, `${path}[${i}]`, out));
    else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            if (ALWAYS_SECRET.includes(k) && v != null && v !== '') out.push(`${path}.${k}`);
            else findSecrets(v, `${path}.${k}`, out);
        }
    }
    return out;
}

module.exports = { ALWAYS_SECRET, omit, publicManagedStream, publicChannel, publicStream, publicUserProfile, publicFeedItem, findSecrets };
