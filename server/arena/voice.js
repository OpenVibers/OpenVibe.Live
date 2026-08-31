/**
 * voice.js — "hear it in their voice": Arena lines (taunts, quotes, headlines, ringside calls) read
 * out in the streamer's own OpenVibe chat TTS voice — the cosmetic voice they equipped, else the
 * per-identity auto voice chat already gives them (same `user:<username>` key as chat-server).
 *
 * Every (voice, text) pair is synthesized ONCE and kept on disk (`data/tts-cache/<hash>.<ext>`),
 * served with a week-long HTTP cache — repeat clicks cost nothing, and a changed voice simply
 * hashes to a new file. Cloud engines are metered into ai_usage (kind 'tts'); a daily cap and a
 * per-IP limit keep the endpoint from becoming a free TTS API.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');

const CACHE_DIR = path.resolve(process.env.TTS_CACHE_PATH || './data/tts-cache');
const MAX_TEXT = 240;
const MAX_CACHE_MB = 300;
const MAX_AGE_MS = 60 * 24 * 3600_000;
const DAILY_MAX = () => Number(db.getSetting('arena_voice_daily_max') || 2000);
const ANNOUNCER_VOICE = () => String(db.getSetting('arena_announcer_voice') || db.getSetting('tts_default_voice') || 'gary');
const CLOUD_COST_PER_CHAR = { google: 16 / 1_000_000, polly: 16 / 1_000_000 };

let _tts = null;
function tts() { if (!_tts) _tts = require('../chat/tts-engine'); return _tts; }
let _synthOverride = null;   // tests

function ensureDir() { try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* */ } }
function cleanText(text) { return String(text || '').replace(/\s+/g, ' ').replace(/[<>]/g, '').trim().slice(0, MAX_TEXT); }

/** How this person sounds in chat: equipped cosmetic voice, else the derived auto voice. */
function voiceFor(user) {
    if (!user) return { kind: 'announcer', voiceId: ANNOUNCER_VOICE(), sig: `announcer:${ANNOUNCER_VOICE()}` };
    try {
        const cosmetics = require('../monetization/cosmetics');
        const prof = cosmetics.getCosmeticProfile(user.id);
        const itemId = prof && prof.voiceFX && prof.voiceFX.itemId;
        if (itemId && tts().VOICE_CATALOG && tts().VOICE_CATALOG[itemId]) return { kind: 'equipped', voiceId: itemId, sig: `equipped:${itemId}` };
    } catch { /* cosmetics optional */ }
    const key = `user:${String(user.username).toLowerCase()}`;
    let params = null;
    try { params = tts().deriveUserVoiceParams ? tts().deriveUserVoiceParams(key) : null; } catch { /* */ }
    return { kind: 'auto', identityKey: key, params, sig: `auto:${key}:${params ? [params.voice, params.pitch, params.speed, params.gap].join('/') : 'default'}` };
}

function cacheKey(sig, text) { return crypto.createHash('sha256').update(`${sig}\n${text}`).digest('hex').slice(0, 32); }
function cachedFile(key) {
    for (const ext of ['mp3', 'wav']) { const p = path.join(CACHE_DIR, `${key}.${ext}`); if (fs.existsSync(p)) return { path: p, mimeType: ext === 'mp3' ? 'audio/mpeg' : 'audio/wav' }; }
    return null;
}

function todayCount() { try { return db.get(`SELECT COUNT(*) AS n FROM ai_usage WHERE kind = 'tts' AND created_at >= date('now')`)?.n || 0; } catch { return 0; } }

async function synth(voice, text, username) {
    if (_synthOverride) return _synthOverride(voice, text, username);
    const T = tts();
    if (voice.kind === 'auto' && T.synthesizeUserVoice) return T.synthesizeUserVoice(text, voice.identityKey, username, MAX_TEXT);
    return T.synthesize(text, voice.voiceId, username || 'Arena', MAX_TEXT);
}

/**
 * Speak `text` as `user` (a users row) or the announcer (null). Returns { path, mimeType, cached, voice }.
 * Throws with a friendly message on limits.
 */
async function speak({ user = null, text }) {
    ensureDir();
    const clean = cleanText(text);
    if (clean.length < 2) throw new Error('Nothing to say');
    const voice = voiceFor(user);
    const key = cacheKey(voice.sig, clean);
    const hit = cachedFile(key);
    if (hit) { try { fs.utimesSync(hit.path, new Date(), new Date()); } catch { /* */ } return { ...hit, cached: true, voice: voice.sig }; }
    if (todayCount() >= DAILY_MAX()) throw new Error('The announcer is hoarse — daily voice budget reached, try tomorrow');
    const started = Date.now();
    const out = await synth(voice, clean, user?.username);
    if (!out || !out.audio) throw new Error('Voice engine unavailable');
    const ext = /wav/i.test(out.mimeType || '') ? 'wav' : 'mp3';
    const file = path.join(CACHE_DIR, `${key}.${ext}`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(out.audio, 'base64'));
    fs.renameSync(tmp, file);
    const engine = String(out.engine || '').toLowerCase();
    const cloud = /google/.test(engine) ? 'google' : /polly|aws|amazon/.test(engine) ? 'polly' : null;
    try { db.recordAiUsage({ kind: 'tts', model: `${engine || 'espeak'}:${out.voiceId || voice.voiceId || 'auto'}`, input_tokens: clean.length, output_tokens: 0, cost_usd: cloud ? clean.length * CLOUD_COST_PER_CHAR[cloud] : 0, owner_user_id: user?.id || null, source: 'arena', role: 'tts', provider: engine || 'espeak', latency_ms: Date.now() - started }); } catch { /* */ }
    purge();
    return { path: file, mimeType: ext === 'wav' ? 'audio/wav' : 'audio/mpeg', cached: false, voice: voice.sig, engine };
}

let _lastPurge = 0;
function purge() {
    if (Date.now() - _lastPurge < 10 * 60 * 1000) return;
    _lastPurge = Date.now();
    try {
        const files = fs.readdirSync(CACHE_DIR).filter(f => /\.(mp3|wav)$/.test(f)).map(f => { const p = path.join(CACHE_DIR, f); const st = fs.statSync(p); return { p, size: st.size, at: st.mtimeMs }; });
        const now = Date.now();
        let total = 0;
        for (const f of files) { if (now - f.at > MAX_AGE_MS) { try { fs.unlinkSync(f.p); } catch { /* */ } } else total += f.size; }
        if (total > MAX_CACHE_MB * 1024 * 1024) {
            for (const f of files.filter(x => now - x.at <= MAX_AGE_MS).sort((a, b) => a.at - b.at)) { if (total <= MAX_CACHE_MB * 1024 * 1024 * 0.8) break; try { fs.unlinkSync(f.p); total -= f.size; } catch { /* */ } }
        }
    } catch { /* */ }
}

// Per-IP limiter: anonymous 8/min, signed-in 30/min (cache hits are still counted so a scraper can't loop).
const _hits = new Map();
function allow(ip, signedIn) {
    const now = Date.now();
    const lim = signedIn ? 30 : 8;
    const arr = (_hits.get(ip) || []).filter(t => now - t < 60_000);
    if (arr.length >= lim) { _hits.set(ip, arr); return false; }
    arr.push(now); _hits.set(ip, arr);
    if (_hits.size > 5000) { for (const [k, v] of _hits) if (!v.length || now - v[v.length - 1] > 60_000) _hits.delete(k); }
    return true;
}

/** Park a one-off synthesized clip (admin test / mod preview) in the cache → safe same-origin filename. */
function stash(audioBase64, mimeType) {
    ensureDir();
    const buf = Buffer.from(String(audioBase64 || ''), 'base64');
    if (!buf.length) return null;
    const ext = /wav/i.test(mimeType || '') ? 'wav' : 'mp3';
    const file = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${ext}`;
    const full = path.join(CACHE_DIR, file);
    if (!fs.existsSync(full)) { fs.writeFileSync(`${full}.tmp`, buf); fs.renameSync(`${full}.tmp`, full); purge(); }
    return { file, mimeType: ext === 'wav' ? 'audio/wav' : 'audio/mpeg' };
}
/** Resolve a cache filename (strict shape, no traversal) → { path, mimeType } or null. */
function cachedByName(file) {
    if (!/^[a-f0-9]{32}\.(mp3|wav)$/.test(String(file || ''))) return null;
    const full = path.join(CACHE_DIR, file);
    return fs.existsSync(full) ? { path: full, mimeType: file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg' } : null;
}

module.exports = { speak, voiceFor, cacheKey, cleanText, allow, purge, stash, cachedByName, CACHE_DIR, MAX_TEXT, _setSynth: (fn) => { _synthOverride = fn; } };
