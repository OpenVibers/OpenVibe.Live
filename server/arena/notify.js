/**
 * notify.js — Arena events → the site notification bell (openvibe.network store, via utils/notify).
 * Fire-and-forget, deduped per (user, type, key) for 10 min so clock ticks never spam.
 */
'use strict';

const { pushNotification } = require('../utils/notify');
let base = 'https://openvibe.live'; try { base = String(require('../config').baseUrl || base).replace(/\/$/, ''); } catch { /* */ }
const _recent = new Map();
function arenaNotify(userId, { type, title, message, icon = '🥊', url = '/arena', key = null, senderId = null, senderName = null }) {
    if (!userId) return;
    const k = `${userId}:${type}:${key || url}`;
    const now = Date.now();
    if (now - (_recent.get(k) || 0) < 10 * 60 * 1000) return;
    _recent.set(k, now);
    if (_recent.size > 5000) for (const [kk, t] of _recent) if (now - t > 10 * 60 * 1000) _recent.delete(kk);
    try { pushNotification({ user_id: userId, type: `ARENA_${String(type).toUpperCase()}`, title: String(title).slice(0, 120), message: String(message || '').slice(0, 240), icon, url: url.startsWith('http') ? url : `${base}${url}`, sender_id: senderId || undefined, sender_name: senderName || undefined }); } catch { /* */ }
}
module.exports = { arenaNotify };
