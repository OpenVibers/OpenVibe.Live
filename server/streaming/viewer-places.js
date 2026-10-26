/**
 * Where a live stream is being watched: OpenVibe itself, RobotStreamer, and each restream platform of the stream's slot
 * (Twitch, Kick, YouTube, a custom RTMP). The channel player's count and the broadcaster's add these up, and a tap on
 * either lists them (owner, 2026-10-26: the count on a phone left out Twitch, Kick, YouTube and RobotStreamer; "tapping
 * it should show the different viewer counts across all platforms … and includes natural openvibe viewers too").
 *
 * A place whose platform gives no number (YouTube without an API key) has count null: it is listed, as live there, and
 * adds nothing to the total.
 */
'use strict';

const NAMES = { openvibe: 'OpenVibe', robotstreamer: 'RobotStreamer', twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube' };

const count = (n) => (n == null ? null : Math.max(0, Math.floor(Number(n)) || 0));

/** A destination's page for viewers, or null: http(s) only, and YouTube's channel page goes to its live stream. */
function placeUrl(platform, channelUrl) {
    let href = String(channelUrl || '').trim();
    if (!/^https?:\/\/[^\s"'<>]+$/i.test(href)) return null;
    if (platform === 'youtube' && !/\/live\/?$/.test(href) && !/[?&]v=/.test(href)) href = href.replace(/\/+$/, '') + '/live';
    return href;
}

/**
 * { total, places: [{ key, name, count, url }] }, OpenVibe first.
 *   native     the stream's own viewers on OpenVibe
 *   rs         the RobotStreamer restream when it is on: { viewer_count, robot_id }
 *   platforms  restream-manager's breakdown for the slot: [{ platform, name, count, url }]
 */
function viewerPlaces({ native = 0, rs = null, platforms = [] } = {}) {
    const places = [{ key: 'openvibe', name: NAMES.openvibe, count: count(native) || 0, url: null }];
    if (rs) {
        places.push({
            key: 'robotstreamer', name: NAMES.robotstreamer, count: count(rs.viewer_count) || 0,
            url: rs.robot_id ? `https://robotstreamer.com/robot/${encodeURIComponent(rs.robot_id)}` : null,
        });
    }
    for (const p of platforms || []) {
        const key = NAMES[p.platform] && p.platform !== 'openvibe' && p.platform !== 'robotstreamer' ? p.platform : 'custom';
        places.push({ key, name: NAMES[key] || String(p.name || 'Restream').slice(0, 40), count: count(p.count), url: p.url || null });
    }
    return { total: places.reduce((n, p) => n + (p.count || 0), 0), places };
}

module.exports = { viewerPlaces, placeUrl };
