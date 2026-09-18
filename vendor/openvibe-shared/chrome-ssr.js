'use strict';
// openvibe-shared/chrome-ssr — the parts of the shared chrome that can be baked into HTML on the server.
//   footer(cfg)        the full shared footer (HTML + CSS); the browser's footer.js renders into the same element
//   noscriptNav(site)  a plain navigation bar inside <noscript>: the JavaScript navbar cannot exist without
//                      scripts, so visitors who block them (and text browsers) still get the brand and the network
const footerModule = require('./footer');

const SITES = [['Live', 'https://openvibe.live/'], ['Tools', 'https://openvibe.tools/'], ['Community', 'https://openvibe.community/'], ['Games', 'https://openvibe.games/'], ['Media', 'https://openvibe.media/'], ['Network', 'https://openvibe.network/']];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function noscriptNav({ name, home = '/', links = [] } = {}) {
    const own = links.map(l => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join('');
    const net = SITES.filter(([n]) => !String(name || '').endsWith('.' + n)).map(([n, u]) => `<a href="${u}">${n}</a>`).join('');
    return `<noscript><nav aria-label="Site" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;padding:12px 20px;border-bottom:1px solid rgba(255,255,255,.1);font:500 14px/1.4 system-ui,sans-serif"><a href="${esc(home)}" style="font-weight:700;color:inherit;text-decoration:none">${esc(name || 'OpenVibe')}</a>${own}<span style="flex:1"></span>${net}</nav></noscript>`;
}

module.exports = { footer: (cfg) => footerModule.ssr(cfg), noscriptNav };
