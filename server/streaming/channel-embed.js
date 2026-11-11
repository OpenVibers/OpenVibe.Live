'use strict';

// Snapshot of Network /api/frame nav hosts (2026-11-08), plus the wildcard host rule.
const FALLBACK_SITES = [
    'https://openvibe.live', 'https://openvibe.community', 'https://openvibe.chat', 'https://openvibe.video',
    'https://openvibe.pics', 'https://openvibe.download', 'https://openvibe.tools', 'https://openvibe.bot',
    'https://openvibe.space', 'https://openvibe.news', 'https://openvibe.tips', 'https://openvibe.vip',
    'https://openvibe.games', 'https://openvibe.blog', 'https://openvibe.coupons', 'https://openvibe.deals',
    'https://openvibe.trade', 'https://openvibe.report', 'https://openvibe.wiki', 'https://openvibe.exchange',
    'https://openvibe.actor', 'https://openvibe.network', 'https://openvibe.media', 'https://openvibe.host',
    'https://openvibe.reviews', 'https://openvibe.design', 'https://openvibe.work', 'https://openvibe.domains',
    'https://openvibe.today', 'https://openvibe.fun', 'https://open.shoes', 'https://openvibe.casino',
    'https://openvibe.tours', 'https://openvibe.meme', 'https://openvibe.vision', 'https://openvibe.cam',
    'https://openvibe.services', 'https://connect.openvibe.website', 'https://openvibe.run', 'https://openvibe.help',
    'https://openvibe.zone', 'https://openvibe.surf', 'https://openvibe.codes', 'https://openvibe.quest',
    'https://openvibe.food', 'https://openvibe.rent', 'https://openvibe.homes', 'https://openvibe.watch',
    'https://openvibe.events', 'https://openre.stream', 'https://search.openvibe.network', 'https://openvibe.email',
    'https://openvibe.link', 'https://openvibe.website',
];
let cachedSites = null;
let cachedAt = 0;
async function frameSites() {
    if (cachedSites && Date.now() - cachedAt < 5 * 60_000) return cachedSites;
    try {
        const response = await require('../net/egress').fetchText('https://openvibe.network/api/frame', { timeoutMs: 1500, maxBytes: 256 * 1024 });
        if (response.status !== 200) throw new Error('frame list unavailable');
        const body = JSON.parse(response.text);
        const values = Array.isArray(body) ? body : (body.sites || body.origins || body.frames || body.nav || []);
        const sites = values.map((v) => typeof v === 'string' ? v : v.origin || v.url || (v.host && `https://${v.host}`)).filter((v) => typeof v === 'string').map((v) => v.replace(/\/$/, '')).filter((v) => /^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(v));
        if (!sites.length) throw new Error('empty frame list');
        cachedSites = [...new Set(["'self'", ...sites, 'https://*.openvibe.website'])];
    } catch { cachedSites ||= ["'self'", ...FALLBACK_SITES, 'https://*.openvibe.website']; }
    cachedAt = Date.now();
    return cachedSites;
}
function html(origins = FALLBACK_SITES) {
    const originData = JSON.stringify(origins.filter((o) => o !== "'self'")).replace(/</g, '\\u003c');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Live channel</title><style>*{box-sizing:border-box}html,body,#video-container{margin:0;width:100%;height:100%;background:#000;color:#fff;font:14px system-ui;overflow:hidden}#video-container{position:relative;display:grid;place-items:center}#video-canvas,#video-element{position:absolute;width:100%;height:100%;inset:0;object-fit:contain}.video-placeholder{position:absolute;inset:0;z-index:1}.badge{position:absolute;top:10px;left:10px;background:#e11d48;border-radius:4px;padding:3px 7px;font-size:11px;font-weight:700;z-index:5}#offline{display:none;text-align:center;padding:24px}#offline img{width:64px;height:64px;border-radius:50%;object-fit:cover}#offline strong{display:block;margin-top:12px}#gate{display:none;position:absolute;inset:0;z-index:10;background:#111;place-content:center;text-align:center;padding:22px}#gate button{padding:10px 16px}.player-internals{display:none!important}</style></head><body><main id="video-container" class="video-container"><div class="video-placeholder" style="display:none"></div><canvas id="video-canvas" style="display:none"></canvas><video id="video-element" playsinline muted autoplay style="display:none"></video><span id="live" class="badge" hidden>LIVE</span><div id="offline"></div><section id="gate"><h2>18+ content</h2><p>You must be 18 or older to view this stream.</p><button id="continue">I'm 18+ — Continue</button></section><div class="player-internals" aria-hidden="true"><button id="btn-play-pause"></button><button id="btn-volume" class="volume"></button><input id="volume-slider" type="range" value="75"><button id="btn-fullscreen"></button><button id="btn-clip"></button></div></main><script>window.__OV_EMBED_ORIGINS=${originData};window.OVChannelEmbedForceMuted=true</script><script src="/js/stream-player.js" defer></script><script src="/js/channel-embed.js" defer></script></body></html>`;
}
async function page(req, res) {
    const username = String(req.params.username || '').replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) return res.sendStatus(404);
    const db = require('../db/database');
    const channel = await db.getChannelByUsername(username).catch(() => null) || await db.getUserByUsername(username).catch(() => null);
    if (!channel) return res.sendStatus(404);
    res.set('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline' https://esm.sh https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' blob:; connect-src 'self' wss: https://esm.sh; frame-ancestors ${(await frameSites()).join(' ')}; base-uri 'none'; form-action 'none'`);
    res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(html(await frameSites()));
}
module.exports = { page, frameSites, html, FALLBACK_SITES };
