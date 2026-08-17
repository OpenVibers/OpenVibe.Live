/**
 * Media Downloader — Server-side yt-dlp media extraction & proxy
 *
 * Uses yt-dlp to:
 *   1. Fetch metadata (title, duration, thumbnail) for validation
 *   2. Extract direct stream URLs for playback
 *   3. Download files for buffered playback when streaming fails
 *
 * Inspired by RS-Companion MediaPlayer's multi-strategy extraction.
 */

const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Lazy DB reference — avoids require-time circular issues
let _db = null;
function getDb() {
    if (!_db) _db = require('../db/database');
    return _db;
}

// ── Config ──────────────────────────────────────────────────
const YTDLP_PATH = process.env.YTDLP_PATH || '/usr/local/bin/yt-dlp';
const CACHE_DIR = path.resolve('./data/media/cache');
const COOKIES_PATH = path.resolve('./data/media/cookies.txt');
const NODE_CANDIDATES = [
    process.env.YTDLP_NODE_PATH,
    '/usr/local/bin/node',
    '/opt/nvm/versions/node/v20.20.1/bin/node',
    '/home/ubuntu/.nvm/versions/node/v20.20.1/bin/node',
];
const MAX_CACHE_SIZE_MB = 2048;
const CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours
const URL_CACHE_TTL_MS = 3 * 60 * 60 * 1000;  // 3 hours for extracted stream URLs
const INFO_TIMEOUT_MS = 20000;
const EXTRACT_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // 10 min for file download

// In-memory URL cache: canonicalUrl → { streamUrl, expiresAt, info }
const urlCache = new Map();

// Ensure cache dir exists
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

/**
 * Check if yt-dlp is available
 */
function isAvailable() {
    try {
        return fs.existsSync(YTDLP_PATH);
    } catch {
        return false;
    }
}

/**
 * Get yt-dlp version string (cached for 60s).
 */
let _versionCache = { value: null, expiresAt: 0 };
function getVersion() {
    if (_versionCache.value && Date.now() < _versionCache.expiresAt) {
        return Promise.resolve(_versionCache.value);
    }
    return new Promise((resolve) => {
        execFile(YTDLP_PATH, ['--version'], { timeout: 5000, env: ytdlpEnv() }, (err, stdout) => {
            const ver = (stdout || '').trim() || null;
            _versionCache = { value: ver, expiresAt: Date.now() + 60000 };
            resolve(ver);
        });
    });
}

/**
 * Check if the bgutil POT provider plugin is loaded by yt-dlp.
 */
function checkPotProvider() {
    return new Promise((resolve) => {
        execFile(YTDLP_PATH, [
            ...commonArgs(),
            '-v', '--skip-download', '--extractor-args', 'youtube:player_client=web;fetch_pot=auto',
            '--print', '%(id)s', 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
        ], { timeout: 10000, env: ytdlpEnv(), maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            const log = (stderr || '') + (stdout || '');
            const providers = [];
            const providerMatch = log.match(/\[pot\] PO Token Providers: (.+)/);
            if (providerMatch) {
                // Split on ", " only when followed by a provider name (not inside parentheses)
                providers.push(...providerMatch[1].split(/,\s+(?=[a-z])/).map(s => s.trim()));
            }
            const hasExternal = providers.some(p => p.includes('external') && !p.includes('unavailable'));
            resolve({ providers, hasExternal });
        });
    });
}

function getCookiesPath() { return COOKIES_PATH; }
function getYtdlpPath() { return YTDLP_PATH; }

function getNodePath() {
    for (const candidate of NODE_CANDIDATES) {
        if (!candidate) continue;
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch {}
    }
    return null;
}

function commonArgs() {
    const args = ['--ignore-config'];
    const nodePath = getNodePath();
    if (nodePath) {
        args.push('--js-runtimes', `node:${nodePath}`, '--remote-components', 'ejs:github');
    }
    return args;
}

function ytdlpEnv() {
    const env = { ...process.env };
    const nodePath = getNodePath();
    if (nodePath) {
        const nodeDir = path.dirname(nodePath);
        env.PATH = env.PATH ? `${nodeDir}:${env.PATH}` : nodeDir;
    }
    return env;
}

/**
 * Build common yt-dlp args including cookies if configured.
 */
function cookieArgs() {
    try {
        if (fs.existsSync(COOKIES_PATH) && fs.statSync(COOKIES_PATH).size > 0) {
            return ['--cookies', COOKIES_PATH];
        }
    } catch {}
    return [];
}

/**
 * Return admin-configured extra yt-dlp arguments from the DB.
 * Each non-empty, non-comment line is treated as a separate argument.
 */
function extraArgs() {
    try {
        const raw = getDb().getSetting('ytdlp_extra_args');
        if (!raw || typeof raw !== 'string') return [];
        return raw.split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));
    } catch {
        return [];
    }
}

/**
 * Get video info (metadata only, no download).
 * Returns: { title, duration, thumbnail, url, id, isLive, uploadDate }
 */
function safeParseUrl(raw) {
    try {
        return new URL(String(raw || '').trim());
    } catch {
        return null;
    }
}

function isHlsManifestUrl(rawUrl) {
    const value = String(rawUrl || '').trim();
    return !!value && (
        /\.m3u8(?:$|[?#])/i.test(value) ||
        /\/api\/manifest\/(?:hls|dash)_playlist\//i.test(value) ||
        /[?&]mime=application%2Fvnd\.apple\.mpegurl/i.test(value)
    );
}

function normalizeUploadDate(raw) {
    const value = String(raw || '').trim();
    if (/^\d{8}$/.test(value)) {
        const y = value.slice(0, 4);
        const m = value.slice(4, 6);
        const d = value.slice(6, 8);
        return `${y}-${m}-${d}`;
    }
    return value;
}

function parseStructuredInfo(stdout, fallbackUrl) {
    const text = String(stdout || '').trim();
    if (!text || /^(null|undefined)$/i.test(text)) return null;

    const candidates = [text, text.split('\n').filter(Boolean).pop() || ''];
    for (const candidate of candidates) {
        if (!candidate || candidate[0] !== '{') continue;
        try {
            const info = JSON.parse(candidate);
            return {
                title: info.title || 'Unknown',
                duration: Number.isFinite(info.duration) ? info.duration : 0,
                thumbnail: info.thumbnail || '',
                url: info.webpage_url || info.original_url || fallbackUrl,
                id: info.id || '',
                extractor: info.extractor_key || info.extractor || 'unknown',
                isLive: !!(info.is_live || info.live_status === 'is_live' || info.live_status === 'post_live'),
                uploadDate: normalizeUploadDate(info.upload_date || info.release_date || ''),
            };
        } catch {
            // try next candidate
        }
    }

    const lines = text.split(/\r?\n/);
    if (!lines.length || !lines[0]) return null;
    return {
        title: lines[0] || 'Unknown',
        duration: parseInt(lines[1], 10) || 0,
        thumbnail: lines[2] || '',
        url: lines[3] || fallbackUrl,
        id: lines[4] || '',
        extractor: lines[5] || 'unknown',
        isLive: /^(true|1|yes)$/i.test(lines[6] || ''),
        uploadDate: normalizeUploadDate(lines[7] || ''),
    };
}

function runInfoProbe(args, url) {
    return new Promise((resolve, reject) => {
        execFile(
            YTDLP_PATH,
            args,
            { timeout: INFO_TIMEOUT_MS, env: ytdlpEnv(), maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
                const parsed = parseStructuredInfo(stdout, url);
                if (parsed) return resolve(parsed);
                const msg = (stderr || err?.message || 'Unknown yt-dlp error').slice(0, 300);
                reject(new Error(`Failed to get video info: ${msg}`));
            }
        );
    });
}

async function getInfo(url) {
    const shared = [
        ...commonArgs(),
        ...cookieArgs(),
        ...extraArgs(),
        '--no-warnings',
        '--no-playlist',
        '--age-limit', '99',
        '--geo-bypass',
        '--no-check-certificates',
    ];
    const strategies = [
        [...shared, '--dump-single-json', '--skip-download', url],
        [...shared, '--dump-single-json', '--skip-download', '--extractor-args', 'youtube:player_client=web;fetch_pot=auto', url],
        [...shared, '--no-download', '--print', '%(title)s\n%(duration)s\n%(thumbnail)s\n%(webpage_url)s\n%(id)s\n%(extractor)s\n%(is_live)s\n%(upload_date)s', url],
    ];

    let lastError = null;
    for (const args of strategies) {
        try {
            return await runInfoProbe(args, url);
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('Failed to get video info');
}

/**
 * Extract a direct playable stream URL using yt-dlp.
 * Tries multiple strategies for maximum compatibility.
 * Uses cache if available.
 */
async function extractStreamUrl(url) {
    // Check cache
    const cached = urlCache.get(url);
    if (cached && Date.now() < cached.expiresAt) {
        return cached;
    }

    const cookies = cookieArgs();
    const extra = extraArgs();
    const baseArgs = [
        ...commonArgs(),
        ...cookies,
        ...extra,
        '--get-url',
        '--age-limit', '99',
        '--geo-bypass',
        '--no-check-certificates',
        '--no-playlist',
        '--no-warnings',
    ];
    const strategies = [
        // Prefer progressive MP4/direct URLs first — these are the most browser-friendly.
        [...baseArgs, '--extractor-args', 'youtube:player_client=web;fetch_pot=auto', '--format', '18/22/best[protocol=https][ext=mp4][acodec!=none][vcodec!=none]/best[protocol=https][acodec!=none][vcodec!=none]/bestaudio[protocol=https][ext=m4a]/bestaudio[protocol=https]/best', url],
        // Generic direct fallback
        [...baseArgs, '--extractor-args', 'youtube:player_client=web;fetch_pot=auto', '--format', 'best[ext=mp4]/best[ext=webm]/best', url],
        // Lowest-quality fallback if the above formats are unavailable
        [...baseArgs, '--format', 'worst[ext=mp4]/worst', url],
    ];

    let lastError = '';
    let manifestCandidate = null;
    for (const args of strategies) {
        try {
            const result = await runYtdlp(args);
            const streamUrl = result.split('\n').find(line => /^https?:\/\//i.test(line)) || '';
            if (!streamUrl) continue;

            const entry = {
                streamUrl,
                transport: isHlsManifestUrl(streamUrl) ? 'hls' : 'direct',
                expiresAt: Date.now() + URL_CACHE_TTL_MS,
            };

            if (entry.transport === 'hls') {
                manifestCandidate = manifestCandidate || entry;
                continue;
            }

            urlCache.set(url, entry);
            return entry;
        } catch (e) {
            lastError = e.message || '';
        }
    }

    if (manifestCandidate) {
        urlCache.set(url, manifestCandidate);
        return manifestCandidate;
    }

    // Surface provider-specific error messages
    const lower = lastError.toLowerCase();
    if (lower.includes('sign in') || lower.includes('not a bot') || lower.includes('bot')) {
        throw new Error('YouTube blocked direct server extraction for this video (sign-in/bot check)');
    }
    if (lower.includes('age') || lower.includes('age-restricted')) {
        throw new Error('This video is age-restricted and cannot be played directly');
    }
    if (lower.includes('unavailable') || lower.includes('private') || lower.includes('removed')) {
        throw new Error('This video is unavailable (private, removed, or region-locked)');
    }
    if (lower.includes('copyright') || lower.includes('blocked')) {
        throw new Error('This video is blocked due to copyright restrictions');
    }
    if (lower.includes('not a valid url') || lower.includes('unsupported url')) {
        throw new Error('Unsupported or invalid URL');
    }
    throw new Error(`Could not extract playable URL: ${lastError.slice(0, 150) || 'all strategies failed'}`);
}

/**
 * Download media to a local file for buffered playback.
 * Returns the file path on success.
 */
async function downloadToFile(url, maxDurationSeconds = 600) {
    const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
    const ext = 'mp4';
    const filePath = path.join(CACHE_DIR, `${hash}.${ext}`);

    // Check if already cached
    if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.size > 0 && (Date.now() - stat.mtimeMs) < CACHE_MAX_AGE_MS) {
            return { filePath, cached: true };
        }
        // Stale — remove
        try { fs.unlinkSync(filePath); } catch {}
    }

    return new Promise((resolve, reject) => {
        const args = [
            ...commonArgs(),
            ...cookieArgs(),
            ...extraArgs(),
            '--extractor-args', 'youtube:player_client=web;fetch_pot=auto',
            '--format', '18/22/best[ext=mp4][acodec!=none][vcodec!=none][filesize<200M]/best[ext=mp4][filesize<200M]/best[filesize<200M]/best',
            '--output', filePath,
            '--no-playlist',
            '--age-limit', '99',
            '--geo-bypass',
            '--no-check-certificates',
            '--no-warnings',
            '--max-filesize', '200M',
            '--retries', '3',
            '--fragment-retries', '3',
        ];

        // Limit download to the configured max duration
        if (maxDurationSeconds > 0) {
            args.push('--download-sections', `*0-${maxDurationSeconds}`);
        }

        args.push(url);

        const proc = spawn(YTDLP_PATH, args, { timeout: DOWNLOAD_TIMEOUT_MS, env: ytdlpEnv() });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString().slice(-500); });

        proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
                resolve({ filePath, cached: false });
            } else {
                reject(new Error(`Download failed (code ${code}): ${stderr.slice(0, 200)}`));
            }
        });

        proc.on('error', (err) => {
            reject(new Error(`Download process error: ${err.message}`));
        });
    });
}

/**
 * Get the local cache file path for a URL (if cached).
 */
function getCachedPath(url) {
    const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
    const filePath = path.join(CACHE_DIR, `${hash}.mp4`);
    if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.size > 0 && (Date.now() - stat.mtimeMs) < CACHE_MAX_AGE_MS) {
            return filePath;
        }
    }
    return null;
}

/**
 * Purge old cache files to stay under MAX_CACHE_SIZE_MB.
 */
function purgeCache() {
    try {
        const files = fs.readdirSync(CACHE_DIR).map(f => {
            const p = path.join(CACHE_DIR, f);
            const stat = fs.statSync(p);
            return { path: p, size: stat.size, mtime: stat.mtimeMs };
        });

        // Remove expired files
        const now = Date.now();
        for (const f of files) {
            if (now - f.mtime > CACHE_MAX_AGE_MS) {
                try { fs.unlinkSync(f.path); } catch {}
            }
        }

        // If still over size limit, remove oldest first
        const remaining = files.filter(f => fs.existsSync(f.path));
        let totalSize = remaining.reduce((s, f) => s + f.size, 0);
        const maxBytes = MAX_CACHE_SIZE_MB * 1024 * 1024;

        if (totalSize > maxBytes) {
            remaining.sort((a, b) => a.mtime - b.mtime);
            for (const f of remaining) {
                if (totalSize <= maxBytes) break;
                try { fs.unlinkSync(f.path); totalSize -= f.size; } catch {}
            }
        }
    } catch {}
}

// Purge on startup and periodically
purgeCache();
setInterval(purgeCache, 60 * 60 * 1000); // Every hour

// Clean up expired URL cache entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of urlCache) {
        if (now >= val.expiresAt) urlCache.delete(key);
    }
}, 30 * 60 * 1000);

/**
 * Run yt-dlp with given args. Returns stdout.
 */
function runYtdlp(args) {
    return new Promise((resolve, reject) => {
        execFile(YTDLP_PATH, args, { timeout: EXTRACT_TIMEOUT_MS, env: ytdlpEnv() }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message || '').slice(0, 300)));
            resolve(stdout.trim());
        });
    });
}

module.exports = {
    isAvailable,
    getVersion,
    checkPotProvider,
    getInfo,
    extractStreamUrl,
    downloadToFile,
    getCachedPath,
    purgeCache,
    getCookiesPath,
    getYtdlpPath,
    isHlsManifestUrl,
    getExtraArgs: () => {
        try { return getDb().getSetting('ytdlp_extra_args') || ''; } catch { return ''; }
    },
    CACHE_DIR,
};
