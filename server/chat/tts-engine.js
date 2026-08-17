/**
 * OpenVibe.Live — Server-Side TTS Engine
 *
 * Synthesizes speech audio using multiple providers:
 *   1. Google Cloud TTS (Standard, WaveNet, Neural2, Studio, Journey)
 *   2. Amazon Polly (Standard, Neural, Long-form, Generative)
 *   3. espeak-ng (local, free fallback)
 *
 * Returns base64-encoded audio (MP3 or WAV) for client playback.
 * Ported from RS-Companion's tts-engine.js + voice-system.js.
 */
const { execFile, execFileSync } = require('child_process');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('../db/database');

// ── Voice Catalog ─────────────────────────────────────────────
// Every voice available on the platform — combines RS-Companion's
// VOICE_CATALOG (72) with OpenVibe.Live cosmetic voices.
// engine: 'espeak-ng' | 'google-cloud' | 'amazon-polly' | 'browser'
const VOICE_CATALOG = {
    // ── espeak-ng voices ──────────────────────────────────────
    gary:           { name: 'Gary',              emoji: '🔊', engine: 'espeak-ng', rarity: 'common',    tier: 1, params: { voice: 'en',            pitch: 50,  speed: 160 } },
    brenda:         { name: 'Brenda',            emoji: '👩', engine: 'espeak-ng', rarity: 'common',    tier: 1, params: { voice: 'en+f1',         pitch: 50,  speed: 155 } },
    chadbot:        { name: 'ChadBot',           emoji: '💪', engine: 'espeak-ng', rarity: 'common',    tier: 1, params: { voice: 'en+m1',         pitch: 35,  speed: 180 } },
    karen:          { name: 'Karen',             emoji: '💅', engine: 'espeak-ng', rarity: 'common',    tier: 1, params: { voice: 'en+f2',         pitch: 65,  speed: 170 } },
    squeakmaster:   { name: 'SqueakMaster',      emoji: '🐭', engine: 'espeak-ng', rarity: 'common',    tier: 1, params: { voice: 'en+f3',         pitch: 99,  speed: 200 } },
    bigchungus:     { name: 'BigChungus',        emoji: '🐰', engine: 'espeak-ng', rarity: 'common',    tier: 1, params: { voice: 'en+m7',         pitch: 1,   speed: 90  } },
    tweaker:        { name: 'Tweaker',           emoji: '⚡', engine: 'espeak-ng', rarity: 'common',    tier: 1, params: { voice: 'en+m1',         pitch: 60,  speed: 320 } },
    grandpa:        { name: 'GrandpaJoe',        emoji: '👴', engine: 'espeak-ng', rarity: 'common',    tier: 1, params: { voice: 'en+m4',         pitch: 25,  speed: 85  } },
    crackhead:      { name: 'CrackheadCarl',     emoji: '💊', engine: 'espeak-ng', rarity: 'uncommon',  tier: 2, params: { voice: 'en+m5',         pitch: 80,  speed: 250 } },
    ghostgirl:      { name: 'GhostGirl',         emoji: '👻', engine: 'espeak-ng', rarity: 'uncommon',  tier: 2, params: { voice: 'en+whisper',    pitch: 70,  speed: 120 } },
    robotoverlord:  { name: 'RobotOverlord',     emoji: '🤖', engine: 'espeak-ng', rarity: 'uncommon',  tier: 2, params: { voice: 'en+m3',         pitch: 10,  speed: 130 } },
    sassybitch:     { name: 'SassyBitch',        emoji: '💁', engine: 'espeak-ng', rarity: 'uncommon',  tier: 2, params: { voice: 'en+f5',         pitch: 75,  speed: 165 } },
    demon:          { name: 'DemonLord',         emoji: '👹', engine: 'espeak-ng', rarity: 'uncommon',  tier: 2, params: { voice: 'en+croak',      pitch: 1,   speed: 70  } },
    helium:         { name: 'HeliumHuffer',      emoji: '🎈', engine: 'espeak-ng', rarity: 'uncommon',  tier: 2, params: { voice: 'en+f4',         pitch: 99,  speed: 250 } },
    britbong:       { name: 'BritBong',          emoji: '🇬🇧', engine: 'espeak-ng', rarity: 'uncommon',  tier: 2, params: { voice: 'en-gb-x-rp',   pitch: 45,  speed: 145 } },
    yeehaw:         { name: 'YeeHaw',            emoji: '🤠', engine: 'espeak-ng', rarity: 'uncommon',  tier: 2, params: { voice: 'en-us',         pitch: 30,  speed: 100 } },
    neckbeard:      { name: 'Neckbeard9000',     emoji: '🧔', engine: 'espeak-ng', rarity: 'uncommon',  tier: 2, params: { voice: 'en+m6',         pitch: 20,  speed: 130, gap: 5 } },
    crybaby:        { name: 'CryBaby',           emoji: '😭', engine: 'espeak-ng', rarity: 'uncommon',  tier: 2, params: { voice: 'en+f1',         pitch: 90,  speed: 110 } },
    scotsman:       { name: 'McScreamy',         emoji: '🏴', engine: 'espeak-ng', rarity: 'uncommon',  tier: 2, params: { voice: 'en-gb-scotland', pitch: 40,  speed: 175 } },
    alien:          { name: 'Zorp',              emoji: '👽', engine: 'espeak-ng', rarity: 'uncommon',  tier: 2, params: { voice: 'en+m5',         pitch: 99,  speed: 60,  gap: 15 } },
    gigachad:       { name: 'GigaChad',          emoji: '🏋️', engine: 'espeak-ng', rarity: 'rare',      tier: 3, params: { voice: 'en+m2',         pitch: 15,  speed: 140 } },
    uwu:            { name: 'UwUBot',            emoji: '🌸', engine: 'espeak-ng', rarity: 'rare',      tier: 3, params: { voice: 'en+f3',         pitch: 85,  speed: 190 } },
    nyc:            { name: 'BrooklynRage',      emoji: '🗽', engine: 'espeak-ng', rarity: 'uncommon',  tier: 2, params: { voice: 'en-us-nyc',     pitch: 55,  speed: 185 } },
    french:         { name: 'LeBaguette',        emoji: '🇫🇷', engine: 'espeak-ng', rarity: 'uncommon',  tier: 2, params: { voice: 'fr-fr',         pitch: 50,  speed: 150 } },
    german:         { name: 'HansGetZeFlammenwerfer', emoji: '🇩🇪', engine: 'espeak-ng', rarity: 'uncommon', tier: 2, params: { voice: 'de',      pitch: 35,  speed: 140 } },
    russian:        { name: 'ComradeBot',        emoji: '🇷🇺', engine: 'espeak-ng', rarity: 'uncommon',  tier: 2, params: { voice: 'ru',           pitch: 30,  speed: 135 } },
    japanese:       { name: 'SenpaiNotice',      emoji: '🇯🇵', engine: 'espeak-ng', rarity: 'rare',      tier: 3, params: { voice: 'ja',           pitch: 60,  speed: 150 } },
    slowmo:         { name: 'SlowMoDave',        emoji: '🐌', engine: 'espeak-ng', rarity: 'rare',      tier: 3, params: { voice: 'en+m2',         pitch: 40,  speed: 50  } },
    glitch:         { name: 'GlitchFiend',       emoji: '📟', engine: 'espeak-ng', rarity: 'rare',      tier: 3, params: { voice: 'en+m3',         pitch: 50,  speed: 160, gap: 20 } },
    void:           { name: 'VoidScreamer',      emoji: '🕳️', engine: 'espeak-ng', rarity: 'epic',      tier: 4, params: { voice: 'en+croak',      pitch: 1,   speed: 200 } },
    ascended:       { name: 'Ascended',          emoji: '✨', engine: 'espeak-ng', rarity: 'epic',      tier: 4, params: { voice: 'en+whisper',    pitch: 50,  speed: 300 } },
    omega:          { name: 'OMEGA',             emoji: '🔴', engine: 'espeak-ng', rarity: 'legendary', tier: 5, params: { voice: 'en+m7',         pitch: 1,   speed: 400 } },

    // Achievement espeak voices
    chatterbox:     { name: 'Chatterbox',        emoji: '💬', engine: 'espeak-ng', rarity: 'rare',      tier: 3, params: { voice: 'en+m2',         pitch: 60,  speed: 220 } },
    warlord:        { name: 'WarLord',           emoji: '⚔️', engine: 'espeak-ng', rarity: 'rare',      tier: 3, params: { voice: 'en+m7',         pitch: 10,  speed: 110 } },
    degenking:      { name: 'DegenKing',         emoji: '👑', engine: 'espeak-ng', rarity: 'rare',      tier: 3, params: { voice: 'en+m5',         pitch: 75,  speed: 195 } },
    fisherman:      { name: 'OldManSea',         emoji: '🎣', engine: 'espeak-ng', rarity: 'rare',      tier: 3, params: { voice: 'en+m4',         pitch: 30,  speed: 95  } },
    coinlord:       { name: 'CoinLord',          emoji: '💰', engine: 'espeak-ng', rarity: 'rare',      tier: 3, params: { voice: 'en+m6',         pitch: 40,  speed: 150 } },

    // ── Google Cloud TTS voices ───────────────────────────────
    // Standard
    gc_smooth_operator: { name: 'SmoothOperator',  emoji: '🎤', engine: 'google-cloud', rarity: 'rare', tier: 3, cloudVoice: { name: 'en-US-Standard-D', gender: 'MALE',   locale: 'en-US' } },
    gc_silicon_sally:   { name: 'SiliconSally',    emoji: '🎤', engine: 'google-cloud', rarity: 'rare', tier: 3, cloudVoice: { name: 'en-US-Standard-C', gender: 'FEMALE', locale: 'en-US' } },
    gc_brit_butler:     { name: 'BritButler',      emoji: '🎤', engine: 'google-cloud', rarity: 'rare', tier: 3, cloudVoice: { name: 'en-GB-Standard-B', gender: 'MALE',   locale: 'en-GB' } },
    gc_lady_london:     { name: 'LadyLondon',      emoji: '🎤', engine: 'google-cloud', rarity: 'rare', tier: 3, cloudVoice: { name: 'en-GB-Standard-A', gender: 'FEMALE', locale: 'en-GB' } },
    gc_down_under:      { name: 'DownUnder',        emoji: '🎤', engine: 'google-cloud', rarity: 'rare', tier: 3, cloudVoice: { name: 'en-AU-Standard-B', gender: 'MALE',   locale: 'en-AU' } },
    gc_sheila:          { name: 'Sheila',           emoji: '🎤', engine: 'google-cloud', rarity: 'rare', tier: 3, cloudVoice: { name: 'en-AU-Standard-A', gender: 'FEMALE', locale: 'en-AU' } },
    gc_mumbai_mike:     { name: 'MumbaiMike',       emoji: '🎤', engine: 'google-cloud', rarity: 'rare', tier: 3, cloudVoice: { name: 'en-IN-Standard-B', gender: 'MALE',   locale: 'en-IN' } },
    gc_news_anchor:     { name: 'NewsAnchor',       emoji: '🎤', engine: 'google-cloud', rarity: 'rare', tier: 3, cloudVoice: { name: 'en-US-Standard-J', gender: 'MALE',   locale: 'en-US' } },
    gc_podcast_girl:    { name: 'PodcastGirl',      emoji: '🎤', engine: 'google-cloud', rarity: 'rare', tier: 3, cloudVoice: { name: 'en-US-Standard-H', gender: 'FEMALE', locale: 'en-US' } },
    // WaveNet
    gc_wave_daddy:      { name: 'WaveDaddy',        emoji: '🎵', engine: 'google-cloud', rarity: 'epic', tier: 4, cloudVoice: { name: 'en-US-Wavenet-D',  gender: 'MALE',   locale: 'en-US' } },
    gc_wave_queen:      { name: 'WaveQueen',        emoji: '🎵', engine: 'google-cloud', rarity: 'epic', tier: 4, cloudVoice: { name: 'en-US-Wavenet-F',  gender: 'FEMALE', locale: 'en-US' } },
    gc_wave_brit:       { name: 'WaveBrit',         emoji: '🎵', engine: 'google-cloud', rarity: 'epic', tier: 4, cloudVoice: { name: 'en-GB-Wavenet-B',  gender: 'MALE',   locale: 'en-GB' } },
    gc_wave_aussie:     { name: 'WaveAussie',       emoji: '🎵', engine: 'google-cloud', rarity: 'epic', tier: 4, cloudVoice: { name: 'en-AU-Wavenet-B',  gender: 'MALE',   locale: 'en-AU' } },
    // Neural2
    gc_neural_chad:     { name: 'NeuralChad',       emoji: '🧠', engine: 'google-cloud', rarity: 'epic', tier: 4, cloudVoice: { name: 'en-US-Neural2-D',  gender: 'MALE',   locale: 'en-US' } },
    gc_neural_diva:     { name: 'NeuralDiva',       emoji: '🧠', engine: 'google-cloud', rarity: 'epic', tier: 4, cloudVoice: { name: 'en-US-Neural2-F',  gender: 'FEMALE', locale: 'en-US' } },
    gc_neural_brit_f:   { name: 'NeuralLady',       emoji: '🧠', engine: 'google-cloud', rarity: 'epic', tier: 4, cloudVoice: { name: 'en-GB-Neural2-A',  gender: 'FEMALE', locale: 'en-GB' } },
    gc_neural_aussie_f: { name: 'NeuralSheila',     emoji: '🧠', engine: 'google-cloud', rarity: 'epic', tier: 4, cloudVoice: { name: 'en-AU-Neural2-A',  gender: 'FEMALE', locale: 'en-AU' } },
    // Studio
    gc_studio_m:        { name: 'StudioAlpha',       emoji: '🎙️', engine: 'google-cloud', rarity: 'legendary', tier: 5, cloudVoice: { name: 'en-US-Studio-Q',   gender: 'MALE',   locale: 'en-US' } },
    gc_studio_f:        { name: 'StudioDiva',        emoji: '🎙️', engine: 'google-cloud', rarity: 'legendary', tier: 5, cloudVoice: { name: 'en-US-Studio-O',   gender: 'FEMALE', locale: 'en-US' } },
    // Journey
    gc_journey_sage:    { name: 'JourneySage',       emoji: '🗺️', engine: 'google-cloud', rarity: 'mythic', tier: 6, cloudVoice: { name: 'en-US-Journey-D',  gender: 'MALE',   locale: 'en-US' } },
    gc_journey_oracle:  { name: 'JourneyOracle',     emoji: '🗺️', engine: 'google-cloud', rarity: 'mythic', tier: 6, cloudVoice: { name: 'en-US-Journey-F',  gender: 'FEMALE', locale: 'en-US' } },
    gc_journey_whisper: { name: 'JourneyWhisper',    emoji: '🗺️', engine: 'google-cloud', rarity: 'mythic', tier: 6, cloudVoice: { name: 'en-US-Journey-O',  gender: 'FEMALE', locale: 'en-US' } },

    // ── Amazon Polly voices ───────────────────────────────────
    // Standard
    pl_joanna_std:      { name: 'PollyJoanna',      emoji: '🎤', engine: 'amazon-polly', rarity: 'rare', tier: 3, pollyVoice: { voiceId: 'Joanna',   engine: 'standard', locale: 'en-US' } },
    pl_matthew_std:     { name: 'PollyMatt',         emoji: '🎤', engine: 'amazon-polly', rarity: 'rare', tier: 3, pollyVoice: { voiceId: 'Matthew',  engine: 'standard', locale: 'en-US' } },
    pl_amy_std:         { name: 'PollyAmy',          emoji: '🎤', engine: 'amazon-polly', rarity: 'rare', tier: 3, pollyVoice: { voiceId: 'Amy',      engine: 'standard', locale: 'en-GB' } },
    pl_brian_std:       { name: 'PollyBrian',        emoji: '🎤', engine: 'amazon-polly', rarity: 'rare', tier: 3, pollyVoice: { voiceId: 'Brian',    engine: 'standard', locale: 'en-GB' } },
    pl_olivia_std:      { name: 'PollyOlivia',       emoji: '🎤', engine: 'amazon-polly', rarity: 'rare', tier: 3, pollyVoice: { voiceId: 'Olivia',   engine: 'standard', locale: 'en-AU' } },
    pl_ivy_std:         { name: 'PollyIvy',          emoji: '🎤', engine: 'amazon-polly', rarity: 'rare', tier: 3, pollyVoice: { voiceId: 'Ivy',      engine: 'standard', locale: 'en-US' } },
    pl_joey_std:        { name: 'PollyJoey',         emoji: '🎤', engine: 'amazon-polly', rarity: 'rare', tier: 3, pollyVoice: { voiceId: 'Joey',     engine: 'standard', locale: 'en-US' } },
    pl_kendra_std:      { name: 'PollyKendra',       emoji: '🎤', engine: 'amazon-polly', rarity: 'rare', tier: 3, pollyVoice: { voiceId: 'Kendra',   engine: 'standard', locale: 'en-US' } },
    // Neural
    pl_joanna_neural:   { name: 'NeuralJoanna',     emoji: '🧠', engine: 'amazon-polly', rarity: 'epic', tier: 4, pollyVoice: { voiceId: 'Joanna',   engine: 'neural',   locale: 'en-US' } },
    pl_matthew_neural:  { name: 'NeuralMatt',        emoji: '🧠', engine: 'amazon-polly', rarity: 'epic', tier: 4, pollyVoice: { voiceId: 'Matthew',  engine: 'neural',   locale: 'en-US' } },
    pl_ruth_neural:     { name: 'NeuralRuth',        emoji: '🧠', engine: 'amazon-polly', rarity: 'epic', tier: 4, pollyVoice: { voiceId: 'Ruth',     engine: 'neural',   locale: 'en-US' } },
    pl_stephen_neural:  { name: 'NeuralStephen',     emoji: '🧠', engine: 'amazon-polly', rarity: 'epic', tier: 4, pollyVoice: { voiceId: 'Stephen',  engine: 'neural',   locale: 'en-US' } },
    pl_amy_neural:      { name: 'NeuralAmy',         emoji: '🧠', engine: 'amazon-polly', rarity: 'epic', tier: 4, pollyVoice: { voiceId: 'Amy',      engine: 'neural',   locale: 'en-GB' } },
    pl_arthur_neural:   { name: 'NeuralArthur',      emoji: '🧠', engine: 'amazon-polly', rarity: 'epic', tier: 4, pollyVoice: { voiceId: 'Arthur',   engine: 'neural',   locale: 'en-GB' } },
    pl_danielle_neural: { name: 'NeuralDanielle',    emoji: '🧠', engine: 'amazon-polly', rarity: 'epic', tier: 4, pollyVoice: { voiceId: 'Danielle', engine: 'neural',   locale: 'en-US' } },
    pl_gregory_neural:  { name: 'NeuralGregory',     emoji: '🧠', engine: 'amazon-polly', rarity: 'epic', tier: 4, pollyVoice: { voiceId: 'Gregory',  engine: 'neural',   locale: 'en-US' } },
    pl_kevin_neural:    { name: 'NeuralKevin',       emoji: '🧠', engine: 'amazon-polly', rarity: 'epic', tier: 4, pollyVoice: { voiceId: 'Kevin',    engine: 'neural',   locale: 'en-US' } },
    // Long-form
    pl_danielle_long:   { name: 'LongDanielle',     emoji: '📖', engine: 'amazon-polly', rarity: 'legendary', tier: 5, pollyVoice: { voiceId: 'Danielle', engine: 'long-form', locale: 'en-US' } },
    pl_gregory_long:    { name: 'LongGregory',      emoji: '📖', engine: 'amazon-polly', rarity: 'legendary', tier: 5, pollyVoice: { voiceId: 'Gregory',  engine: 'long-form', locale: 'en-US' } },
    pl_ruth_long:       { name: 'LongRuth',         emoji: '📖', engine: 'amazon-polly', rarity: 'legendary', tier: 5, pollyVoice: { voiceId: 'Ruth',     engine: 'long-form', locale: 'en-US' } },
    // Generative
    pl_matthew_gen:     { name: 'GenMatt',           emoji: '🌟', engine: 'amazon-polly', rarity: 'mythic', tier: 6, pollyVoice: { voiceId: 'Matthew',  engine: 'generative', locale: 'en-US' } },
    pl_ruth_gen:        { name: 'GenRuth',           emoji: '🌟', engine: 'amazon-polly', rarity: 'mythic', tier: 6, pollyVoice: { voiceId: 'Ruth',     engine: 'generative', locale: 'en-US' } },

    // ── Browser-only voices (Self TTS — no server synthesis) ──
    voice_default:  { name: 'Default',    emoji: '🔊', engine: 'browser', rarity: 'common', tier: 0, browserVoice: { pitch: 1.0, rate: 1.0 } },
    voice_deep:     { name: 'Deep',       emoji: '🎵', engine: 'browser', rarity: 'common', tier: 1, browserVoice: { pitch: 0.6, rate: 0.9 } },
    voice_chipmunk: { name: 'Chipmunk',   emoji: '🐿️', engine: 'browser', rarity: 'common', tier: 1, browserVoice: { pitch: 1.8, rate: 1.3 } },
    voice_robot:    { name: 'Robot',      emoji: '🤖', engine: 'browser', rarity: 'common', tier: 2, browserVoice: { pitch: 0.8, rate: 1.0 } },
    voice_whisper:  { name: 'Whisper',    emoji: '🤫', engine: 'browser', rarity: 'common', tier: 2, browserVoice: { pitch: 1.1, rate: 0.7 } },
    voice_demon:    { name: 'Demon',      emoji: '😈', engine: 'browser', rarity: 'uncommon', tier: 3, browserVoice: { pitch: 0.3, rate: 0.6 } },
};

// ── Rarity colors ─────────────────────────────────────────────
const RARITY_COLORS = {
    common:    '#aaaaaa',
    uncommon:  '#44ff44',
    rare:      '#4488ff',
    epic:      '#aa44ff',
    legendary: '#ff8800',
    mythic:    '#ff2222',
};

// ── TTS Settings Cache ────────────────────────────────────────
let _settingsCache = null;
let _settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 30_000; // 30s

function getTTSSettings() {
    const now = Date.now();
    if (_settingsCache && (now - _settingsCacheTime) < SETTINGS_CACHE_TTL) return _settingsCache;
    _settingsCache = {
        enabled:               db.getSetting('tts_enabled') !== false,
        provider:              db.getSetting('tts_provider') || 'espeak-ng',
        googleApiKey:          db.getSetting('tts_google_api_key') || '',
        googleServiceAccount:  db.getSetting('tts_google_service_account') || '',
        awsAccessKeyId:        db.getSetting('tts_aws_access_key_id') || '',
        awsSecretAccessKey:    db.getSetting('tts_aws_secret_access_key') || '',
        awsRegion:             db.getSetting('tts_aws_region') || 'us-east-1',
        maxLength:             db.getSetting('tts_max_length') || 200,
        maxQueuePerUser:       db.getSetting('tts_max_queue_per_user') || 3,
        maxQueueGlobal:        db.getSetting('tts_max_queue_global') || 20,
        defaultVoice:          db.getSetting('tts_default_voice') || 'gary',
        // When true (default), chatters without an equipped voice cosmetic get a
        // stable per-username espeak voice so the streamer can tell who is who.
        perUserVoices:         db.getSetting('tts_per_user_voices') !== false,
    };
    _settingsCacheTime = now;
    return _settingsCache;
}

// ── Per-user deterministic voice derivation ───────────────────
// Subtle base espeak voices that stay natural/intelligible (no croak/whisper).
const PER_USER_BASE_VOICES = [
    'en', 'en+m1', 'en+m2', 'en+m3', 'en+m4', 'en+m5', 'en+m6', 'en+m7',
    'en+f1', 'en+f2', 'en+f3', 'en+f4', 'en+f5',
];

/**
 * Derive a stable, subtly-randomized espeak voice from an identity key
 * (username / anon id / relay handle). Same key → same voice everywhere on the
 * site, so viewers are recognizable by voice. Params stay in intelligible bands.
 * @param {string} identityKey
 * @returns {{ voice: string, pitch: number, speed: number, gap: number }}
 */
// Espeak-safe bounds for admin-tunable voice params.
const VOICE_BOUNDS = { pitch: [0, 99], speed: [80, 450], gap: [0, 20] };
function _clampVoiceParams(p) {
    const voices = new Set(PER_USER_BASE_VOICES);
    const voice = (typeof p.voice === 'string' && /^[a-z0-9+._-]{1,24}$/i.test(p.voice)) ? p.voice : 'en';
    const clamp = (v, [lo, hi], d) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
    return {
        voice: voice, // allow any valid-looking espeak voice string (incl. catalog voices like en+f3)
        pitch: clamp(p.pitch, VOICE_BOUNDS.pitch, 50),
        speed: clamp(p.speed, VOICE_BOUNDS.speed, 165),
        gap: clamp(p.gap, VOICE_BOUNDS.gap, 0),
        _voiceInList: voices.has(voice),
    };
}
// The pure hash-derived (auto-assigned) voice — no override lookup.
function autoUserVoiceParams(identityKey) {
    const key = String(identityKey || 'anon').trim().toLowerCase() || 'anon';
    const h = crypto.createHash('sha256').update(key).digest();
    // Distinct byte slices → weakly independent axes.
    const voice = PER_USER_BASE_VOICES[h[0] % PER_USER_BASE_VOICES.length];
    const pitch = 30 + (h[1] % 46);   // 30..75  (default 50)
    const speed = 150 + (h[2] % 41);  // 150..190 wpm (natural range)
    const gap = h[3] % 4;             // 0..3    (subtle cadence variation)
    return { voice, pitch, speed, gap };
}
function deriveUserVoiceParams(identityKey) {
    const key = String(identityKey || 'anon').trim().toLowerCase() || 'anon';
    // An admin-set override wins over the auto-assigned voice.
    try { const ov = db.getTtsVoiceOverride(key); if (ov && ov.voice) return _clampVoiceParams(ov); } catch { /* fall through to auto */ }
    return autoUserVoiceParams(key);
}

/**
 * Synthesize a chat line using a per-user derived espeak voice.
 * @returns Promise resolving to the same shape as synthesize(), or null.
 */
async function synthesizeUserVoice(text, identityKey, username, maxLengthOverride) {
    const settings = getTTSSettings();
    if (!settings.enabled) return null;
    // A channel may raise its TTS length above the site default (hard-capped at 1200).
    const effMax = Math.min(1200, Math.max(1, Number(maxLengthOverride) || settings.maxLength));
    const cleanText = sanitize(text, effMax, username);
    if (!cleanText) return null;
    const params = deriveUserVoiceParams(identityKey);
    const voiceDef = { engine: 'espeak-ng', params, name: `Voice-${params.voice}` };
    // Use a synthetic voiceId so the client can distinguish auto voices if needed.
    return _synthesizeWithDef(cleanText, voiceDef, `auto:${params.voice}`);
}

/** Invalidate settings cache (call after admin updates) */
function invalidateSettingsCache() {
    _settingsCache = null;
    _settingsCacheTime = 0;
}

// ── espeak-ng Detection ───────────────────────────────────────
let _espeakBinary = null;
let _espeakDetected = false;

function detectEspeak() {
    if (_espeakDetected) return _espeakBinary;
    _espeakDetected = true;
    for (const bin of ['espeak-ng', 'espeak']) {
        try {
            execFileSync(bin, ['--version'], { timeout: 3000, encoding: 'utf8' });
            _espeakBinary = bin;
            console.log(`[TTS] Detected ${bin}`);
            return bin;
        } catch { /* try next */ }
    }
    console.warn('[TTS] espeak-ng not found — espeak voices will be unavailable');
    return null;
}

// ── Google Cloud TTS ──────────────────────────────────────────
let _googleAccessToken = null;
let _googleTokenExpiry = 0;

function _getGoogleServiceAccount(settings) {
    const raw = settings.googleServiceAccount;
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        // Try as file path
        try { return JSON.parse(fs.readFileSync(raw, 'utf8')); } catch { return null; }
    }
}

function _getGoogleAccessToken(sa) {
    return new Promise((resolve, reject) => {
        const now = Math.floor(Date.now() / 1000);
        if (_googleAccessToken && now < _googleTokenExpiry - 300) {
            return resolve(_googleAccessToken);
        }
        // Build JWT
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
        const claim = Buffer.from(JSON.stringify({
            iss: sa.client_email,
            scope: 'https://www.googleapis.com/auth/cloud-platform',
            aud: 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: now + 3600,
        })).toString('base64url');
        const sig = crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(sa.private_key, 'base64url');
        const jwt = `${header}.${claim}.${sig}`;

        const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
        const req = https.request('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    _googleAccessToken = parsed.access_token;
                    _googleTokenExpiry = now + (parsed.expires_in || 3600);
                    resolve(_googleAccessToken);
                } catch (e) { reject(new Error('Google token parse error')); }
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

function synthesizeGoogleCloud(text, voiceDef) {
    return new Promise(async (resolve, reject) => {
        const settings = getTTSSettings();
        const sa = _getGoogleServiceAccount(settings);
        const apiKey = settings.googleApiKey;
        if (!sa && !apiKey) return reject(new Error('Google Cloud TTS not configured'));

        const cv = voiceDef.cloudVoice;
        const requestBody = JSON.stringify({
            input: { text },
            voice: { languageCode: cv.locale, name: cv.name, ssmlGender: cv.gender },
            audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0, pitch: 0.0 },
        });

        let headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) };
        let url = 'https://texttospeech.googleapis.com/v1/text:synthesize';

        if (sa) {
            try {
                const token = await _getGoogleAccessToken(sa);
                headers['Authorization'] = `Bearer ${token}`;
            } catch (e) { return reject(e); }
        } else {
            url += `?key=${apiKey}`;
        }

        const req = https.request(url, { method: 'POST', headers }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.audioContent) {
                        resolve({ audio: parsed.audioContent, mimeType: 'audio/mpeg', engine: 'google-cloud', voiceName: cv.name });
                    } else {
                        reject(new Error(parsed.error?.message || 'Google TTS returned no audio'));
                    }
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.end(requestBody);
    });
}

// ── Amazon Polly ──────────────────────────────────────────────
function _awsSign({ method, service, region, path: urlPath, body, headers: extraHeaders }) {
    const settings = getTTSSettings();
    const accessKey = settings.awsAccessKeyId;
    const secretKey = settings.awsSecretAccessKey;
    if (!accessKey || !secretKey) throw new Error('AWS credentials not configured');

    const now = new Date();
    const dateStamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 8);
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const host = `${service}.${region}.amazonaws.com`;

    const headers = {
        'Host': host,
        'X-Amz-Date': amzDate,
        'Content-Type': 'application/json',
        ...extraHeaders,
    };

    const signedHeaderKeys = Object.keys(headers).map(k => k.toLowerCase()).sort().join(';');
    const canonicalHeaders = Object.keys(headers).map(k => `${k.toLowerCase()}:${headers[k].trim()}`).sort().join('\n') + '\n';
    const payloadHash = crypto.createHash('sha256').update(body || '').digest('hex');

    const canonicalRequest = [method, urlPath, '', canonicalHeaders, signedHeaderKeys, payloadHash].join('\n');
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope,
        crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');

    const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), service), 'aws4_request');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaderKeys}, Signature=${signature}`;
    return { host, headers };
}

function synthesizePolly(text, voiceDef) {
    return new Promise((resolve, reject) => {
        const settings = getTTSSettings();
        const pv = voiceDef.pollyVoice;

        let bodyObj = {
            OutputFormat: 'mp3',
            Text: text,
            TextType: 'text',
            VoiceId: pv.voiceId,
            Engine: pv.engine,
        };
        if (pv.locale) bodyObj.LanguageCode = pv.locale;
        const body = JSON.stringify(bodyObj);

        let signed;
        try {
            signed = _awsSign({
                method: 'POST', service: 'polly', region: settings.awsRegion,
                path: '/v1/speech', body,
            });
        } catch (e) { return reject(e); }

        const req = https.request({
            hostname: signed.host,
            path: '/v1/speech',
            method: 'POST',
            headers: { ...signed.headers, 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                if (res.statusCode === 200) {
                    resolve({ audio: buf.toString('base64'), mimeType: 'audio/mpeg', engine: 'amazon-polly', voiceName: pv.voiceId });
                } else {
                    reject(new Error(`Polly HTTP ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

// ── espeak-ng WAV synthesis ───────────────────────────────────
function synthesizeEspeak(text, voiceDef) {
    return new Promise((resolve, reject) => {
        const bin = detectEspeak();
        if (!bin) return reject(new Error('espeak-ng not installed'));

        const p = voiceDef.params || {};
        const tmpFile = path.join(os.tmpdir(), `openvibe-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
        const args = ['-v', p.voice || 'en', '-w', tmpFile];
        if (p.pitch != null) args.push('-p', String(p.pitch));
        if (p.speed != null) args.push('-s', String(p.speed));
        if (p.gap != null) args.push('-g', String(p.gap));
        args.push('--', text);

        execFile(bin, args, { timeout: 10000 }, (err) => {
            if (err) {
                try { fs.unlinkSync(tmpFile); } catch {}
                return reject(err);
            }
            try {
                const wav = fs.readFileSync(tmpFile);
                fs.unlinkSync(tmpFile);
                resolve({ audio: wav.toString('base64'), mimeType: 'audio/wav', engine: 'espeak-ng', voiceName: p.voice });
            } catch (e) { reject(e); }
        });
    });
}

// ── Sanitize text ─────────────────────────────────────────────
/**
 * Replace URLs with TTS-friendly descriptions.
 * "check youtube.com/watch?v=abc" → "check (link to youtube)"
 */
// Common gTLDs; every 2-letter TLD is accepted as a country code. Mirrors chat-shared.js.
const _TTS_TLDS = new Set('com net org io co gg tv me app dev xyz info biz live tech online site store blog news wiki gov edu mil int tools quest link click stream fm to ly gl sh cc ws pro club shop art design games game media cloud email fun life world today space website host page video chat social band lol wtf money'.split(/\s+/));
function _realTld(tld) { tld = String(tld || '').toLowerCase(); return tld.length === 2 || _TTS_TLDS.has(tld); }
// Shorten a username for speech: collapse long same-character runs ("WWWW…" → "W") and cap length.
function ttsUsername(name) {
    if (!name) return name;
    let n = String(name).replace(/(.)\1{3,}/g, '$1');
    if (n.length > 18) n = n.slice(0, 18);
    return n;
}
/**
 * Replace only REAL links with a spoken description; leave non-link text (typos like
 * "I.gkt" whose ".gkt" is not a real TLD) untouched so TTS doesn't announce fake links.
 */
function replaceUrlsForTTS(text, username) {
    const uname = ttsUsername(username);
    return String(text == null ? '' : text).replace(
        /((?:https?:\/\/)?(?:www\.)?)([a-z0-9][-a-z0-9]*(?:\.[a-z]{2,})+)([^\s]*)/gi,
        (match, pre, domain) => {
            const hasScheme = /https?:\/\//i.test(pre) || /^www\./i.test(pre);
            const parts = domain.split('.');
            if (!hasScheme && !_realTld(parts[parts.length - 1])) return match; // not a real link
            const siteName = parts.length > 2 ? parts[parts.length - 2] : parts[0];
            return uname ? `(${uname} sent a link to ${siteName})` : `(link to ${siteName})`;
        }
    );
}

function sanitize(text, maxLen, username) {
    let clean = String(text || '').replace(/[<>]/g, '').replace(/[\x00-\x1f]/g, ' ').trim();
    clean = replaceUrlsForTTS(clean, username);
    if (maxLen && clean.length > maxLen) clean = clean.slice(0, maxLen);
    return clean;
}

// ── Main synthesis function ───────────────────────────────────
/**
 * Synthesize TTS audio for a chat message.
 * @param {string} text - The text to speak
 * @param {string} [voiceId] - Voice ID from VOICE_CATALOG (defaults to site setting)
 * @param {string} [username] - Username for link replacement context
 * @returns {Promise<{audio: string, mimeType: string, engine: string, voiceName: string, voiceId: string} | null>}
 *   Returns null if TTS is disabled or voice is browser-only
 */
async function synthesize(text, voiceId, username, maxLengthOverride) {
    const settings = getTTSSettings();
    if (!settings.enabled) return null;

    // A channel may raise its TTS length above the site default (hard-capped at 1200).
    const effMax = Math.min(1200, Math.max(1, Number(maxLengthOverride) || settings.maxLength));
    const cleanText = sanitize(text, effMax, username);
    if (!cleanText) return null;

    const vid = voiceId || settings.defaultVoice;
    const voiceDef = VOICE_CATALOG[vid];
    if (!voiceDef) {
        // Fallback to default
        const fallback = VOICE_CATALOG[settings.defaultVoice] || VOICE_CATALOG.gary;
        return _synthesizeWithDef(cleanText, fallback, settings.defaultVoice);
    }

    return _synthesizeWithDef(cleanText, voiceDef, vid);
}

async function _synthesizeWithDef(text, voiceDef, voiceId) {
    const settings = getTTSSettings();

    // "Browser" voices were designed for client-side Web Speech synthesis, but this
    // pipeline renders TTS server-side and broadcasts the audio — so a browser voice
    // produced no sound at all. Render them with espeak instead, mapping the Web Speech
    // pitch (0–2, 1=normal) and rate (~0.1–10, 1=normal) onto espeak's pitch/speed.
    if (voiceDef.engine === 'browser') {
        const bv = voiceDef.browserVoice || {};
        const espeakDef = {
            engine: 'espeak-ng',
            name: voiceDef.name,
            params: {
                voice: bv.voice || 'en',
                pitch: Math.max(0, Math.min(99, Math.round((bv.pitch != null ? bv.pitch : 1) * 50))),
                speed: Math.max(80, Math.min(400, Math.round((bv.rate != null ? bv.rate : 1) * 175))),
            },
        };
        try {
            return { ...(await synthesizeEspeak(text, espeakDef)), voiceId };
        } catch (err) {
            console.error(`[TTS] Browser-voice espeak render failed (${voiceId}):`, err.message);
            return null;
        }
    }

    try {
        switch (voiceDef.engine) {
            case 'google-cloud': {
                if (!settings.googleApiKey && !settings.googleServiceAccount) {
                    // Fall back to espeak
                    return _espeakFallback(text, voiceId);
                }
                return { ...(await synthesizeGoogleCloud(text, voiceDef)), voiceId };
            }
            case 'amazon-polly': {
                if (!settings.awsAccessKeyId) {
                    return _espeakFallback(text, voiceId);
                }
                return { ...(await synthesizePolly(text, voiceDef)), voiceId };
            }
            case 'espeak-ng':
                return { ...(await synthesizeEspeak(text, voiceDef)), voiceId };
            default:
                return _espeakFallback(text, voiceId);
        }
    } catch (err) {
        console.error(`[TTS] Synthesis error (${voiceDef.engine}/${voiceId}):`, err.message);
        // Try espeak fallback on cloud failure
        if (voiceDef.engine !== 'espeak-ng') {
            try { return _espeakFallback(text, voiceId); } catch {}
        }
        return null;
    }
}

function _espeakFallback(text, voiceId) {
    const fallbackDef = VOICE_CATALOG.gary;
    return synthesizeEspeak(text, fallbackDef).then(result => ({ ...result, voiceId, fallback: true }));
}

// ── Queue System (per-stream) ─────────────────────────────────
// TTS queue is managed per-stream in the chat server.
// This module just provides the max limits.
function getQueueLimits() {
    const settings = getTTSSettings();
    return {
        maxGlobal: settings.maxQueueGlobal,
        maxPerUser: settings.maxQueuePerUser,
        maxLength: settings.maxLength,
    };
}

// ── Available voices for a given configuration ────────────────
function getAvailableVoices() {
    const settings = getTTSSettings();
    const voices = [];
    for (const [id, v] of Object.entries(VOICE_CATALOG)) {
        let available = true;
        if (v.engine === 'google-cloud' && !settings.googleApiKey && !settings.googleServiceAccount) {
            available = false;
        }
        if (v.engine === 'amazon-polly' && !settings.awsAccessKeyId) {
            available = false;
        }
        if (v.engine === 'espeak-ng' && !detectEspeak()) {
            available = false;
        }
        voices.push({ id, ...v, available });
    }
    return voices;
}

// ── Exports ───────────────────────────────────────────────────
// Synthesize an arbitrary espeak param set (admin voice preview).
async function synthesizeWithParams(text, params) {
    const p = _clampVoiceParams(params || {});
    const voiceDef = { engine: 'espeak-ng', params: p, name: `Voice-${p.voice}` };
    return _synthesizeWithDef(sanitize(text, getTTSSettings().maxLength, null), voiceDef, `preview:${p.voice}`);
}

module.exports = {
    VOICE_CATALOG,
    RARITY_COLORS,
    synthesize,
    synthesizeUserVoice,
    synthesizeWithParams,
    deriveUserVoiceParams,
    autoUserVoiceParams,
    clampVoiceParams: _clampVoiceParams,
    PER_USER_BASE_VOICES,
    VOICE_BOUNDS,
    sanitize,
    getTTSSettings,
    invalidateSettingsCache,
    getQueueLimits,
    getAvailableVoices,
    detectEspeak,
};
