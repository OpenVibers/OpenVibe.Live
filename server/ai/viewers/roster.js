/**
 * AI Chat Viewers — persistent per-channel roster ("brains").
 *
 * Each channel has a durable set of bot identities in channel_ai_bots that persist
 * across every stream. Ambient bots are generated locally (no LLM cost) from
 * archetype + typing-style tables. Clones are seeded from a real chatter's AI
 * insight + sample messages (one metered LLM call).
 */
const db = require('../../db/database');
const budget = require('./budget');

// ── Character archetypes (persona seed, no LLM needed for ambient) ──
const CHARACTERS = [
    { label: 'hype', blurb: 'high-energy hype viewer, all caps bursts, loves the stream' },
    { label: 'chill', blurb: 'laid-back regular, dry humor, understated reactions' },
    { label: 'curious', blurb: 'asks questions about what is happening, genuinely interested' },
    { label: 'meme', blurb: 'speaks in memes and emotes, short punchy jokes' },
    { label: 'supportive', blurb: 'wholesome, encouraging, hypes up the streamer and other chatters' },
    { label: 'skeptic', blurb: 'playfully doubtful, gently roasts, contrarian but not mean' },
    { label: 'lurker', blurb: 'quiet, occasional short comment, mostly watching' },
    { label: 'nerd', blurb: 'knows a lot, drops facts and tips, slightly know-it-all' },
    { label: 'newbie', blurb: 'new to the stream, a little lost, friendly' },
    { label: 'oldhead', blurb: 'longtime viewer, references past streams, nostalgic' },
    { label: 'gremlin', blurb: 'chaotic, unpredictable, keyboard-smash energy' },
    { label: 'mod-vibes', blurb: 'helpful, keeps chat welcoming, answers other chatters' },
];
const STYLES = [
    { label: 'lowercase', rules: 'all lowercase, minimal punctuation' },
    { label: 'caps-hype', rules: 'occasional ALL CAPS words for emphasis' },
    { label: 'emotes', rules: 'sprinkle emotes/emoji, short' },
    { label: 'proper', rules: 'normal capitalization and punctuation' },
    { label: 'abbrev', rules: 'texting abbreviations (lol, ngl, fr, tbh)' },
    { label: 'terse', rules: 'very short, 1-4 words often' },
    { label: 'rambly', rules: 'a touch rambly, run-on but still one line' },
];
const COLORS = ['#ff6b6b', '#4ecdc4', '#ffd93d', '#a78bfa', '#f472b6', '#60a5fa', '#34d399', '#fb923c', '#e879f9', '#22d3ee'];
const NAME_ADJ = ['sleepy', 'salty', 'cosmic', 'funky', 'grumpy', 'spicy', 'silent', 'neon', 'lucky', 'wild', 'humble', 'crispy', 'vivid', 'mellow', 'rowdy', 'zesty'];
const NAME_NOUN = ['otter', 'goblin', 'pixel', 'noodle', 'raccoon', 'comet', 'gizmo', 'waffle', 'penguin', 'nugget', 'wizard', 'cactus', 'ferret', 'muffin', 'yeti', 'llama'];
const NAME_SUF = ['', '', '_', 'xd', '69', '42', 'tv', 'ig', '_ttv', '99', '_'];

// Deterministic-ish PRNG-free pick using the roster size + a salt so we don't need
// Math.random (which is unavailable in some sandboxes, and keeps names varied).
let _seedCounter = 1;
function pick(arr, salt) {
    _seedCounter = (_seedCounter * 1103515245 + 12345 + (salt || 0)) & 0x7fffffff;
    return arr[_seedCounter % arr.length];
}

function makeUsername(existing, salt) {
    for (let i = 0; i < 40; i++) {
        const adj = pick(NAME_ADJ, salt + i);
        const noun = pick(NAME_NOUN, salt + i * 7 + 3);
        const suf = pick(NAME_SUF, salt + i * 13 + 5);
        const name = `${adj}${noun}${suf}`.slice(0, 22);
        if (!existing.has(name.toLowerCase())) { existing.add(name.toLowerCase()); return name; }
    }
    const fallback = `viewer${(salt % 9000) + 1000}`;
    existing.add(fallback);
    return fallback;
}

function makeAmbientPersona(salt) {
    const character = pick(CHARACTERS, salt);
    const style = pick(STYLES, salt * 3 + 1);
    const color = pick(COLORS, salt * 5 + 2);
    return { character, style, color, identity: '' };
}

/**
 * Ensure the channel has `targetAmbient` active ambient bots (create missing ones).
 * Returns the full active roster (ambient + clones) for this channel.
 */
function ensureRoster(streamerId, targetAmbient) {
    const all = db.getChannelAiBots(streamerId, { activeOnly: true });
    const ambient = all.filter(b => b.source === 'ambient');
    const existing = new Set(all.map(b => (b.username || '').toLowerCase()));
    let created = 0;
    for (let i = ambient.length; i < targetAmbient; i++) {
        const salt = (streamerId * 131 + i * 977 + created * 17) & 0x7fffffff;
        const persona = makeAmbientPersona(salt);
        const username = makeUsername(existing, salt);
        try {
            db.createChannelAiBot({
                channel_user_id: streamerId,
                username,
                display_name: username,
                avatar_color: persona.color,
                source: 'ambient',
                persona_json: persona,
                brain_json: { memory: '', timeline: [], identity: '' },
            });
            created++;
        } catch (e) { /* unique-name race; skip */ }
    }
    if (created) console.log(`[AI-Viewers] Created ${created} ambient bot(s) for streamer ${streamerId}`);
    // Return the (possibly grown) active roster, capping ambient to target.
    const fresh = db.getChannelAiBots(streamerId, { activeOnly: true });
    const clones = fresh.filter(b => b.source === 'clone');
    const activeAmbient = fresh.filter(b => b.source === 'ambient').slice(0, targetAmbient);
    return [...activeAmbient, ...clones];
}

// Build a compact "sample of how this person talks" from their chat rows.
function _sampleLines(rows, n = 20) {
    return (rows || [])
        .map(r => (r.message || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, n);
}

/**
 * Create a clone bot from a real chatter.
 * @param {number} streamerId
 * @param {{kind:'user'|'relay', ref:string, insight:object|null, samples:string[], displayName?:string}} src
 * @returns {Promise<object>} the created bot row
 */
async function createCloneBot(streamerId, src) {
    const existing = new Set(db.getChannelAiBots(streamerId).map(b => (b.username || '').toLowerCase()));
    const baseName = (src.displayName || src.ref || 'clone').toString().replace(/[^a-zA-Z0-9_]/g, '').slice(0, 18) || 'clone';
    let username = baseName;
    let n = 1;
    while (existing.has(username.toLowerCase())) username = `${baseName}${++n}`.slice(0, 22);

    // Derive a persona/identity from their insight + samples via one metered call.
    const insight = src.insight || {};
    const overview = insight.overview_alltime || insight.overview_24h || insight.overview || '';
    const memory = insight.memory || '';
    const samples = _sampleLines(src.samples, 24);
    let identity = overview ? overview.slice(0, 600) : '';
    try {
        const prompt = [
            `You are profiling a chat viewer named "${src.displayName || src.ref}" so an AI can role-play as them.`,
            overview ? `What we know about them: ${overview}` : '',
            memory ? `Notable memory: ${memory}` : '',
            samples.length ? `Sample messages they've sent:\n- ${samples.join('\n- ')}` : '',
            `Write a tight 2-3 sentence character brief capturing their vibe, interests, and how they type (tone, casing, slang, length). Second person ("You are ..."). No preamble.`,
        ].filter(Boolean).join('\n\n');
        const brief = await budget.generate(streamerId, { system: '', user: prompt, maxTokens: 160, temperature: 0.7 });
        if (brief && brief.trim()) identity = brief.trim();
    } catch { /* fall back to overview */ }

    const persona = {
        character: { label: 'clone', blurb: `a clone of the real viewer ${src.displayName || src.ref}` },
        style: { label: 'cloned', rules: 'match how the real person types (casing, slang, length)' },
        color: pick(COLORS, (streamerId + username.length) & 0x7fffffff),
        identity,
    };
    const brain = {
        memory: memory ? memory.slice(0, 800) : '',
        timeline: [],
        identity,
        samples: samples.slice(0, 10),
    };
    return db.createChannelAiBot({
        channel_user_id: streamerId,
        username,
        display_name: src.displayName || username,
        avatar_color: persona.color,
        source: 'clone',
        cloned_from_kind: src.kind,
        cloned_from_ref: src.ref,
        persona_json: persona,
        brain_json: brain,
    });
}

module.exports = { ensureRoster, createCloneBot, makeAmbientPersona, CHARACTERS, STYLES };
