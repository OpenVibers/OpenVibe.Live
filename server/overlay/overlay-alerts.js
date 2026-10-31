'use strict';
/**
 * overlay-alerts.js — the overlay alert feed: one typed message per moment a channel has something
 * to show on the streamer's OBS overlay ("X followed", "X tipped 5 Vibes: message", "X subscribed",
 * "X raided with 12 viewers", "Goal reached").
 *
 * The message is a transient frame on Chat's typed ingress (server/chat/chat-delivery.js), broadcast to the
 * channel's own room — the same room the chat overlay (public/obs/chat.html) and the streamer's OBS
 * browser source read. It is never a chat message: nothing here is persisted, and nothing here is
 * mirrored into global chat.
 *
 *   { type: 'overlay-alert', kind, id, at, who: { name, avatar }|null, amount: { value, unit }|null, text }
 *
 *   kind     follow | tip | sub | raid | goal
 *   id       unique per moment (for de-duplication on the overlay); a hash of the moment's natural key,
 *            so it says nothing about who tipped, how much, or which account it was
 *   at       when the moment happened (ISO 8601)
 *   who      the public person it happened to: a name and an avatar, or null (an anonymous tip)
 *   amount   what it was worth: a number and its unit (vibes | usd | viewers), or null
 *   text     the tipper's own words, plain text, or null
 *
 * Nothing private is in here: no email, no user id, no subject, no Billing or Network internals. The
 * natural key that identifies the moment (a transaction id, a follow revision) is hashed into the id
 * and never sent.
 *
 * The text a tipper wrote passes Chat's own moderation the way a chat line does (blocked words and the
 * channel's filters) — Chat does that when it delivers the frame, not here.
 *
 * Live has no alert settings of its own: the alert sounds are Chat's channel_moderation_settings
 * (the donation and goal sounds), and they are left exactly as they are. The overlay feed is a
 * visual feed and adds no setting.
 */
const crypto = require('crypto');
const delivery = require('../chat/chat-delivery');

const KINDS = ['follow', 'tip', 'sub', 'raid', 'goal'];
const UNITS = ['vibes', 'usd', 'viewers'];
const TEXT_MAX = 200;
const NAME_MAX = 120;
const AVATAR_MAX = 500;

/**
 * Control characters out (the line breaks and tabs stay): a message is plain text, and a stray
 * escape sequence in it is nothing a chat line or an overlay has to carry.
 */
function stripControls(value) {
    let out = '';
    for (const ch of String(value)) {
        const code = ch.codePointAt(0);
        if (code === 9 || code === 10 || code === 13) { out += ch; continue; }
        if (code < 32 || code === 127) { out += ' '; continue; }
        out += ch;
    }
    return out;
}

// The same moment always gets the same id, and the id says nothing about the moment: a hash of the
// natural key. The key itself (a transaction id, a follow revision) never leaves Live.
function momentId(kind, naturalKey) {
    const hash = crypto.createHash('sha256').update(String(naturalKey)).digest('hex').slice(0, 16);
    return `${kind}:${hash}`;
}

// A repeated moment (a retried Tips delivery, a redelivered event) must be the same message twice
// over, or the ingress would see a different body under the same key and refuse it. So the time of
// a moment is remembered per natural key.
const _times = new Map();
function momentTime(naturalKey) {
    const hit = _times.get(naturalKey);
    if (hit) return hit;
    const now = new Date().toISOString();
    if (_times.size > 1000) _times.clear();
    _times.set(naturalKey, now);
    return now;
}

/** Plain text: control characters out, trimmed, at most 200 characters. */
function cleanText(value) {
    if (value == null) return null;
    const text = stripControls(value).trim();
    if (!text) return null;
    return text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text;
}

/** An avatar is a picture, not a script: only a real image URL (or a path on this site) is passed on. */
function cleanAvatar(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return null;
    if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/')) return null;
    return raw.slice(0, AVATAR_MAX);
}

/**
 * The public person behind a moment: the name people read and the avatar they see. Nothing else.
 * A person with no name (an anonymous tip) is null.
 */
function who(name, avatar) {
    const clean = stripControls(name == null ? '' : name).replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    return { name: clean.slice(0, NAME_MAX), avatar: cleanAvatar(avatar) };
}

/** What it was worth, in the unit it was worth it in. */
function amount(value, unit) {
    if (value == null || !Number.isFinite(Number(value))) return null;
    const u = String(unit || 'vibes').toLowerCase();
    if (!UNITS.includes(u)) return null;
    return { value: Number(value), unit: u };
}

/**
 * Send one moment to a channel's room.
 *
 *   streamerId   the channel owner (the room the frame goes to: the channel's room, live or not)
 *   kind         one of KINDS
 *   who          { name, avatar } | null
 *   amount       { value, unit } | null
 *   text         the tipper's message | null
 *   naturalKey   what makes this moment unique (server-side only; it is hashed into the id)
 *
 * Returns the frame that was sent, or null when there was nothing to send.
 */
async function emit({ streamerId, kind, who: person = null, amount: worth = null, text = null, naturalKey = null }) {
    const owner = Number(streamerId);
    if (!Number.isSafeInteger(owner) || owner <= 0) return null;
    if (!KINDS.includes(kind)) return null;
    const key = String(naturalKey || `${kind}:${crypto.randomUUID()}`);
    const id = momentId(kind, key);
    const frame = {
        type: 'overlay-alert',
        kind,
        id,
        at: momentTime(key),
        who: person && typeof person === 'object' ? who(person.name, person.avatar) : null,
        amount: worth && typeof worth === 'object' ? amount(worth.value, worth.unit) : null,
        text: cleanText(text),
    };
    // The ingress key is the moment's id: the same moment delivered twice is one message.
    await delivery.event({ kind: 'channel', id: owner }, frame, { key: `overlay:${id}` });
    return frame;
}

module.exports = { KINDS, UNITS, emit, who, amount, cleanText, momentId, _reset: () => _times.clear() };
