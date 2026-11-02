'use strict';
/**
 * Live's guides in OpenVibe.Search (Contracts 0.278.0: live.index_document type `doc`): one document per Markdown file in
 * ./docs that /docs/<name> serves (server/docs/routes.js), published through Live's transactional outbox like the
 * channels (./search-documents.js). The headline guide, go-live-in-your-browser, and the rest were on no network search.
 *
 *   documentFor(name, markdown)  the document: the guide's first heading as its title, its first paragraph as the
 *                                summary, its text (no markup, no code blocks) as the body
 *   publishAll()                 every guide whose document changed since this process last sent it
 *
 * The revision is the send time in seconds, so it only grows across restarts; a restart sends each guide once more,
 * unchanged documents after that are not sent. The docs index (README) is the /docs page itself and is left out.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const streamEvents = require('./stream-events');

const PUBLIC_BASE = (process.env.LIVE_PUBLIC_ORIGIN || 'https://openvibe.live').replace(/\/+$/, '');
const DOCS_DIR = process.env.OV_APP_ROOT ? path.join(process.env.OV_APP_ROOT, 'docs') : path.join(__dirname, '../../docs');
const NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;
// Operator notes and retired pages stay on the site but off network search: how Live is deployed, a performance log,
// the retired Arena, the brand sheet for restream overlays, and the pre-split VOD pipeline (it opens on an env var).
const NOT_A_GUIDE = new Set(['deploy', 'performance-audit', 'arena', 'restream-branding', 'vods-and-clips']);
const sent = new Map();   // name → hash of the document last sent by this process
const stats = { sent: 0, unchanged: 0, lastError: null };

/** Markdown to plain text: no code blocks, no markup, links as their words, one space between words. */
function plain(markdown) {
    return String(markdown || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+\.\s+/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/^\s*\|?\s*:?-{3,}.*$/gm, ' ')
        .replace(/\|/g, ' ')
        .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, '$2')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** A summary that ends on a sentence when it can (the same rule the /docs pages use for their description). */
function summaryOf(text, max = 300) {
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    return end >= 80 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/** The Search document for one guide, or null when it has no title. */
function documentFor(name, markdown) {
    if (!NAME_RE.test(name)) return null;
    const md = String(markdown || '').replace(/\r\n/g, '\n');
    const heading = /^#\s+(.+)$/m.exec(md);
    if (!heading) return null;
    const title = plain(heading[1]).slice(0, 200);
    const afterTitle = md.slice(heading.index + heading[0].length);
    // The first paragraph that is prose: not a heading, list, table, quote, code fence or badge line.
    const first = afterTitle.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(#|[-*+]\s|\d+\.\s|\||>|```|!\[|<)/.test(p)) || '';
    const summary = summaryOf(plain(first));
    const body = plain(afterTitle).slice(0, 8000);
    return {
        owner: 'live', type: 'doc', id: name, deleted: false, visibility: 'public',
        canonical_url: `${PUBLIC_BASE}/docs/${name}`,
        title,
        summary: summary || `${title}: a guide to OpenVibe.Live.`,
        // The summary is read with the body, so the body leaves out what the summary already says.
        body: summary && body.startsWith(summary.replace(/…$/, '')) ? body.slice(summary.replace(/…$/, '').length).trim() : body,
        facets: { kind: 'guide' },
        authorship: 'human', publication_state: 'published',
        indexability: { decision: 'index' },
    };
}

const hashOf = (doc) => crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 32);

/** The guides on disk: [{ name, markdown }]. */
function guides(dir = DOCS_DIR) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return []; }
    return files.filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => f.slice(0, -3)).filter((n) => NAME_RE.test(n) && !NOT_A_GUIDE.has(n)).sort()
        .map((name) => ({ name, markdown: fs.readFileSync(path.join(dir, `${name}.md`), 'utf8') }));
}

/** Send every guide whose document changed since this process last sent it. → how many were sent */
async function publishAll({ now = Date.now(), dir = DOCS_DIR } = {}) {
    if (!streamEvents.status().enabled) return 0;
    let count = 0;
    let revision = Math.floor(now / 1000);
    for (const { name, markdown } of guides(dir)) {
        try {
            const doc = documentFor(name, markdown);
            if (!doc) continue;
            const hash = hashOf(doc);
            if (sent.get(name) === hash) { stats.unchanged++; continue; }
            revision += 1;   // one more each, so two guides sent in the same second never share one
            // The outbox takes events inside a transaction (as the channels' documents do).
            await db.getDb().tx(async () => {
                await streamEvents.enqueue({
                    event_type: 'live.index_document.upserted', actor: { type: 'service', id: 'live' }, subject: { type: 'doc', id: name, revision },
                    visibility: 'internal', priority: 'low', payload: { ...doc, revision, updated_at: new Date(now).toISOString() },
                });
            });
            sent.set(name, hash);
            stats.sent++;
            count++;
        } catch (err) { stats.lastError = err.message; }
    }
    if (count) streamEvents.kick();
    return count;
}

function status() { return { ...stats }; }

module.exports = { documentFor, publishAll, guides, plain, status };
