'use strict';
/**
 * The tag vocabulary a viewer can filter by.
 *
 * A stream's tags are its streamer's own (`streams.tags`) plus the AI's (`streams.ai_tags`, set by
 * db.setStreamAiCategory), both JSON text. They are normalized the way cleanTags() writes a tag
 * (whitespace collapsed, trimmed, lowercased), then words that describe the medium rather than the
 * stream are dropped: a "live", "chat" or "obs" chip says nothing about what is on screen.
 *
 * GET /api/streams (the ?tag= filter) and GET /api/streams/tags both read streams through this module.
 */

// A tag a viewer can send back as ?tag=: 1–32 letters, digits, spaces or dashes, lowercased.
const TAG_FILTER_RE = /^[\p{L}\p{N} -]{1,32}$/u;

// Exported so the UI and tests can see exactly what is hidden; every value is already normalized.
const TAG_STOP_WORDS = new Set([
    // The medium, not the stream.
    'live', 'live stream', 'live-stream', 'livestream', 'livestreaming',
    'live streaming', 'live-streaming', 'stream', 'streaming', 'streamer',
    // The set, not the content.
    'chat', 'livechat', 'live chat', 'live-chat', 'overlay', 'ui', 'setup',
    'stream setup', 'streaming setup', 'lobby', 'gameplay', 'commentary', 'surveillance',
    // The rig.
    'webcam', 'web cam', 'camera', 'facecam', 'face cam', 'multicam',
    'multi cam', 'multi-cam', 'screen', 'screen share', 'screenshare',
    'desktop', 'browser', 'obs', 'obs studio',
]);

/** Normalize one stored tag like cleanTags() does; '' when it is not a usable tag or is a stop word. */
function normalizeTag(value) {
    if (typeof value !== 'string') return '';
    const tag = value.replace(/\s+/g, ' ').trim().toLowerCase();
    return tag && !TAG_STOP_WORDS.has(tag) ? tag : '';
}

/** A JSON-text tag column as unique normalized tags (a malformed value is no tags). */
function parseTagColumn(value) {
    let parsed;
    try { parsed = JSON.parse(value || '[]'); } catch { return []; }
    if (!Array.isArray(parsed)) return [];
    const tags = [];
    const seen = new Set();
    for (const item of parsed) {
        const tag = normalizeTag(item);
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        tags.push(tag);
    }
    return tags;
}

/**
 * One stream row's filterable tags and where each came from: Map<tag, 'streamer' | 'ai' | 'both'>.
 * Both columns are already on the row, so provenance costs nothing and /api/streams/tags can show it.
 */
function streamTagSources(row) {
    const sources = new Map();
    for (const tag of parseTagColumn(row.tags)) sources.set(tag, 'streamer');
    for (const tag of parseTagColumn(row.ai_tags)) {
        sources.set(tag, sources.has(tag) ? 'both' : 'ai');
    }
    return sources;
}

module.exports = { TAG_FILTER_RE, TAG_STOP_WORDS, normalizeTag, parseTagColumn, streamTagSources };
