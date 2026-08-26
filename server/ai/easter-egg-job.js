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
    const len = 6 + Math.floor(rnd() * 3);
    const code = [];
    for (let i = 0; i < len; i++) code.push(TOKENS[Math.floor(rnd() * TOKENS.length)]);
    return code;
}
function _sanitizeCode(arr) {
    if (!Array.isArray(arr)) return null;
    const code = arr.map(t => String(t || '').toLowerCase().trim())
        .map(t => ({ arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right' }[t] || t))
        .filter(t => TOKENS.includes(t));
    return (code.length >= 5 && code.length <= 12) ? code : null;
}

async function _generate() {
    let vibe = '';
    try { const g = chatAi && chatAi.getGlobalInsight && chatAi.getGlobalInsight(); if (g && g.overview) vibe = String(g.overview).slice(0, 400); } catch { /* */ }

    if (ai.isEnabled && ai.isEnabled() && ai.withinBudget && ai.withinBudget()) {
        const prompt = `Invent today's secret "Konami-style" easter egg for OpenVibe.Live, a hobbyist live-streaming site.${vibe ? `\nToday's community vibe (for flavour): ${vibe}` : ''}

Return STRICT JSON only, nothing else:
{
  "title": "<punchy name for today's secret, 2-5 words>",
  "code": [<6 to 9 tokens IN ORDER, each exactly one of: "up","down","left","right", or a single lowercase letter a-z>],
  "hints": ["<hint 1>", "<hint 2>", "<hint 3>"],
  "effect": "<one of: confetti, fireworks, matrix, rainbow, shake>",
  "reward": "<a short, fun congratulatory line shown when a user cracks it>"
}

The hints, taken together and in order, must cryptically ENCODE the exact code sequence (use riddles/wordplay for directions and letters — e.g. "twice toward the heavens" = up,up) WITHOUT ever listing the tokens literally. Make it clever but genuinely figure-out-able. Keep it playful and a little unhinged.`;
        try {
            const text = await ai.summarizeText(prompt, 500, 'easter_egg');
            const m = text && text.match(/\{[\s\S]*\}/);
            if (m) {
                const j = JSON.parse(m[0]);
                const code = _sanitizeCode(j.code);
                if (code) {
                    return {
                        title: String(j.title || 'The Daily Secret').replace(/\s+/g, ' ').trim().slice(0, 60),
                        code,
                        hints: (Array.isArray(j.hints) ? j.hints : []).map(h => String(h || '').trim().slice(0, 160)).filter(Boolean).slice(0, 4),
                        effect: EFFECTS.includes(j.effect) ? j.effect : 'confetti',
                        reward: String(j.reward || "You cracked today's secret! 🎉").trim().slice(0, 200),
                        ai: true,
                    };
                }
            }
        } catch { /* fall through */ }
    }
    // Fallback
    const code = _seededCode();
    const dirWord = { up: 'skyward', down: 'to the depths', left: 'to the west', right: 'to the east' };
    return {
        title: 'The Daily Secret',
        code,
        hints: [
            'The old gamers knew: four winds and a few good letters open the way.',
            'Watch the arrows and whisper the letters, in the order the day decided.',
            'No shame in guessing — the brave stumble onto it.',
        ],
        effect: EFFECTS[code.length % EFFECTS.length],
        reward: "You cracked today's secret! 🎉",
        ai: false,
        void: dirWord,
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
    return {
        date: p.date,
        title: p.title || 'The Daily Secret',
        hints: p.hints || [],
        codeLength: p.code.length,
        effect: p.effect || 'confetti',
        nextResetAt: nextReset.getTime(),
    };
}
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

module.exports = { start, tick, getPublic, checkSolution };

// CLI: force a fresh egg now — `node server/ai/easter-egg-job.js`
if (require.main === module) {
    tick({ force: true }).then(() => { const p = _load(); console.log('Egg:', JSON.stringify({ title: p.title, code: p.code, hints: p.hints, effect: p.effect })); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
}
