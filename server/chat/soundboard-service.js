const https = require('https');
const http = require('http');
const dns = require('dns');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');

const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'soundboard-cache');
const CACHE_TTL_MS = 15 * 60 * 1000;
const URL_REGEX = /(?:https?:\/\/)?(?:www\.)?101soundboards\.com\/sounds\/(\d+)(?:[-\w/?#=&.]*)/i;
const CMD_REGEX = /^!sb\s+(.+)$/i;
const SOUND_URL_PREFIX = 'https://www.101soundboards.com/sounds/';

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function centsToRate(cents) {
    return Math.pow(2, cents / 1200);
}

async function ensureCacheDirAsync() {
    await fs.promises.mkdir(CACHE_DIR, { recursive: true }).catch((err) => {
        if (err.code !== 'EEXIST') throw err;
    });
}

function getCachePaths(soundId) {
    return {
        audio: path.join(CACHE_DIR, `${soundId}.mp3`),
        meta: path.join(CACHE_DIR, `${soundId}.json`),
    };
}

async function getCachedSoundAsync(soundId) {
    const paths = getCachePaths(soundId);
    try {
        const stat = await fs.promises.stat(paths.audio);
        if ((Date.now() - stat.mtimeMs) > CACHE_TTL_MS) {
            try { await fs.promises.unlink(paths.audio); } catch {}
            try { await fs.promises.unlink(paths.meta); } catch {}
            return null;
        }
        const audio = await fs.promises.readFile(paths.audio);
        let meta = {};
        try { meta = JSON.parse(await fs.promises.readFile(paths.meta, 'utf8')); } catch {}
        return {
            audio,
            mimeType: meta.mimeType || 'audio/mpeg',
            title: meta.title || `Sound ${soundId}`,
            sourceUrl: meta.sourceUrl || `${SOUND_URL_PREFIX}${soundId}`,
        };
    } catch {
        return null;
    }
}

async function writeCachedSoundAsync(soundId, audioBuffer, meta = {}) {
    const paths = getCachePaths(soundId);
    const tmpAudio = paths.audio + '.tmp';
    const tmpMeta = paths.meta + '.tmp';
    try {
        await fs.promises.writeFile(tmpAudio, audioBuffer);
        await fs.promises.rename(tmpAudio, paths.audio);
        await fs.promises.writeFile(tmpMeta, JSON.stringify({
            mimeType: meta.mimeType || 'audio/mpeg',
            title: meta.title || `Sound ${soundId}`,
            sourceUrl: meta.sourceUrl || `${SOUND_URL_PREFIX}${soundId}`,
        }));
        await fs.promises.rename(tmpMeta, paths.meta);
    } catch (err) {
        console.error('[Soundboard] Cache write error:', err.message);
        try { await fs.promises.unlink(tmpAudio); } catch {}
        try { await fs.promises.unlink(tmpMeta); } catch {}
    }
}

function extractSoundId(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const urlMatch = text.match(URL_REGEX);
    if (urlMatch) return urlMatch[1];
    const idMatch = text.match(/^(\d{2,})$/);
    if (idMatch) return idMatch[1];
    return null;
}

function normalizeBannedIds(value) {
    if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
    return String(value || '')
        .split(/[\s,\n\r]+/)
        .map((item) => extractSoundId(item) || String(item || '').trim())
        .filter(Boolean);
}

function parseModifiers(tokens, options = {}) {
    const settings = {
        allowPitch: options.allowPitch !== false,
        allowSpeed: options.allowSpeed !== false,
        minSpeed: Number.isFinite(options.minSpeed) ? options.minSpeed : 0.5,
        maxSpeed: Number.isFinite(options.maxSpeed) ? options.maxSpeed : 3.0,
        minPitch: Number.isFinite(options.minPitch) ? options.minPitch : 0.5,   // rate
        maxPitch: Number.isFinite(options.maxPitch) ? options.maxPitch : 2.0,   // rate
    };
    // Pitch is expressed in "units": +100 = one octave up (2×), -100 = one octave
    // down (0.5×), 0 = unchanged. This is an INDEPENDENT pitch shift (applied via a
    // real pitch shifter on the client) so it combines with speed, e.g. "2 100p" =
    // 2× speed AND pitch up. Derive the allowed unit range from the channel's
    // pitch-rate limits (rate = 2^(units/100)).
    const minUnits = 100 * Math.log2(settings.minPitch);
    const maxUnits = 100 * Math.log2(settings.maxPitch);
    const result = {
        pitch: 1,       // rate multiplier (back-compat / display)
        speed: 1,
        pitchShift: 0,  // pitch units in [-100, 100]-ish (clamped to channel range)
    };

    for (const rawToken of tokens) {
        const token = String(rawToken || '').trim().toLowerCase();
        if (!token) continue;

        const pitchToken = token.match(/^([+-]?\d+(?:\.\d+)?)p$/i);
        if (pitchToken && settings.allowPitch) {
            const raw = parseFloat(pitchToken[1]);
            if (Number.isFinite(raw)) {
                result.pitchShift = clamp(raw, minUnits, maxUnits);
                result.pitch = Math.pow(2, result.pitchShift / 100);
            }
            continue;
        }

        const speedToken = token.match(/^([0-9]*\.?[0-9]+)s$/i);
        if (speedToken && settings.allowSpeed) {
            const raw = parseFloat(speedToken[1]);
            if (Number.isFinite(raw)) result.speed = clamp(raw, settings.minSpeed, settings.maxSpeed);
            continue;
        }

        if (/^[0-9]*\.?[0-9]+$/.test(token) && settings.allowSpeed) {
            const raw = parseFloat(token);
            if (Number.isFinite(raw)) result.speed = clamp(raw, settings.minSpeed, settings.maxSpeed);
        }
    }

    return result;
}

function parseSoundboardMessage(text, options = {}) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;

    const cmdMatch = trimmed.match(CMD_REGEX);
    if (cmdMatch) {
        const args = cmdMatch[1].trim().split(/\s+/).filter(Boolean);
        const target = args.shift();
        const soundId = extractSoundId(target);
        if (!soundId) return null;
        const mods = parseModifiers(args, options);
        return {
            soundId,
            ...mods,
            sourceUrl: `${SOUND_URL_PREFIX}${soundId}`,
            original: trimmed,
        };
    }

    const urlMatch = trimmed.match(URL_REGEX);
    if (!urlMatch) return null;
    const soundId = urlMatch[1];
    const afterUrl = trimmed.slice(urlMatch.index + urlMatch[0].length).trim();
    const mods = parseModifiers(afterUrl ? afterUrl.split(/\s+/) : [], options);
    return {
        soundId,
        ...mods,
        sourceUrl: `${SOUND_URL_PREFIX}${soundId}`,
        original: trimmed,
    };
}

function findBestAudioUrl(value) {
    let best = null;

    function visit(node) {
        if (best) return;
        if (!node) return;
        if (typeof node === 'string') {
            const candidate = node.match(/https?:\/\/[^\s"'<>]+\.(?:mp3|mpeg|wav|ogg)(?:\?[^\s"'<>]*)?/i);
            if (candidate) best = candidate[0];
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) visit(item);
            return;
        }
        if (typeof node === 'object') {
            for (const [key, item] of Object.entries(node)) {
                if (!best && /url|audio|file|src|stream/i.test(key) && typeof item === 'string') visit(item);
                if (!best) visit(item);
            }
        }
    }

    visit(value);
    return best;
}

function findBestTitle(value, soundId) {
    const candidates = [];

    function visit(node, keyHint = '') {
        if (!node) return;
        if (typeof node === 'string') {
            const clean = node.trim();
            if (!clean || /^https?:\/\//i.test(clean)) return;
            if (/^(sound|audio)\s*\d+$/i.test(clean)) return;
            if (/title|name|label|sound/i.test(keyHint)) candidates.push(clean);
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) visit(item, keyHint);
            return;
        }
        if (typeof node === 'object') {
            for (const [key, item] of Object.entries(node)) visit(item, key);
        }
    }

    visit(value);
    return candidates[0] || `Sound ${soundId}`;
}

function isPrivateIp(addr) {
    const parts = addr.split('.');
    if (parts.length === 4) {
        const [a, b] = parts.map(Number);
        if (a === 127) return true;                        // 127.0.0.0/8 loopback
        if (a === 10) return true;                         // 10.0.0.0/8
        if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
        if (a === 192 && b === 168) return true;           // 192.168.0.0/16
        if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local
        if (a === 0) return true;                          // 0.0.0.0/8
    }
    if (addr === '::1') return true;                       // IPv6 loopback
    if (/^(fc|fd)/i.test(addr)) return true;               // fc00::/7 unique local
    if (/^fe80:/i.test(addr)) return true;                 // IPv6 link-local
    return false;
}

async function validateAudioUrl(audioUrl) {
    let parsed;
    try { parsed = new URL(audioUrl); } catch {
        throw new Error('Invalid audio URL from 101soundboards API');
    }
    if (parsed.protocol !== 'https:') throw new Error('Audio URL must use HTTPS');
    const host = parsed.hostname.toLowerCase();
    const ALLOWED = ['101soundboards.com'];
    if (!ALLOWED.some((s) => host === s || host.endsWith('.' + s))) {
        throw new Error('Audio URL host is not permitted');
    }
    const { address } = await dns.promises.lookup(host).catch(() => {
        throw new Error('Audio URL host could not be resolved');
    });
    if (isPrivateIp(address)) throw new Error('Audio URL resolved to a restricted IP address');
}

async function fetchJsonWithRetry(url, retries = 2) {
    let lastErr;
    let delay = 500;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, { headers: { 'User-Agent': 'OpenVibe.Live/1.0' } });
            if (response.status === 429) {
                const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
                const waitMs = retryAfter > 0 ? retryAfter * 1000 : delay;
                if (attempt < retries) { await new Promise((r) => setTimeout(r, waitMs)); delay *= 3; continue; }
                throw new Error('101soundboards is temporarily rate-limited, try again shortly');
            }
            if (!response.ok) {
                if (response.status >= 400 && response.status < 500) throw new Error(`HTTP ${response.status}`);
                lastErr = new Error(`HTTP ${response.status}`);
                if (attempt < retries) { await new Promise((r) => setTimeout(r, delay)); delay *= 3; continue; }
                throw lastErr;
            }
            return response.json();
        } catch (err) {
            if (/rate-limited|HTTP 4/.test(err.message)) throw err;
            lastErr = err;
            if (attempt < retries) { await new Promise((r) => setTimeout(r, delay)); delay *= 3; }
        }
    }
    throw lastErr || new Error('101soundboards is temporarily unavailable, try again later');
}

function fetchSoundTitleHtml(soundId) {
    return new Promise((resolve) => {
        const req = https.get(`${SOUND_URL_PREFIX}${soundId}`, { headers: { 'User-Agent': 'OpenVibe.Live/1.0' } }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return resolve(`Sound ${soundId}`);
            }
            let html = '';
            res.on('data', (chunk) => { html += chunk; });
            res.on('end', () => {
                const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
                const og = html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
                resolve((h1?.[1] || og?.[1] || `Sound ${soundId}`).trim());
            });
        });
        req.on('error', () => resolve(`Sound ${soundId}`));
        req.setTimeout(5000, () => { req.destroy(); resolve(`Sound ${soundId}`); });
    });
}

function downloadAudio(audioUrl) {
    return new Promise((resolve) => {
        const req = https.get(audioUrl, { headers: { 'User-Agent': 'OpenVibe.Live/1.0' } }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return resolve(null);
            }
            const chunks = [];
            let size = 0;
            const MAX_SIZE = 5 * 1024 * 1024;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_SIZE) {
                    res.destroy();
                    return resolve(null);
                }
                chunks.push(chunk);
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', () => resolve(null));
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    });
}

async function fetchSoundboardMeta(soundId) {
    const apiKey = String(db.getSetting('soundboard_101_api_key') || '').trim();
    if (!apiKey) throw new Error('101soundboards API key is not configured');

    const payload = await fetchJsonWithRetry(`${SOUND_URL_PREFIX}${soundId}/streamers?key=${encodeURIComponent(apiKey)}`);
    const audioUrl = findBestAudioUrl(payload);
    if (!audioUrl) throw new Error('No streamable audio URL found for this sound');
    await validateAudioUrl(audioUrl);
    let title = findBestTitle(payload, soundId);
    if (!title || /^sound\s+\d+$/i.test(title)) title = await fetchSoundTitleHtml(soundId);
    return {
        audioUrl,
        title,
        sourceUrl: `${SOUND_URL_PREFIX}${soundId}`,
        mimeType: 'audio/mpeg',
    };
}

const pendingDownloads = new Map();

async function getSoundboardAudio(soundId) {
    await ensureCacheDirAsync();

    const cached = await getCachedSoundAsync(soundId);
    if (cached) {
        return {
            audio: cached.audio.toString('base64'),
            mimeType: cached.mimeType,
            title: cached.title,
            soundId,
            sourceUrl: cached.sourceUrl,
        };
    }

    // Deduplicate concurrent downloads for the same soundId
    if (pendingDownloads.has(soundId)) return pendingDownloads.get(soundId);

    const downloadPromise = (async () => {
        const meta = await fetchSoundboardMeta(soundId);
        const audioBuffer = await downloadAudio(meta.audioUrl);
        if (!audioBuffer || audioBuffer.length < 100) throw new Error('Failed to download soundboard audio');
        await writeCachedSoundAsync(soundId, audioBuffer, meta);
        return {
            audio: audioBuffer.toString('base64'),
            mimeType: meta.mimeType,
            title: meta.title,
            soundId,
            sourceUrl: meta.sourceUrl,
        };
    })().finally(() => pendingDownloads.delete(soundId));

    pendingDownloads.set(soundId, downloadPromise);
    return downloadPromise;
}

function isConfigured() {
    return !!String(db.getSetting('soundboard_101_api_key') || '').trim();
}

async function cleanupCache() {
    try {
        const now = Date.now();
        const files = await fs.promises.readdir(CACHE_DIR);
        await Promise.all(files.map(async (file) => {
            const full = path.join(CACHE_DIR, file);
            try {
                const stat = await fs.promises.stat(full);
                if ((now - stat.mtimeMs) > CACHE_TTL_MS) await fs.promises.unlink(full);
            } catch {}
        }));
    } catch {}
}

cleanupCache().catch(() => {});

module.exports = {
    parseSoundboardMessage,
    parseModifiers,
    getSoundboardAudio,
    isConfigured,
    cleanupCache,
    normalizeBannedIds,
    extractSoundId,
    URL_REGEX,
    CMD_REGEX,
};