'use strict';
/**
 * Log-safe forms of secrets. Stream keys publish to someone's slot, and journald/log files are read
 * by more people and tools than the database is.
 */

/** "a1b2c3…" — enough to tell two keys apart in a log, useless to publish with. */
function maskKey(key) {
    const s = String(key == null ? '' : key);
    if (!s) return '';
    return s.length <= 6 ? '****' : `${s.slice(0, 4)}…(${s.length})`;
}

/**
 * Mask credentials inside a URL or a command line: the last path segment of rtmp(s)/srt ingest
 * URLs and of /live/<key>.flv, and passphrase/streamid/token/key query values.
 */
function redactUrl(text) {
    return String(text == null ? '' : text)
        .replace(/\b((?:rtmps?|srt):\/\/[^\s?]*\/)([^\s/?]+)/gi, (m, head, key) => head + maskKey(key))
        .replace(/(\/live\/)([^\s/?.]+)(\.flv)?/gi, (m, head, key, ext) => head + maskKey(key) + (ext || ''))
        .replace(/([?&](?:passphrase|streamid|token|key|stream_key)=)([^&\s]+)/gi, (m, head, val) => head + maskKey(val));
}

module.exports = { maskKey, redactUrl };
