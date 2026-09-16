/**
 * Daily easter-egg job — once a day the AI invents a fresh "secret code" (Konami-style key
 * sequence) themed on the community's vibe, plus cryptic-but-solvable hints. The code is kept
 * SECRET server-side (never sent to clients); users decode the hints, enter the sequence, and
 * the server validates. Persisted in the `daily_easter_egg` setting; degrades to a deterministic
 * daily code + generic hints when AI is off.
 */
'use strict';
const db = require('../db/database');
const ai = require('./ai-analysis');
let chatAi = null; try { chatAi = require('./chat-ai'); } catch { /* */ }

const SETTING = 'daily_easter_egg';
const DIRS = ['up', 'down', 'left', 'right'];
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const TOKENS = [...DIRS, ...LETTERS];
const EFFECTS = ['confetti', 'fireworks', 'matrix', 'rainbow', 'shake'];
let _busy = false;

// Local date key (server-local) — one egg per calendar day.
function _today() { return new Date().toISOString().slice(0, 10); }
function _load() { try { return JSON.parse(db.getState(SETTING) || '{}') || {}; } catch { return {}; } }
function _due() { const p = _load(); return !p.date || p.date !== _today() || !Array.isArray(p.code) || !p.code.length; }

// Deterministic daily fallback (no AI): a seeded 7-token sequence + generic hints.
function _seededCode() {
    let seed = 0; for (const ch of _today()) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const len = 5 + Math.floor(rnd() * 3);
    const code = [];
    // Konami feel: roughly half arrows, half letters, mixed.
    for (let i = 0; i < len; i++) code.push(rnd() < 0.55 ? DIRS[Math.floor(rnd() * DIRS.length)] : LETTERS[Math.floor(rnd() * LETTERS.length)]);
    if (!code.some(t => DIRS.includes(t))) code[0] = DIRS[Math.floor(rnd() * DIRS.length)];
    if (!code.some(t => !DIRS.includes(t))) code[len - 1] = LETTERS[Math.floor(rnd() * LETTERS.length)];
    return code;
}
function _sanitizeCode(arr) {
    if (!Array.isArray(arr)) return null;
    const code = arr.map(t => String(t || '').toLowerCase().trim())
        .map(t => ({ arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right' }[t] || t))
        .filter(t => TOKENS.includes(t));
    return (code.length >= 4 && code.length <= 9) ? code : null;
}

// ── Clue bank: a fair, readable clue for every token (used for the no-AI fallback and to
// patch any AI clue that is missing or does not line up with the code) ─────────────────
const DIR_CLUES = {
    up:    ['toward the sky', 'the way a balloon goes', 'north on the compass', 'where the ceiling lives', 'the arrow that climbs'],
    down:  ['toward the floor', 'the way rain falls', 'south on the compass', 'where roots grow', 'the arrow that sinks'],
    left:  ['the side your heart is on', 'west on the compass', 'the arrow that points at the past', 'port side, sailor', 'where the sun sets'],
    right: ['the side most people write with', 'east on the compass', 'the arrow that points at the future', 'starboard, sailor', 'where the sun rises'],
};
const LETTER_WORDS = { a: 'arena', b: 'broadcast', c: 'clip', d: 'donate', e: 'emote', f: 'follow', g: 'goose', h: 'hype', i: 'irl', j: 'jump', k: 'keyboard', l: 'latency', m: 'mic', n: 'network', o: 'overlay', p: 'paste', q: 'queue', r: 'robot', s: 'stream', t: 'tts', u: 'upload', v: 'vibe', w: 'webrtc', x: 'xp', y: 'yap', z: 'zoom' };
const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
function _clueFor(tok, i, rnd) {
    if (DIR_CLUES[tok]) { const list = DIR_CLUES[tok]; return list[(i + Math.floor(rnd() * list.length)) % list.length]; }
    const w = LETTER_WORDS[tok] || tok;
    const forms = [`the letter that starts "${w}"`, `"${w}" begins with it`, `the ${ORD[0]} letter of "${w}"`];
    return forms[Math.floor(rnd() * forms.length)];
}
function _rngFor(seedStr) { let seed = 7; for (const ch of seedStr) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0; return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
/** One clue per token, in order — AI clues kept when they line up, bank clues fill the gaps. */
function _alignClues(code, aiClues) {
    const rnd = _rngFor(_today() + code.join(','));
    const out = [];
    for (let i = 0; i < code.length; i++) {
        const c = Array.isArray(aiClues) && aiClues[i] ? String(aiClues[i]).replace(/\s+/g, ' ').trim().slice(0, 110) : '';
        out.push(c || _clueFor(code[i], i, rnd));
    }
    return out;
}

async function _generate() {
    let vibe = '';
    try { const g = chatAi && chatAi.getGlobalInsight && chatAi.getGlobalInsight(); if (g && g.overview) vibe = String(g.overview).slice(0, 400); } catch { /* */ }
    if (ai.isEnabled && ai.isEnabled() && ai.withinBudget && ai.withinBudget()) {
        const prompt = `Invent today's secret "Konami-style" code for OpenVibe.Live, a hobbyist live-streaming site.${vibe ? `\nToday's community vibe (for flavour only): ${vibe}` : ''}
Return STRICT JSON only, nothing else:
{
  "title": "<punchy name for today's secret, 2-5 words>",
  "code": [<5 to 7 tokens IN ORDER, each exactly one of: "up","down","left","right", or a single lowercase letter a-z; use at least 2 arrows and at least 1 letter>],
  "clues": [<EXACTLY one clue per token, same order, each ≤ 90 chars>],
  "effect": "<one of: confetti, fireworks, matrix, rainbow, shake>",
  "reward": "<a short, fun congratulatory line shown when a user cracks it>"
}
CLUE RULES (this is a game people must actually be able to win):
- Clue i describes token i and ONLY token i. Never list the token literally, but make it fair: a normal person should get it in one or two guesses.
- Arrow clues use direction imagery ("where the sun rises" = right, "toward the sky" = up, "the way rain falls" = down, "the side your heart is on" = left).
- Letter clues name a common word the letter starts ("the letter that starts 'goose'" = g), or a famous initial.
- Keep the flavour playful and on-theme, but clarity beats cleverness.`;
        try {
            const text = await ai.summarizeText(prompt, 600, 'easter_egg');
            const m = text && text.match(/\{[\s\S]*\}/);
            if (m) {
                const j = JSON.parse(m[0]);
                const code = _sanitizeCode(j.code);
                if (code) {
                    return {
                        title: String(j.title || 'The Daily Secret').replace(/\s+/g, ' ').trim().slice(0, 60),
                        code,
                        clues: _alignClues(code, j.clues || j.hints),
                        effect: EFFECTS.includes(j.effect) ? j.effect : 'confetti',
                        reward: String(j.reward || "You cracked today's secret! 🎉").trim().slice(0, 200),
                        ai: true,
                    };
                }
            }
        } catch { /* fall through */ }
    }
    // Fallback: deterministic daily code with bank clues — always solvable.
    const code = _seededCode();
    return {
        title: 'The Daily Secret',
        code,
        clues: _alignClues(code, null),
        effect: EFFECTS[code.length % EFFECTS.length],
        reward: "You cracked today's secret! 🎉",
        ai: false,
    };
}

async function tick(opts = {}) {
    if (_busy || (!opts.force && !_due())) return;
    _busy = true;
    try {
        const egg = await _generate();
        db.setState(SETTING, JSON.stringify({ date: _today(), ...egg, updated_at: Date.now() }));
        console.log(`[EasterEgg] New daily egg "${egg.title}" (${egg.code.length} keys, ${egg.ai ? 'AI' : 'fallback'})`);
    } catch (e) {
        console.warn('[EasterEgg] tick error:', e.message);
    } finally { _busy = false; }
}

// Public (safe) view — never leaks the code, only its length + hints.
function getPublic() {
    const p = _load();
    if (!p.code || p.date !== _today()) return null;
    const now = new Date();
    const nextReset = new Date(now); nextReset.setHours(24, 0, 0, 0);
    const clues = Array.isArray(p.clues) && p.clues.length === p.code.length ? p.clues : _alignClues(p.code, p.clues || p.hints);
    return {
        date: p.date,
        title: p.title || 'The Daily Secret',
        clues,
        hints: clues,                       // back-compat for older clients
        codeLength: p.code.length,
        effect: p.effect || 'confetti',
        nextResetAt: nextReset.getTime(),
        ai: !!p.ai,
    };
}

// ── "Stuck?" reveals: after a couple of wrong attempts a solver may reveal keys one at a time
// (never the last one) — enough to keep it fun, not enough to make typing pointless. Per-day,
// per-solver, in memory (a restart just makes people try twice more).
const _fails = new Map();     // solverKey → { date, n, revealed:Set }
function _rec(solverKey) {
    const d = _today(); let r = _fails.get(solverKey);
    if (!r || r.date !== d) { r = { date: d, n: 0, revealed: new Set() }; _fails.set(solverKey, r); }
    if (_fails.size > 5000) { const k = _fails.keys().next().value; _fails.delete(k); }
    return r;
}
function noteFail(solverKey) { const r = _rec(solverKey); r.n++; return r.n; }
const REVEAL_AFTER_FAILS = 2;
function reveal(solverKey, index) {
    const p = _load();
    if (!p.code || p.date !== _today()) return { error: 'No secret today' };
    const r = _rec(solverKey);
    const i = Number.isInteger(index) ? index : [...Array(p.code.length).keys()].find(k => !r.revealed.has(k));
    if (i == null || i < 0 || i >= p.code.length) return { error: 'Nothing left to reveal' };
    if (i === p.code.length - 1 && !r.revealed.has(i)) return { error: 'The last key is yours to find', last: true };
    if (r.n < REVEAL_AFTER_FAILS && !r.revealed.has(i)) return { error: `Try ${REVEAL_AFTER_FAILS - r.n} more time${REVEAL_AFTER_FAILS - r.n === 1 ? '' : 's'} first`, needFails: REVEAL_AFTER_FAILS - r.n };
    r.revealed.add(i);
    return { index: i, token: p.code[i], revealed: [...r.revealed].sort((a, b) => a - b).map(k => ({ index: k, token: p.code[k] })) };
}
function revealedFor(solverKey) { const p = _load(); const r = _fails.get(solverKey); if (!p.code || !r || r.date !== _today()) return { fails: r ? r.n : 0, revealed: [] }; return { fails: r.n, revealed: [...r.revealed].sort((a, b) => a - b).map(k => ({ index: k, token: p.code[k] })) }; }

// Validate an attempt against today's secret code (server-side only).
function checkSolution(sequence) {
    const p = _load();
    if (!p.code || p.date !== _today() || !Array.isArray(sequence)) return null;
    const norm = sequence.map(t => String(t || '').toLowerCase().trim()).filter(Boolean);
    // Match if the tail of the attempt equals the code (so trailing extra keys are fine).
    if (norm.length < p.code.length) return { ok: false };
    const tail = norm.slice(norm.length - p.code.length);
    const ok = tail.every((t, i) => t === p.code[i]);
    return { ok, egg: ok ? { title: p.title, effect: p.effect, reward: p.reward, date: p.date } : null };
}

function start() {
    setTimeout(() => { tick().catch(() => {}); }, 15 * 1000);
    setInterval(() => { tick().catch(() => {}); }, 5 * 60 * 1000); // self-gates on the calendar day
    console.log('[EasterEgg] Daily easter-egg job started');
}

module.exports = { start, tick, getPublic, checkSolution, noteFail, reveal, revealedFor, REVEAL_AFTER_FAILS };

// CLI: force a fresh egg now — `node server/ai/easter-egg-job.js`
if (require.main === module) {
    tick({ force: true }).then(() => { const p = _load(); console.log('Egg:', JSON.stringify({ title: p.title, code: p.code, clues: p.clues, effect: p.effect, ai: p.ai })); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
}
