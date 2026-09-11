/**
 * i18n/translate.js — language detection + LLM translation for chat, bios and live speech.
 *
 * Built for streamers who don't stream in English (JapaneseOldGuy was the first): the
 * owner couldn't read him, and his bio asks viewers not to type English. This module is
 * the ONE place that answers three questions:
 *
 *   detectLang(text)        → 'ja' | 'ko' | 'zh' | 'ru' | … | 'en' (latin script) | null
 *   channelLanguage(userId) → the language a channel lives in: the streamer's explicit
 *                             channels.chat_language, else detected from their bio/name.
 *   translate(text, {from, to}) → cached LLM translation (memory LRU + `translations` table)
 *
 * On top of those, translateChatMessage() picks the DIRECTION for a chat line:
 *   - a non-English message  → English   (so the owner + English viewers can read it)
 *   - an English message in a non-English channel → the channel's language
 *     (so the streamer can read his own chat without anyone typing Japanese)
 *
 * Every call is best-effort and metered through ai/llm.js (shared key, daily budget); when
 * AI is off it all silently returns null and the site behaves exactly as before.
 */
'use strict';
const crypto = require('crypto');
const db = require('../db/database');
let llm = null;
try { llm = require('../ai/llm'); } catch { llm = null; }

const LANG_NAMES = {
    en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ru: 'Russian', uk: 'Ukrainian', ar: 'Arabic',
    th: 'Thai', he: 'Hebrew', el: 'Greek', hi: 'Hindi', es: 'Spanish', pt: 'Portuguese', fr: 'French',
    de: 'German', it: 'Italian', tr: 'Turkish', vi: 'Vietnamese', id: 'Indonesian', pl: 'Polish', nl: 'Dutch',
};
const LANG_FLAGS = { en: '🇺🇸', ja: '🇯🇵', ko: '🇰🇷', zh: '🇨🇳', ru: '🇷🇺', uk: '🇺🇦', ar: '🇸🇦', th: '🇹🇭', he: '🇮🇱', el: '🇬🇷', hi: '🇮🇳', es: '🇪🇸', pt: '🇧🇷', fr: '🇫🇷', de: '🇩🇪', it: '🇮🇹', tr: '🇹🇷', vi: '🇻🇳', id: '🇮🇩', pl: '🇵🇱', nl: '🇳🇱' };
const ALLOWED = new Set(['auto', ...Object.keys(LANG_NAMES)]);

function langName(code) { return LANG_NAMES[code] || code || 'English'; }
function langFlag(code) { return LANG_FLAGS[code] || '🌐'; }
function isAllowedLang(code) { return ALLOWED.has(String(code || '')); }

// ── Detection (script-based; no model call) ─────────────────────────────────────
// Latin script is reported as 'en' — we cannot tell English from Spanish without a model,
// and for direction-picking "latin vs the channel's script" is what matters.
function detectLang(text) {
    const s = String(text || '');
    const count = (re) => (s.match(re) || []).length;
    const kana = count(/[\u3040-\u30ff\uff66-\uff9f]/g);
    const han = count(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
    const hangul = count(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g);
    const cyr = count(/[\u0400-\u04ff]/g);
    const arab = count(/[\u0600-\u06ff]/g);
    const thai = count(/[\u0e00-\u0e7f]/g);
    const heb = count(/[\u0590-\u05ff]/g);
    const greek = count(/[\u0370-\u03ff]/g);
    const deva = count(/[\u0900-\u097f]/g);
    const latin = count(/[A-Za-z\u00c0-\u024f]/g);
    const nonLatin = kana + han + hangul + cyr + arab + thai + heb + greek + deva;
    if (!nonLatin && !latin) return null;
    if (!nonLatin) return 'en';
    if (nonLatin / (nonLatin + latin) < 0.34) return 'en';   // "lol 草" — mostly English
    if (kana) return 'ja';
    if (hangul) return 'ko';
    if (han) return 'zh';
    if (cyr) return 'ru';
    if (arab) return 'ar';
    if (thai) return 'th';
    if (heb) return 'he';
    if (greek) return 'el';
    if (deva) return 'hi';
    return 'en';
}

/**
 * The first non-English language found in any LINE of a longer text. A bio like
 * "I don't speak English … おっさんの垂れ流し配信" is mostly Latin letters overall, so whole-text
 * detection says 'en'; per line, the Japanese line wins — which is the right answer for
 * "what language does this streamer live in".
 */
function detectForeignInText(text) {
    const lines = String(text || '').split(/[\n\r]+|(?<=[。！？.!?])\s+/);
    for (const line of lines) {
        const l = detectLang(line);
        if (l && l !== 'en') return l;
    }
    return null;
}

/** Is there anything worth translating (letters, not just emotes/links/numbers)? */
function translatable(text) {
    const s = String(text || '').trim();
    if (s.length < 2 || s.length > 1200) return false;
    const stripped = s
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/:[a-z0-9_]+:/gi, '')          // :emote:
        .replace(/[!/]\w+/g, '')                 // !commands  /commands
        .replace(/@\w+/g, '');
    return /\p{L}{2,}/u.test(stripped);
}

// ── Channel language ─────────────────────────────────────────────────────────────
const _chanCache = new Map(); // userId → { lang, at }
function channelLanguage(userId) {
    const id = parseInt(userId, 10);
    if (!id) return 'en';
    const hit = _chanCache.get(id);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.lang;
    let lang = 'en';
    try {
        const ch = db.getChannelByUserId(id);
        const explicit = String(ch?.chat_language || 'auto').toLowerCase();
        if (explicit !== 'auto' && ALLOWED.has(explicit)) lang = explicit;
        else {
            const u = db.getUserById(id);
            // Bio wins (it is where "I don't speak English" lives); a name/title only if it is
            // clearly in another script.
            const bioLang = detectForeignInText(u?.bio || '');
            const nameLang = detectLang(`${u?.display_name || ''} ${ch?.title || ''}`);
            lang = bioLang || ((nameLang && nameLang !== 'en') ? nameLang : 'en');
        }
    } catch { lang = 'en'; }
    _chanCache.set(id, { lang, at: Date.now() });
    return lang;
}
function invalidateChannel(userId) { _chanCache.delete(parseInt(userId, 10)); }
/** { code, name, flag, explicit } for API responses. */
function channelMeta(userId) {
    const code = channelLanguage(userId);
    let explicit = false;
    try { const ch = db.getChannelByUserId(parseInt(userId, 10)); explicit = !!(ch && ch.chat_language && ch.chat_language !== 'auto'); } catch { /* */ }
    return { code, name: langName(code), flag: langFlag(code), explicit, translate: available() };
}

// ── Translation (LLM, cached) ────────────────────────────────────────────────────
function siteEnabled() {
    try {
        const v = db.getSetting('chat_translate_enabled');
        if (v === undefined || v === null || v === '') return true;   // default ON
        return !(String(v) === 'false' || String(v) === '0');
    } catch { return true; }
}
function available() { return !!(llm && llm.isEnabled && llm.isEnabled() && siteEnabled()); }

let _tableReady = false;
function _ensureTable() {
    if (_tableReady) return;
    try {
        db.getDb().exec(`CREATE TABLE IF NOT EXISTS translations (
            key TEXT PRIMARY KEY,
            src TEXT, dst TEXT,
            text TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        _tableReady = true;
    } catch { /* read-only db or race — memory cache still works */ }
}
const _mem = new Map();   // key → text (LRU-ish, capped)
const MEM_MAX = 1500;
function _memGet(k) { const v = _mem.get(k); if (v !== undefined) { _mem.delete(k); _mem.set(k, v); } return v; }
function _memSet(k, v) { _mem.set(k, v); if (_mem.size > MEM_MAX) _mem.delete(_mem.keys().next().value); }
function cacheKey(text, from, to) { return crypto.createHash('sha1').update(`${from}|${to}|${String(text).trim()}`).digest('hex'); }

let _inflight = 0;
const MAX_INFLIGHT = 3;
const _queue = [];
const MAX_QUEUE = 60;
function _slot() {
    if (_inflight < MAX_INFLIGHT) { _inflight++; return Promise.resolve(true); }
    if (_queue.length >= MAX_QUEUE) return Promise.resolve(false);   // shed load: the line simply stays untranslated
    return new Promise((resolve) => _queue.push(resolve));
}
function _release() {
    const next = _queue.shift();
    if (next) next(true); else _inflight = Math.max(0, _inflight - 1);
}

/**
 * Translate `text` from → to. Returns the translated string or null (AI off, over budget,
 * nothing to translate, provider failure). `context` lets the prompt know the kind of
 * text ('chat' | 'bio' | 'speech') so tone is preserved appropriately.
 */
async function translate(text, { from = 'auto', to = 'en', context = 'chat', maxTokens } = {}) {
    if (!translatable(text)) return null;
    if (from === to) return null;
    const key = cacheKey(text, from, to);
    const hit = _memGet(key);
    if (hit !== undefined) return hit;
    _ensureTable();
    try {
        const row = db.get('SELECT text FROM translations WHERE key = ?', [key]);
        if (row && row.text) { _memSet(key, row.text); return row.text; }
    } catch { /* no table yet */ }
    if (!available()) return null;
    const ok = await _slot();
    if (!ok) return null;
    try {
        const src = from === 'auto' ? 'the source language' : langName(from);
        const kind = context === 'bio' ? 'a streamer\'s profile bio'
            : context === 'speech' ? 'lines of live-stream speech (a casual gamer talking to his chat)'
                : 'a live-stream chat message';
        const system = [
            `You translate ${kind} from ${src} to ${langName(to)}.`,
            'Rules: keep the tone, slang, jokes, profanity and emoji as they are; keep names, URLs, :emotes:, !commands and @mentions unchanged;',
            'never add explanations, notes, quotes or brackets; if it is already in the target language, return it unchanged.',
            context === 'speech' ? 'Input may contain several lines separated by newlines — return exactly the same number of lines, in order.' : '',
            'Output ONLY the translation.',
        ].filter(Boolean).join(' ');
        const r = await llm.complete({
            role: 'chat', kind: 'translate', source: `translate:${context}`,
            system, user: String(text).trim(),
            maxTokens: Math.max(40, Math.min(maxTokens || 600, Math.round(String(text).length * 2.2) + 60)),
            temperature: 0.2, timeoutMs: 15000, retries: 0,
        });
        const out = r && typeof r.text === 'string' ? r.text.trim().replace(/^["“]|["”]$/g, '') : '';
        if (!out) return null;
        // A translation identical to the input means it was already in the target language.
        if (out === String(text).trim()) { _memSet(key, ''); return null; }
        _memSet(key, out);
        try { db.run('INSERT OR REPLACE INTO translations (key, src, dst, text) VALUES (?, ?, ?, ?)', [key, from, to, out]); } catch { /* */ }
        return out;
    } catch { return null; }
    finally { _release(); }
}

/**
 * Pick the direction for a chat line in a channel and translate it.
 * @returns {Promise<{from:string,to:string,text:string}|null>}
 */
async function translateChatMessage(message, channelUserId) {
    if (!available() || !translatable(message)) return null;
    const from = detectLang(message);
    if (!from) return null;
    const chan = channelLanguage(channelUserId);
    let to = null;
    if (from !== 'en') to = 'en';                 // foreign → English, always
    else if (chan !== 'en') to = chan;            // English in a Japanese channel → Japanese
    if (!to || to === from) return null;
    const text = await translate(message, { from, to, context: 'chat' });
    return text ? { from, to, text } : null;
}

/**
 * Translate an array of speech lines (one LLM call), returning an array aligned to the
 * input (null where a line could not be translated).
 */
async function translateLines(lines, { from, to = 'en' } = {}) {
    const src = (lines || []).map(l => String(l || '').trim());
    const out = new Array(src.length).fill(null);
    const idx = src.map((l, i) => translatable(l) ? i : -1).filter(i => i >= 0);
    if (!idx.length || !available()) return out;
    const joined = idx.map(i => src[i].replace(/\s*\n\s*/g, ' ')).join('\n');
    const t = await translate(joined, { from, to, context: 'speech', maxTokens: 1200 });
    if (!t) return out;
    const parts = t.split('\n').map(x => x.trim()).filter(Boolean);
    if (parts.length === idx.length) { idx.forEach((i, k) => { out[i] = parts[k]; }); return out; }
    // Line count drifted — fall back to one call per line (bounded).
    for (const i of idx.slice(0, 8)) out[i] = await translate(src[i], { from, to, context: 'speech' });
    return out;
}

module.exports = {
    detectLang, detectForeignInText, translatable, channelLanguage, channelMeta, invalidateChannel, translate, translateChatMessage, translateLines,
    langName, langFlag, isAllowedLang, available, siteEnabled, LANG_NAMES, LANG_FLAGS,
};
