const db = require('../db/database');
const downloader = require('./media-downloader');
const https = require('https');
const http = require('http');

const DEFAULTS = {
    enabled: 1,
    request_cost: 25,
    max_per_user: 3,
    max_duration_seconds: 600,
    allow_youtube: 1,
    allow_vimeo: 1,
    allow_direct_media: 1,
    auto_advance: 1,
    cost_mode: 'flat',
    cost_per_minute: 5,
    // What a request costs, and in what. Flat vs per-minute already existed, but the
    // charge was hardwired to OpenCoins, so a streamer had no way to run requests free
    // or price them in anything else.
    //   free      — no charge
    //   opencoins — network-wide wallet (default; previous behaviour)
    //   vibes     — paid currency, credited to the streamer as a donation
    //   points    — this channel's own points
    currency: 'opencoins',
    allow_live: 0,
    download_mode: 'stream',  // 'stream' = extract URL, 'download' = download file to disk
};

const DIRECT_AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac)(\?.*)?$/i;
const DIRECT_VIDEO_EXT = /\.(mp4|webm|ogv|mov|m4v)(\?.*)?$/i;

// Active extraction/download jobs: requestId → { cancel, promise }
const activeJobs = new Map();

/**
 * Fetch YouTube video title via oEmbed API (no auth/cookies required).
 * Returns { title } or null on failure.
 */
function fetchYouTubeOEmbed(videoId) {
    return new Promise((resolve) => {
        const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`;
        const req = https.get(url, { timeout: 6000 }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return resolve(null); }
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({ title: json.title || null });
                } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

class MediaQueue {
    getSettings(streamerId) {
        return { ...DEFAULTS, ...(db.upsertMediaRequestSettings(streamerId, {}) || {}) };
    }

    updateSettings(streamerId, fields) {
        return { ...DEFAULTS, ...(db.upsertMediaRequestSettings(streamerId, fields) || {}) };
    }

    /**
     * Calculate cost based on settings. Supports flat and per-minute modes.
     */
    calculateCost(settings, durationSeconds) {
        if (settings.cost_mode === 'per_minute' && Number.isFinite(durationSeconds) && durationSeconds > 0) {
            const minutes = Math.ceil(durationSeconds / 60);
            const perMin = Math.max(1, Number(settings.cost_per_minute) || DEFAULTS.cost_per_minute);
            return Math.max(1, minutes * perMin);
        }
        return Math.max(1, Number(settings.request_cost) || DEFAULTS.request_cost);
    }

    /** Normalised currency for a channel; defaults to OpenCoins as before. */
    currencyOf(settings) {
        const c = String((settings && settings.currency) || DEFAULTS.currency).toLowerCase();
        return ['free', 'vibes', 'opencoins', 'points'].includes(c) ? c : 'opencoins';
    }

    /** Human label for a currency, used in quotes and error messages. */
    currencyLabel(currency) {
        switch (currency) {
            case 'free': return 'free';
            case 'vibes': return 'Vibes';
            case 'points': return 'channel points';
            default: return 'OpenCoins';
        }
    }

    /**
     * Take `cost` from the viewer in the channel's currency. Throws a message intended to
     * be shown to the viewer verbatim. The viewer was quoted this exact figure by /quote
     * before submitting, so what they agreed to is what gets taken.
     */
    async charge({ currency, cost, userId, streamerId, streamId, label }) {
        if (currency === 'points') {
            if (!db.deductChannelPoints(userId, streamerId, cost)) {
                const have = db.getChannelPoints(userId, streamerId);
                throw new Error(`Not enough channel points — this costs ${cost}, you have ${have}.`);
            }
            return;
        }
        if (currency === 'vibes') {
            // Vibes have no generic spend: paying a streamer for a request IS a donation
            // to them, so it goes through the same path and shows up in their totals.
            try {
                require('../monetization/vibes').donate(userId, streamerId, streamId || null, cost, label);
            } catch (e) {
                throw new Error(/insufficient/i.test(e?.message || '')
                    ? `Not enough Vibes — this costs ${cost}.`
                    : (e?.message || `Could not charge ${cost} Vibes.`));
            }
            return;
        }
        // opencoins — network wallet
        try {
            const wallet = require('../monetization/wallet-client');
            const debited = await wallet.debit(
                userId, cost, label,
                `live:media_req:${streamerId}:${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
            );
            if (!debited) throw new Error('OpenCoins wallet unavailable — link your OpenVibe.Network account first.');
        } catch (e) {
            if (e && e.status === 409) throw new Error(`Not enough OpenCoins — this costs ${cost}.`);
            throw e;
        }
    }

    /**
     * Add a media request to the queue.
     * Uses yt-dlp for metadata (title, duration, thumbnail) when available.
     * Enforces duration limits and per-minute pricing.
     */
    async addRequest({ streamerId, streamId, userId, username, input }) {
        const settings = this.getSettings(streamerId);
        if (!settings.enabled) throw new Error('Media requests are disabled for this channel');

        const trimmed = String(input || '').trim();
        if (!trimmed) throw new Error('Usage: !sr <media url>');

        const normalized = await this.normalizeInput(trimmed, settings);

        // Enforce duration limit
        const maxDuration = Number(settings.max_duration_seconds) || DEFAULTS.max_duration_seconds;
        if (Number.isFinite(normalized.duration_seconds) && normalized.duration_seconds > 0) {
            if (normalized.duration_seconds > maxDuration) {
                const maxMin = Math.floor(maxDuration / 60);
                const vidMin = Math.floor(normalized.duration_seconds / 60);
                const vidSec = normalized.duration_seconds % 60;
                throw new Error(`Too long (${vidMin}m${vidSec}s). Max allowed: ${maxMin}m.`);
            }
        }

        // Live stream check
        if (normalized.isLive && !settings.allow_live) {
            throw new Error('Live stream requests are disabled for this channel');
        }

        const pendingCount = db.countPendingMediaRequestsForUser(streamerId, userId);
        if (pendingCount >= Number(settings.max_per_user || DEFAULTS.max_per_user)) {
            throw new Error(`You already have ${pendingCount} active request(s) in queue`);
        }

        const duplicate = db.findActiveMediaRequestByCanonicalUrl(streamerId, normalized.canonical_url);
        if (duplicate) throw new Error('That media is already in the queue');

        // Price it, then charge in whichever currency this channel is configured for.
        const currency = this.currencyOf(settings);
        // A free channel stores cost 0, so the queue does not display a price nobody paid.
        const cost = currency === 'free' ? 0 : this.calculateCost(settings, normalized.duration_seconds);
        if (cost > 0) {
            await this.charge({
                currency, cost, userId, streamerId, streamId,
                label: `Media request: ${normalized.title || trimmed}`,
            });
        }

        const queuePosition = db.getMediaRequestMaxQueuePosition(streamerId) + 1;
        const result = db.createMediaRequest({
            streamer_id: streamerId,
            stream_id: streamId,
            user_id: userId,
            username,
            input: trimmed,
            canonical_url: normalized.canonical_url,
            embed_url: normalized.embed_url,
            provider: normalized.provider,
            title: normalized.title,
            thumbnail_url: normalized.thumbnail_url,
            duration_seconds: normalized.duration_seconds,
            cost,
            currency,
            queue_position: queuePosition,
        });

        // The coin ledger tracks OpenCoins only — booking a Vibes or channel-points charge
        // here would show up as a phantom coin spend in the viewer's history.
        if (cost > 0 && currency === 'opencoins') {
            db.createCoinTransaction({
                user_id: userId,
                stream_id: streamId,
                amount: -cost,
                type: 'redeem',
                message: `Media request: ${normalized.title}`,
            });
        }

        const request = db.getMediaRequestById(result.lastInsertRowid);
        this.broadcastQueueUpdate(streamerId);

        // Kick off background stream URL extraction for the new request
        this.extractStreamUrlForRequest(request.id).catch(() => {});

        return request;
    }

    /**
     * Extract a direct stream URL for a pending/playing request (background).
     * Updates the DB row when done.
     */
    async extractStreamUrlForRequest(requestId) {
        const request = db.getMediaRequestById(requestId);
        if (!request) return null;
        if (request.stream_url && request.download_status === 'ready') return request;
        const settings = this.getSettings(request.streamer_id);
        if (request.provider === 'audio' || request.provider === 'video') {
            // Direct media — the canonical_url IS the stream URL
            db.updateMediaRequest(requestId, {
                stream_url: request.canonical_url,
                download_status: 'ready',
            });
            return db.getMediaRequestById(requestId);
        }

        if (!downloader.isAvailable()) {
            db.updateMediaRequest(requestId, {
                stream_url: null,
                download_status: 'failed',
                last_error: 'yt-dlp is not available on the server',
            });
            return db.getMediaRequestById(requestId);
        }

        const forceServerDownload = settings.download_mode === 'download';

        if (forceServerDownload) {
            return this.downloadFileForRequest(requestId);
        }

        try {
            db.updateMediaRequest(requestId, { download_status: 'extracting' });
            this.broadcastQueueUpdate(request.streamer_id);

            const extracted = await downloader.extractStreamUrl(request.canonical_url);
            const resolvedUrl = extracted?.streamUrl || null;
            db.updateMediaRequest(requestId, {
                stream_url: resolvedUrl,
                embed_url: null,
                download_status: resolvedUrl ? 'ready' : 'failed',
                last_error: null,
            });
            this.broadcastQueueUpdate(request.streamer_id);
            return db.getMediaRequestById(requestId);
        } catch (err) {
            console.warn(`[MediaQueue] Stream URL extraction failed for request ${requestId}:`, err.message);
            try {
                return await this.downloadFileForRequest(requestId);
            } catch (downloadErr) {
                db.updateMediaRequest(requestId, {
                    stream_url: null,
                    embed_url: null,
                    download_status: 'failed',
                    last_error: `Extraction failed: ${err.message}. Download fallback failed: ${downloadErr.message}`,
                });
                this.broadcastQueueUpdate(request.streamer_id);
                return db.getMediaRequestById(requestId);
            }
        }
    }

    /**
     * Download media file to disk for a request (when stream mode won't work).
     */
    async downloadFileForRequest(requestId) {
        const request = db.getMediaRequestById(requestId);
        if (!request) return null;
        if (request.file_path && request.download_status === 'ready') return request;
        if (!downloader.isAvailable()) throw new Error('Download not available');

        try {
            db.updateMediaRequest(requestId, { download_status: 'downloading' });
            this.broadcastQueueUpdate(request.streamer_id);

            const maxDuration = Number(request.duration_seconds) || 600;
            const { filePath } = await downloader.downloadToFile(request.canonical_url, maxDuration);
            const servePath = `/media/cache/${require('path').basename(filePath)}`;

            db.updateMediaRequest(requestId, {
                file_path: servePath,
                stream_url: servePath,
                download_status: 'ready',
            });
            this.broadcastQueueUpdate(request.streamer_id);
            return db.getMediaRequestById(requestId);
        } catch (err) {
            console.warn(`[MediaQueue] Download failed for request ${requestId}:`, err.message);
            db.updateMediaRequest(requestId, {
                download_status: 'failed',
                last_error: `Download failed: ${err.message}`,
            });
            this.broadcastQueueUpdate(request.streamer_id);
            throw err;
        }
    }

    startNext(streamerId) {
        const active = db.getActiveMediaRequestByStreamer(streamerId);
        if (active) return active;

        const next = db.getNextPendingMediaRequest(streamerId);
        if (!next) return null;

        db.updateMediaRequest(next.id, {
            status: 'playing',
            started_at: new Date().toISOString(),
        });
        db.renormalizePendingMediaRequestPositions(streamerId);

        const request = db.getMediaRequestById(next.id);

        // Ensure stream URL is extracted before playing
        if (!request.stream_url || request.download_status !== 'ready') {
            this.extractStreamUrlForRequest(request.id).catch(() => {});
        }

        // Pre-extract next-in-queue for seamless advance
        const nextUp = db.getNextPendingMediaRequest(streamerId);
        if (nextUp) this.extractStreamUrlForRequest(nextUp.id).catch(() => {});

        this.broadcastQueueUpdate(streamerId);
        this.broadcastNowPlaying(streamerId, request);
        return request;
    }

    finishCurrent(streamerId, status = 'played') {
        const active = db.getActiveMediaRequestByStreamer(streamerId);
        if (!active) return null;

        db.updateMediaRequest(active.id, {
            status,
            ended_at: new Date().toISOString(),
            playback_position: 0,
        });

        const ended = db.getMediaRequestById(active.id);
        db.renormalizePendingMediaRequestPositions(streamerId);
        this.broadcastQueueUpdate(streamerId);
        return ended;
    }

    advance(streamerId) {
        this.finishCurrent(streamerId, 'played');
        return this.startNext(streamerId);
    }

    skip(streamerId, requestId) {
        const request = db.getMediaRequestByStreamerAndId(streamerId, requestId);
        if (!request) throw new Error('Request not found');

        const nextStatus = request.status === 'playing' ? 'skipped' : 'removed';
        db.updateMediaRequest(request.id, {
            status: nextStatus,
            ended_at: new Date().toISOString(),
            playback_position: 0,
        });
        db.renormalizePendingMediaRequestPositions(streamerId);
        this.broadcastQueueUpdate(streamerId);
        return db.getMediaRequestById(request.id);
    }

    /**
     * Refund coins for a failed or skipped request.
     * Returns the refunded amount, or 0 if already refunded.
     */
    refund(requestId) {
        const request = db.getMediaRequestById(requestId);
        if (!request) throw new Error('Request not found');
        if (request.refunded) return 0;

        const amount = request.cost || 0;
        const currency = this.currencyOf({ currency: request.currency });
        if (amount <= 0 || request.currency === 'free') return 0;

        // Give back what was actually taken. `currency` is the one recorded on the request
        // at charge time, not the channel's current setting.
        const label = `Refund: ${request.title || 'media request'}`;
        try {
            if (currency === 'points') {
                db.addChannelPoints(request.user_id, request.streamer_id, amount);
            } else if (currency === 'vibes') {
                // The charge was booked as a donation to the streamer, so unwind both sides.
                db.deductVibesCashout(request.streamer_id, amount);
                db.addVibes(request.user_id, amount);
            } else {
                // Idempotent per request id, so a double-refund is a no-op server-side.
                require('../monetization/wallet-client')
                    .credit(request.user_id, amount, label, `live:media_refund:${request.id}`)
                    .catch((e) => console.warn('[MediaQueue] wallet refund failed:', e.message));
            }
        } catch (e) {
            console.warn('[MediaQueue] refund failed:', e.message);
            return 0;
        }
        db.updateMediaRequest(requestId, { refunded: 1 });

        return amount;
    }

    /**
     * Mark a request as failed and auto-refund the user.
     */
    failRequest(requestId, errorMessage) {
        const request = db.getMediaRequestById(requestId);
        if (!request) return null;

        db.updateMediaRequest(requestId, {
            status: 'failed',
            ended_at: new Date().toISOString(),
            last_error: errorMessage || 'Playback failed',
        });

        // Auto-refund on failure
        this.refund(requestId);

        db.renormalizePendingMediaRequestPositions(request.streamer_id);
        this.broadcastQueueUpdate(request.streamer_id);
        return db.getMediaRequestById(requestId);
    }

    /**
     * Save playback position for the currently playing request.
     * Called periodically by the media player client.
     */
    savePlaybackPosition(requestId, positionSeconds) {
        const pos = Number(positionSeconds);
        if (!Number.isFinite(pos) || pos < 0) return;
        db.updateMediaRequest(requestId, { playback_position: pos });
    }

    /**
     * Get playback position for a request (for resume on reload/restart).
     */
    getPlaybackPosition(requestId) {
        const request = db.getMediaRequestById(requestId);
        return request?.playback_position || 0;
    }

    move(streamerId, requestId, direction) {
        const pending = db.getPendingMediaRequestsByStreamer(streamerId, 100);
        const index = pending.findIndex(item => item.id === requestId);
        if (index === -1) throw new Error('Pending request not found');

        const swapIndex = direction === 'up' ? index - 1 : index + 1;
        if (swapIndex < 0 || swapIndex >= pending.length) return pending[index];

        const current = pending[index];
        const other = pending[swapIndex];
        db.updateMediaRequest(current.id, { queue_position: other.queue_position });
        db.updateMediaRequest(other.id, { queue_position: current.queue_position });
        db.renormalizePendingMediaRequestPositions(streamerId);
        this.broadcastQueueUpdate(streamerId);
        return db.getMediaRequestById(current.id);
    }

    getState(streamerId) {
        return {
            settings: this.getSettings(streamerId),
            now_playing: db.getActiveMediaRequestByStreamer(streamerId),
            queue: db.getPendingMediaRequestsByStreamer(streamerId, 50),
            history: db.getRecentMediaRequestsByStreamer(streamerId, 20),
        };
    }

    /**
     * Normalize user input into a canonical media request.
     * Uses yt-dlp for metadata when available (title, duration, thumbnail).
     */
    async normalizeInput(rawInput, settings) {
        let url;
        try {
            url = new URL(rawInput);
        } catch {
            throw new Error('Only direct media URLs are supported right now');
        }

        const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
        const href = url.toString();

        // ── YouTube ──
        const ytId = this.extractYouTubeId(url);
        if (ytId) {
            if (!settings.allow_youtube) throw new Error('YouTube requests are disabled for this channel');
            const canonical = `https://www.youtube.com/watch?v=${ytId}`;

            // Use yt-dlp for accurate metadata (duration, title, thumbnail)
            let ytdlpError = null;
            if (downloader.isAvailable()) {
                try {
                    const info = await downloader.getInfo(canonical);
                    return {
                        canonical_url: canonical,
                        embed_url: null,
                        provider: 'youtube',
                        title: info.title || `YouTube video ${ytId}`,
                        thumbnail_url: info.thumbnail || `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`,
                        duration_seconds: info.duration || null,
                        isLive: info.isLive || false,
                    };
                } catch (err) {
                    ytdlpError = err.message;
                    console.warn(`[MediaQueue] YouTube metadata probe failed for ${canonical}:`, err.message);
                }
            }

            // Fallback: try YouTube oEmbed API for at least the title (no auth needed)
            let oembedTitle = null;
            try {
                const oembed = await fetchYouTubeOEmbed(ytId);
                if (oembed?.title) oembedTitle = oembed.title;
            } catch {}

            return {
                canonical_url: canonical,
                embed_url: null,
                provider: 'youtube',
                title: oembedTitle || `YouTube video ${ytId}`,
                thumbnail_url: `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`,
                duration_seconds: null,
                isLive: false,
                _ytdlpError: ytdlpError,  // carried for diagnostics
            };
        }

        // ── Vimeo ──
        const vimeoMatch = hostname === 'vimeo.com' || hostname === 'player.vimeo.com'
            ? url.pathname.match(/\/(?:video\/)?(\d+)/)
            : null;
        if (vimeoMatch) {
            if (!settings.allow_vimeo) throw new Error('Vimeo requests are disabled for this channel');
            const videoId = vimeoMatch[1];
            const canonical = `https://vimeo.com/${videoId}`;

            if (downloader.isAvailable()) {
                try {
                    const info = await downloader.getInfo(canonical);
                    return {
                        canonical_url: canonical,
                        embed_url: null,
                        provider: 'vimeo',
                        title: info.title || `Vimeo video ${videoId}`,
                        thumbnail_url: info.thumbnail || null,
                        duration_seconds: info.duration || null,
                        isLive: info.isLive || false,
                    };
                } catch (err) {
                    console.warn(`[MediaQueue] Vimeo metadata probe failed for ${canonical}:`, err.message);
                }
            }

            return {
                canonical_url: canonical,
                embed_url: null,
                provider: 'vimeo',
                title: `Vimeo video ${videoId}`,
                thumbnail_url: null,
                duration_seconds: null,
                isLive: false,
            };
        }

        // ── Direct audio ──
        if (DIRECT_AUDIO_EXT.test(href)) {
            if (!settings.allow_direct_media) throw new Error('Direct media requests are disabled for this channel');
            return {
                canonical_url: href,
                embed_url: null,
                provider: 'audio',
                title: this.filenameTitle(url.pathname),
                thumbnail_url: null,
                duration_seconds: null,
                isLive: false,
            };
        }

        // ── Direct video ──
        if (DIRECT_VIDEO_EXT.test(href)) {
            if (!settings.allow_direct_media) throw new Error('Direct media requests are disabled for this channel');
            return {
                canonical_url: href,
                embed_url: null,
                provider: 'video',
                title: this.filenameTitle(url.pathname),
                thumbnail_url: null,
                duration_seconds: null,
                isLive: false,
            };
        }

        // ── Generic yt-dlp support (SoundCloud, Twitch clips, etc.) ──
        if (downloader.isAvailable()) {
            try {
                const info = await downloader.getInfo(href);
                return {
                    canonical_url: info.url || href,
                    embed_url: null,
                    provider: 'video',
                    title: info.title || this.filenameTitle(url.pathname),
                    thumbnail_url: info.thumbnail || null,
                    duration_seconds: info.duration || null,
                    isLive: info.isLive || false,
                };
            } catch {
                // Not recognized by yt-dlp either
            }
        }

        throw new Error('Unsupported media URL. Supported: YouTube, Vimeo, direct audio/video files');
    }

    extractYouTubeId(url) {
        const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
        if (hostname === 'youtu.be') {
            const id = url.pathname.slice(1).split('/')[0];
            return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
        }
        if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
            if (url.pathname === '/watch') {
                const id = url.searchParams.get('v');
                return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
            }
            const match = url.pathname.match(/\/(embed|shorts)\/([A-Za-z0-9_-]{11})/);
            return match ? match[2] : null;
        }
        return null;
    }

    filenameTitle(pathname) {
        const last = decodeURIComponent((pathname || '').split('/').pop() || 'Media request');
        return last.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim() || 'Media request';
    }

    broadcastNowPlaying(streamerId, request) {
        this.broadcast(streamerId, {
            type: 'media_now_playing',
            request,
            timestamp: new Date().toISOString(),
        });
    }

    broadcastQueueUpdate(streamerId) {
        this.broadcast(streamerId, {
            type: 'media_queue_update',
            state: this.getState(streamerId),
            timestamp: new Date().toISOString(),
        });
    }

    broadcast(streamerId, payload) {
        try {
            const chatServer = require('../chat/chat-server');
            const streams = db.getLiveStreamsByUserId(streamerId) || [];
            for (const stream of streams) {
                chatServer.broadcastToStream(stream.id, payload);
            }
        } catch {
            // optional
        }
    }
}

module.exports = new MediaQueue();
