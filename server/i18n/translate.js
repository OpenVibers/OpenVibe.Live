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
 * Every translation is a run of OpenVibe.AI's live.translate workflow (ai/ai-service.js), gated on
 * ai/llm.js's master switch; when AI is off it all silently returns null and the site behaves
 * exactly as before.
 */
'use strict';
const crypto = require('crypto');
const db = require('../db/database');
let llm = null;
try { llm = require('../ai/llm'); } catch { llm = null; }
let aiService = null;
try { aiService = require('../ai/ai-service'); } catch { aiService = null; }

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

// ── Detection (no model call) ──────────────────────────────────────────────────────
// public/js/lang-detect.js, the same file chat uses in the browser: scripts decide non-Latin text, common words and
// letters decide Latin-script languages (Spanish, French, German, …). Latin text it cannot place (slang, names, one
// word) is reported as 'en', as before, so direction-picking stays "Latin vs the channel's script" for it.
const OVLang = require('../../public/js/lang-detect');
function detectLang(text) {
    const d = OVLang.detect(text);
    if (d.lang && d.confidence >= 0.6) return d.lang;
    if (/[A-Za-z\u00c0-\u024f]/.test(String(text || ''))) return 'en';
    return d.lang || null;
}

/**
 * The first non-English language found in any LINE of a longer text. A bio like
 * "I don't speak English … おっさんの垂れ流し配信" is mostly Latin letters overall, so whole-text
 * detection says 'en'; per line, the Japanese line wins — which is the right answer for
 * "what language does this streamer live in".
 */
// A channel's language is inferred only from non-Latin scripts: one French line in an English bio must not make every
// English chat line a model call. A Latin-script channel language is the streamer's explicit chat_language setting.
const SCRIPT_LANGS = new Set(['ja', 'ko', 'zh', 'ru', 'uk', 'ar', 'th', 'he', 'el', 'hi']);
function detectForeignInText(text) {
    const lines = String(text || '').split(/[\n\r]+|(?<=[。！？.!?])\s+/);
    for (const line of lines) {
        const l = detectLang(line);
        if (l && SCRIPT_LANGS.has(l)) return l;
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
            lang = bioLang || ((nameLang && SCRIPT_LANGS.has(nameLang)) ? nameLang : 'en');
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
function available() { return !!(llm && aiService && llm.isEnabled && llm.isEnabled() && siteEnabled()); }

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
/** A cached translation: the text, '' when the model said it needs none, undefined when not cached. */
function cached(text, from, to) {
    const key = cacheKey(text, from, to);
    const hit = _memGet(key);
    if (hit !== undefined) return hit;
    _ensureTable();
    try {
        const row = db.get('SELECT text FROM translations WHERE key = ?', [key]);
        if (row && row.text) { _memSet(key, row.text); return row.text; }
    } catch { /* no table yet */ }
    return undefined;
}
function remember(text, from, to, out) {
    const key = cacheKey(text, from, to);
    _memSet(key, out || '');
    if (out) { try { db.run('INSERT OR REPLACE INTO translations (key, src, dst, text) VALUES (?, ?, ?, ?)', [key, from, to, out]); } catch { /* */ } }
}

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
    const hit = cached(text, from, to);
    if (hit !== undefined) return hit || null;
    if (!available()) return null;
    const ok = await _slot();
    if (!ok) return null;
    try {
        // The prompt lives in OpenVibe.AI (workflow live.translate).
        const o = await aiService.structured('live.translate', { text: String(text).trim(), from, to, context, max_tokens: maxTokens || undefined });
        if (o && o.unchanged) { remember(text, from, to, ''); return null; }
        const out = o && typeof o.text === 'string' ? o.text.trim() : '';
        if (!out) return null;
        remember(text, from, to, out);
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
    // Translating foreign text for everyone spends a model call on every such line, so only when detection is sure
    // (a lone 草 or a two-word line stays as it is; each viewer's translate button covers those).
    if (from !== 'en' && OVLang.detect(message).confidence < 0.85) return null;
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
async function translateLines(lines, { from, to = 'en', context = 'speech' } = {}) {
    const src = (lines || []).map(l => String(l || '').trim());
    const out = new Array(src.length).fill(null);
    const idx = src.map((l, i) => translatable(l) ? i : -1).filter(i => i >= 0);
    if (!idx.length || !available()) return out;
    const joined = idx.map(i => src[i].replace(/\s*\n\s*/g, ' ')).join('\n');
    const t = await translate(joined, { from, to, context, maxTokens: 1200 });
    if (!t) return out;
    const parts = t.split('\n').map(x => x.trim()).filter(Boolean);
    if (parts.length === idx.length) { idx.forEach((i, k) => { out[i] = parts[k]; }); return out; }
    // Line count drifted — fall back to one call per line (bounded).
    for (const i of idx.slice(0, 8)) out[i] = await translate(src[i], { from, to, context });
    return out;
}

/**
 * Many chat lines to one language, for a viewer (the batch endpoint behind auto-translate). Each line is checked
 * before any model call: nothing to translate → null; already in `to` → { same: true }; cached → the cached text.
 * What is left goes to the model in ONE call (translateLines), and each line is cached on its own, so the next
 * viewer asking for the same line costs nothing.
 * @returns {Promise<Array<{from:string,text:string}|{same:true,from:string}|null>>} aligned to `texts`
 */
async function translateMany(texts, { to = 'en', context = 'chat' } = {}) {
    const out = texts.map(() => null);
    const need = [];
    texts.forEach((t, i) => {
        if (!translatable(t)) return;
        const d = OVLang.detect(t);
        if (!d.lang) return;   // slang, emote names, one short word: no language to translate from, no call
        const from = d.confidence >= 0.6 ? d.lang : 'auto';
        if (from === to) { out[i] = { same: true, from }; return; }
        const hit = cached(t, from, to);
        if (hit !== undefined) { out[i] = hit ? { from, text: hit } : { same: true, from }; return; }
        need.push({ i, t, from });
    });
    if (!need.length || !available()) return out;
    // One model call per group whose joined text stays under the translate() input cap (1200 chars): a busy chat's
    // batch of 20 lines used to exceed it, and the whole batch came back untranslated.
    const groups = [];
    let cur = [], len = 0;
    for (const n of need) {
        const l = n.t.length + 1;
        if (cur.length && len + l > 1000) { groups.push(cur); cur = []; len = 0; }
        cur.push(n); len += l;
    }
    if (cur.length) groups.push(cur);
    for (const g of groups) {
        const lines = await translateLines(g.map((n) => n.t), { from: 'auto', to, context });
        g.forEach((n, k) => {
            if (!lines[k]) return;
            out[n.i] = { from: n.from, text: lines[k] };
            remember(n.t, n.from, to, lines[k]);
        });
    }
    return out;
}

module.exports = {
    detectLang, detectForeignInText, translatable, channelLanguage, channelMeta, invalidateChannel, translate, translateChatMessage, translateLines, translateMany,
    langName, langFlag, isAllowedLang, available, siteEnabled, LANG_NAMES, LANG_FLAGS,
};
