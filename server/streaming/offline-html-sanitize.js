'use strict';
/**
 * Sanitizer for a streamer's custom offline-screen HTML/CSS (channels.offline_html/offline_css).
 *
 * The requirement is "basic markup, no JS": no <script>, no event-handler attributes, no
 * embeds/frames/forms that could run script or phish a viewer, and no javascript:/data: URLs.
 * This is applied both on write (server/streaming/routes.js, the PATCH that saves it) and on
 * read (the public GET /channel/:username, so any row saved before this sanitizer existed is
 * cleaned before it ever reaches a viewer — no backfill migration needed).
 *
 * Third-party <img src> values are rewritten through /api/img-proxy so a viewer's browser never
 * makes a direct request to a host the streamer chose (IP/UA leak — see external-image-proxy.js).
 * First-party OpenVibe hosts are left alone.
 */
const sanitizeHtml = require('sanitize-html');

const FIRST_PARTY_HOSTS = /(^|\.)openvibe\.(live|network|media|tools|games|community|sites)$|(^|\.)openre\.stream$/i;

function proxiedImageSrc(raw) {
    if (!raw) return null;
    let abs;
    try { abs = new URL(raw, 'https://openvibe.live'); } catch { return null; } // unparsable → drop
    // transformTags runs on the raw attribute value before sanitize-html's own scheme allowlist
    // is applied, so a non-http(s) src (data:, blob:, javascript: with a leading space/tab that
    // evades the scheme check, etc.) must be rejected here too — never hand it to the proxy URL.
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
    if (FIRST_PARTY_HOSTS.test(abs.hostname)) return abs.href;
    return `/api/img-proxy?url=${encodeURIComponent(abs.href)}`;
}

const HTML_OPTIONS = {
    allowedTags: [
        'p', 'br', 'hr', 'div', 'span', 'b', 'i', 'strong', 'em', 'u', 's', 'small', 'sub', 'sup',
        'blockquote', 'code', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'figure', 'figcaption',
    ],
    allowedAttributes: {
        '*': ['class', 'id', 'title', 'style'],
        a: ['href', 'target', 'rel'],
        img: ['src', 'alt', 'width', 'height', 'loading', 'referrerpolicy'],
        td: ['colspan', 'rowspan'],
        th: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    // Never let the streamer point a link/image at something that resolves in-process
    // (data:/javascript:/vbscript: URLs, credentials in the URL) — belt-and-suspenders on top
    // of the scheme allowlist above.
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'svg'],
    // Any link opens in a new, non-opener tab — a streamer's page never navigates the viewer's
    // existing tab away from OpenVibe.
    transformTags: {
        a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow ugc' } }),
        img: (tagName, attribs) => {
            const src = proxiedImageSrc(attribs.src);
            if (!src) return { tagName: 'span', attribs: {}, text: '' }; // unparsable src → drop the element
            return { tagName, attribs: { ...attribs, src, loading: 'lazy', referrerpolicy: 'no-referrer' } };
        },
    },
    // Inline `style` is plain CSS, not script — no browser executes CSS. The one legacy vector
    // (IE `expression()` / `-moz-binding`) is dead in every current engine, so no CSS filtering
    // is needed here beyond what the tag/attribute allowlist above already does.
};

function sanitizeOfflineHtml(html) {
    const s = String(html || '');
    if (!s.trim()) return '';
    return sanitizeHtml(s, HTML_OPTIONS);
}

// offline_css is interpolated verbatim into `<style>${css}</style>` inside the iframe's srcdoc
// (app-channel.js) — a plain string template, not a real DOM API, so it is an HTML *document*
// context, not just a CSS context. A value containing "</style><script>…" would close the style
// element early and open a real (if currently sandbox-inert) <script> element; a "<base href=…>"
// could hijack how the proxied, origin-relative img-proxy URLs resolve. CSS never legitimately
// needs a literal "<" or ">", so both are escaped — this can't break any valid stylesheet.
function sanitizeOfflineCss(css) {
    const s = String(css || '');
    if (!s.trim()) return '';
    return s
        .replace(/@import[^;]*;?/gi, '')
        .replace(/expression\s*\(/gi, 'blocked(')
        .replace(/-moz-binding\s*:/gi, 'blocked:')
        .replace(/behavior\s*:/gi, 'blocked:')
        .replace(/</g, '\\3C ')
        .replace(/>/g, '\\3E ');
}

module.exports = { sanitizeOfflineHtml, sanitizeOfflineCss };
