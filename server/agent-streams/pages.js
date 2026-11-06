'use strict';
/**
 * /embed/agent/<ags_id> — the agent stream as a frame for the task page and the Dock (Agent Streams S1).
 *
 * A standalone page, not the SPA: a third-party iframe has no Live cookies and must not load the shell or chat. It is
 * the player, the "AI agent" label, the curtain state and the viewer count (the design's embed; no chat in S1).
 *
 * Who may frame it: the first-party origins only. That is the page's own CSP `frame-ancestors`, and the reason it is a
 * short allow-list rather than `*` — a private agent stream is a person's screen.
 *
 * The ticket travels in the URL (`?vt=wvt_…`), minted by Codes, Actor or the desk with the person's own token, because
 * an iframe on someone else's page has no session with us. Anyone without a valid ticket is answered by the API with
 * 404, and the socket refuses the join as well.
 */
const SERVICE_SITES = [
    'https://openvibe.live',
    'https://openvibe.network',
    'https://openvibe.codes',
    'https://openvibe.actor',
    'https://node.openvibe.network',
    'https://openvibe.tools',
];

/** The CSP frame-ancestors list: first-party origins, plus a deployment's extra ones from the environment. */
function frameAncestors() {
    const extra = String(process.env.AGENT_EMBED_FRAME_ANCESTORS || '').split(/[\s,]+/).filter(Boolean);
    return ["'self'", ...SERVICE_SITES, ...extra].join(' ');
}

function embedCsp() {
    return [
        "default-src 'none'",
        "script-src 'self' 'unsafe-inline' https://esm.sh",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "connect-src 'self' wss: https://esm.sh",
        "font-src 'self' data:",
        `frame-ancestors ${frameAncestors()}`,
        'base-uri none',
        'form-action none',
    ].join('; ');
}

function html(publicId) {
    const id = String(publicId || '').replace(/[^A-Za-z0-9_]/g, '');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>AI agent stream</title>
<link rel="stylesheet" href="/css/features/agent-stream.css">
</head>
<body class="agent-embed" data-agent-id="${id}">
    <div class="agent-embed-frame">
        <div class="agent-embed-stage" id="agent-embed-stage">
            <div class="agent-embed-media" id="agent-embed-media">
                <video id="agent-embed-video" playsinline muted autoplay></video>
                <img id="agent-embed-still" alt="" hidden>
                <span class="agent-label agent-embed-label">AI agent</span>
                <span class="agent-embed-title" id="agent-embed-title"></span>
                <span class="agent-embed-viewers" id="agent-embed-viewers" hidden></span>
                <div class="agent-embed-state" id="agent-embed-state">Connecting…</div>
                <div class="agent-embed-curtain" id="agent-embed-curtain" hidden>Private screen</div>
                <div id="agent-embed-overlay"></div>
            </div>
        </div>
    </div>
    <script src="/js/agent-player.js" defer></script>
    <script src="/js/agent-overlay.js" defer></script>
    <script src="/js/agent-embed.js" defer></script>
</body>
</html>`;
}

/** GET /embed/agent/:id */
async function embed(req, res) {
    const id = String(req.params.id || '');
    if (!/^ags_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return res.status(404).type('text/plain').send('No such agent stream');
    // The page itself says nothing about the stream; it 404s for an id that names nothing, and a private stream's
    // script shows "private or gone" (the API, not this page, is the judge of who may watch).
    const row = await require('./service').getByPublicId(id).catch(() => null);
    if (!row) return res.status(404).type('text/plain').send('No such agent stream');
    res.set('Content-Security-Policy', embedCsp());
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    res.type('html').send(html(id));
}

module.exports = { embed, embedCsp, frameAncestors, SERVICE_SITES };
